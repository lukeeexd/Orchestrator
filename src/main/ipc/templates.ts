import { ipcMain } from 'electron';
import {
  IpcChannels,
  type TemplateCreateRequest,
  type TemplateUpdateRequest,
} from '../../shared/ipc';
import type { DirectorMessage, Template } from '../../shared/types';
import * as templates from '../templates';
import type { IpcContext } from './_shared';
import { validated } from './_shared';
import {
  templateCreateRequestSchema,
  templateUpdateRequestSchema,
} from './_schemas';

export function registerTemplatesHandlers(ctx: IpcContext): void {
  ipcMain.handle(IpcChannels.TemplatesList, (): Template[] =>
    templates.listTemplates(),
  );

  validated(
    IpcChannels.TemplatesCreate,
    templateCreateRequestSchema,
    (_event, input): Template => {
      // Defensive sanitisation: trim whitespace, drop rows missing the
      // bare-minimum fields. The renderer's form already guards against
      // most of this, but we don't want a hand-crafted IPC call to
      // stash a malformed template that breaks PlanCard later.
      const typed = input as TemplateCreateRequest;
      const cleanedRows = typed.rows
        .filter(
          (r) =>
            r &&
            typeof r.task === 'string' &&
            r.task.trim().length > 0 &&
            typeof r.role === 'string',
        )
        .map((r, idx) => ({ ...r, i: idx + 1, task: r.task.trim() }));
      return templates.createTemplate({
        name: typed.name.trim() || 'Untitled template',
        description: typed.description?.trim(),
        mode: typed.mode,
        tags: typed.tags
          ?.map((t) => t.trim())
          .filter((t) => t.length > 0),
        rows: cleanedRows,
      });
    },
  );

  // TemplatesUpdate takes (id, patch). The id arg is validated as a string
  // via TypeScript's parameter type; the patch is shape-validated below.
  // Mixed approach: keep ipcMain.handle for the multi-arg signature, run
  // the patch through Zod manually.
  ipcMain.handle(
    IpcChannels.TemplatesUpdate,
    (
      _event,
      id: string,
      patch: TemplateUpdateRequest,
    ): { ok: boolean; template?: Template } => {
      const parsed = templateUpdateRequestSchema.safeParse(patch);
      if (!parsed.success) {
        throw new Error(
          `IPC payload invalid (${IpcChannels.TemplatesUpdate}) — patch shape mismatch`,
        );
      }
      const cleanedPatch: TemplateUpdateRequest = { ...patch };
      if (patch.rows) {
        cleanedPatch.rows = patch.rows
          .filter(
            (r) =>
              r &&
              typeof r.task === 'string' &&
              r.task.trim().length > 0 &&
              typeof r.role === 'string',
          )
          .map((r, idx) => ({ ...r, i: idx + 1, task: r.task.trim() }));
      }
      if (patch.name !== undefined) cleanedPatch.name = patch.name.trim();
      const updated = templates.updateTemplate(id, cleanedPatch);
      return updated ? { ok: true, template: updated } : { ok: false };
    },
  );

  ipcMain.handle(
    IpcChannels.TemplatesDelete,
    (_event, id: string): { ok: boolean } => ({
      ok: templates.deleteTemplate(id),
    }),
  );

  ipcMain.handle(
    IpcChannels.TemplatesUse,
    (
      _event,
      projectId: string,
      templateId: string,
    ): { ok: boolean; message?: DirectorMessage; error?: string } => {
      const message = templates.useTemplate(projectId, templateId);
      if (!message) {
        return { ok: false, error: 'Template not found.' };
      }
      // Broadcast so the renderer's DirectorEventMessage subscriber
      // appends it to the live message list — same path a Director
      // turn would take.
      ctx.broadcast(IpcChannels.DirectorEventMessage, { projectId, message });
      return { ok: true, message };
    },
  );
}
