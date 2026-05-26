import { ipcMain } from 'electron';
import {
  IpcChannels,
  type AcceptPlanRequest,
  type AcceptPlanResponse,
} from '../../shared/ipc';
import type { DirectorMessage } from '../../shared/types';
import * as director from '../director/runner';
import {
  awaitCompletion,
  registry,
  spawnAgent,
} from '../agents/runner';
import { getProject } from '../projects';
import { readSettings } from '../settings';
import { assertWorkspaceMatchesProject } from '../security/workspace';
import { buildBranchName, ensureBranch, isGitRepo } from '../git';
import type { IpcContext } from './_shared';
import { validated } from './_shared';
import { acceptPlanRequestSchema } from './_schemas';
import type { AgentSinks } from './agents';

export function registerDirectorHandlers(
  ctx: IpcContext,
  agentSinks: AgentSinks,
): void {
  director.setSinks({
    onMessage: (projectId, message) =>
      ctx.broadcast(IpcChannels.DirectorEventMessage, { projectId, message }),
    onPatch: (projectId, id, patch) =>
      ctx.broadcast(IpcChannels.DirectorEventPatch, { projectId, id, patch }),
  });

  ipcMain.handle(
    IpcChannels.DirectorList,
    (_event, projectId: string): DirectorMessage[] =>
      director.listMessages(projectId),
  );

  ipcMain.handle(
    IpcChannels.DirectorSend,
    (
      _event,
      projectId: string,
      body: string,
      mode: import('../../shared/types').DirectorMode,
      attachments?: string[],
    ): { ok: true } => {
      director.sendFromUser(projectId, body, mode, attachments);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorAbort,
    (_event, projectId: string): { ok: true } => {
      director.abort(projectId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorWipe,
    (_event, projectId: string): { ok: true } => {
      director.wipeSession(projectId);
      ctx.broadcast(IpcChannels.DirectorEventCleared, { projectId });
      return { ok: true };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorRewind,
    (
      _event,
      projectId: string,
      messageId: string,
    ): { ok: true; truncatedCount: number } | { ok: false; error: string } => {
      // F5: rewind doesn't emit DirectorEventCleared — that would
      // briefly flash an empty chat before the refresh re-populates.
      // Instead, the renderer awaits this IPC then calls
      // listDirectorMessages to atomically replace its in-memory
      // copy.
      const result = director.rewindTo(projectId, messageId);
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'rewind failed' };
      }
      return { ok: true, truncatedCount: result.truncatedCount };
    },
  );

  ipcMain.handle(
    IpcChannels.DirectorAckRedirect,
    (
      _event,
      req: import('../../shared/ipc').DirectorAckRedirectRequest,
    ): { ok: true } => {
      director.acknowledgeRedirect(
        req.projectId,
        req.messageId,
        req.agentName,
        req.ok,
        req.error,
      );
      return { ok: true };
    },
  );

  validated(
    IpcChannels.DirectorAcceptPlan,
    acceptPlanRequestSchema,
    async (_event, payload): Promise<AcceptPlanResponse> => {
      const req = payload as AcceptPlanRequest;
      // C2: validate the plan workspace ONCE up front so every row
      // (the first synchronous spawn + the detached loop's rest)
      // uses the same pinned, validated path. Throws on mismatch.
      const validatedWorkspace = assertWorkspaceMatchesProject(
        req.projectId,
        req.workspace,
      );
      // F14: auto-branch on plan accept. Runs once per plan, before
      // any agent spawns, so the spawn's cwd already sees the new
      // branch. Skipped silently when:
      //   - the project doesn't have auto-branch on, OR
      //   - the workspace isn't a git repo (most setups are bare
      //     scratch dirs — silent skip is the right default).
      // Skipped *loudly* via a Director system message when:
      //   - planMessageId is missing (older renderer build), OR
      //   - the worktree is dirty (we refuse to switch branches
      //     when uncommitted edits would silently move with us).
      const projectForBranch = getProject(req.projectId);
      if (
        projectForBranch?.autoBranch === true &&
        isGitRepo(validatedWorkspace)
      ) {
        if (!req.planMessageId) {
          director.notifySystem(
            req.projectId,
            '⎿ auto-branch skipped — plan id missing (renderer needs a refresh).',
          );
        } else {
          const branch = buildBranchName(
            req.planMessageId,
            req.rows[0]?.task ?? '',
          );
          const result = ensureBranch(validatedWorkspace, branch);
          if (result.ok) {
            director.notifySystem(
              req.projectId,
              result.created
                ? `⎿ auto-branch · created and checked out \`${result.branch}\``
                : `⎿ auto-branch · checked out existing \`${result.branch}\``,
            );
          } else {
            director.notifySystem(
              req.projectId,
              `⎿ auto-branch skipped — ${result.reason ?? 'unknown error'}. Agents will run on the current branch.`,
            );
          }
        }
      }
      // Director auto-spawns inherit the Director's effective model +
      // effort — using the same cascade the Director itself uses
      // (per-project override → settings.defaultDirectorModel/Effort →
      // settings.defaultModel/Effort). Just reading project.directorModel
      // wasn't enough: when the user leaves the Director on the global
      // defaults, project.directorModel is null and agents fall through
      // to the cheap agent defaults — so an Opus 4.7 1M xhigh Director
      // would quietly spawn Sonnet 4.6 high workers.
      const project = getProject(req.projectId);
      const cascadeSettings = readSettings();
      const resolvedDirectorModel =
        project?.directorModel ||
        cascadeSettings.defaultDirectorModel ||
        cascadeSettings.defaultModel;
      const resolvedDirectorEffort =
        project?.directorEffort ||
        cascadeSettings.defaultDirectorEffort ||
        cascadeSettings.defaultEffort;
      const directorOverrides: {
        model?: string;
        effort?: import('../../shared/types').EffortLevel;
      } = {
        ...(resolvedDirectorModel ? { model: resolvedDirectorModel } : {}),
        ...(resolvedDirectorEffort ? { effort: resolvedDirectorEffort } : {}),
      };

      // Attachments from the user message that prompted this plan flow
      // to every agent the plan auto-spawns. Without this the Director
      // can see (and describe) a pasted screenshot but the coder/qa/etc
      // agents receive only the plan's text and never the image — so the
      // Director can say "look at the screenshot" and the worker has
      // no screenshot to look at.
      const planAttachments =
        req.attachments && req.attachments.length > 0
          ? req.attachments
          : undefined;

      const spawned: { id: string; name: string }[] = [];
      const firstId =
        req.rows.length > 0
          ? await spawnAgent(
              {
                projectId: req.projectId,
                role: req.rows[0].role,
                task: req.rows[0].task,
                workspace: validatedWorkspace,
                spawnedBy: 'director',
                ...directorOverrides,
                // Per-row provider override (mixed-provider plans).
                // Undefined → spawnAgent falls back to the project's
                // default, same behaviour as before this field existed.
                ...(req.rows[0].provider
                  ? { provider: req.rows[0].provider }
                  : {}),
                ...(planAttachments ? { attachments: planAttachments } : {}),
              },
              agentSinks,
            )
          : null;
      if (firstId) {
        const e = registry.get(firstId.agentId);
        spawned.push({
          id: firstId.agentId,
          name: e?.agent.name ?? req.rows[0].name,
        });
      }
      const reservedNames = [
        ...spawned.map((s) => s.name),
        ...req.rows.slice(1).map((r) => r.name),
      ];
      director.acknowledgePlanAccepted(
        req.projectId,
        req.rows,
        reservedNames,
      );

      void (async () => {
        for (let i = 1; i < req.rows.length; i++) {
          // H1: per-iteration try/catch + project-still-exists guard.
          // Without these, a single spawn rejection killed the whole
          // remaining plan with no user-visible signal, and a project
          // deleted mid-plan would still attempt to spawn into it.
          if (!getProject(req.projectId)) {
            director.notifySystem(
              req.projectId,
              `Plan cancelled: project no longer exists. ${
                req.rows.length - i
              } row${req.rows.length - i === 1 ? '' : 's'} not spawned.`,
            );
            return;
          }
          const prev = spawned[spawned.length - 1];
          if (prev) {
            try {
              await awaitCompletion(prev.id);
            } catch {
              /* awaitCompletion never rejects (the tracker swallows),
                 but be defensive in case that changes */
            }
          }
          const row = req.rows[i];
          try {
            const r = await spawnAgent(
              {
                projectId: req.projectId,
                role: row.role,
                task: row.task,
                workspace: validatedWorkspace,
                spawnedBy: 'director',
                ...directorOverrides,
                ...(row.provider ? { provider: row.provider } : {}),
                ...(planAttachments ? { attachments: planAttachments } : {}),
              },
              agentSinks,
            );
            const e = registry.get(r.agentId);
            spawned.push({
              id: r.agentId,
              name: e?.agent.name ?? row.name,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            director.notifySystem(
              req.projectId,
              `Plan row ${i + 1} (${row.role} — ${row.name}) failed to spawn: ${msg}. Stopping remaining ${
                req.rows.length - i - 1
              } row${req.rows.length - i - 1 === 1 ? '' : 's'}.`,
            );
            return;
          }
        }
      })();

      return { firstSpawnedAgentId: spawned[0]?.id ?? null };
    },
  );
}
