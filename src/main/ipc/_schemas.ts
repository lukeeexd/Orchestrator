import { z } from 'zod';
import { EFFORT_LEVELS } from '../../shared/efforts';

/**
 * Runtime schemas for the high-value object-payload IPC channels.
 * Lives on the main side only — the renderer is the trusted producer,
 * but the boundary is the right place to fail loud on shape drift
 * (a TS-only contract goes silent when types and runtime diverge).
 *
 * Only complex object payloads are validated here. The many
 * `(id: string, value: string)` style channels keep `ipcMain.handle`
 * directly — TypeScript narrows those at the call site already and
 * the validation overhead isn't worth it.
 */

const agentRole = z.enum([
  'pm',
  'researcher',
  'coder',
  'qa',
  'devops',
  'security',
]);

const provider = z.enum(['claude', 'codex']);

const directorMode = z.enum(['auto', 'manual']);

const effortLevel = z.enum(EFFORT_LEVELS as readonly [string, ...string[]]);

const planRow = z.object({
  i: z.number(),
  role: agentRole,
  name: z.string(),
  task: z.string(),
  provider: provider.optional(),
});

const agentBudget = z.object({
  usd: z.number(),
  tokens: z.number(),
  seconds: z.number(),
});

export const spawnAgentRequestSchema = z.object({
  projectId: z.string().min(1),
  role: agentRole,
  // P10: role flavour. Only 'playwright' is recognised today;
  // other strings (or omission) → default flavour for the role.
  subtype: z.literal('playwright').optional(),
  task: z.string().min(1),
  workspace: z.string(),
  model: z.string().optional(),
  effort: effortLevel.optional(),
  budget: agentBudget.optional(),
  spawnedBy: z.enum(['user', 'director']).optional(),
  provider: provider.optional(),
  attachments: z.array(z.string()).optional(),
});

export const redirectAgentRequestSchema = z.object({
  agentId: z.string().min(1),
  body: z.string(),
  model: z.string().optional(),
  effort: effortLevel.optional(),
  attachments: z.array(z.string()).optional(),
});

export const forkAgentRequestSchema = z.object({
  parentAgentId: z.string().min(1),
  task: z.string().min(1),
  model: z.string().optional(),
  effort: effortLevel.optional(),
  attachments: z.array(z.string()).optional(),
});

export const acceptPlanRequestSchema = z.object({
  projectId: z.string().min(1),
  rows: z.array(planRow),
  workspace: z.string(),
  attachments: z.array(z.string()).optional(),
});

export const templateCreateRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  mode: directorMode.optional(),
  tags: z.array(z.string()).optional(),
  rows: z.array(planRow),
});

export const templateUpdateRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  mode: directorMode.optional(),
  tags: z.array(z.string()).optional(),
  rows: z.array(planRow).optional(),
});

export const partialSettingsSchema = z
  .object({
    apiKey: z.string(),
    oauthToken: z.string(),
    defaultModel: z.string(),
    defaultEffort: effortLevel,
    defaultDirectorModel: z.string(),
    defaultDirectorEffort: effortLevel,
    defaultBudgetUsd: z.number(),
    defaultBudgetTokens: z.number(),
    defaultBudgetSeconds: z.number(),
    copyGlobalSubsToNewProjects: z.boolean(),
  })
  .partial();
