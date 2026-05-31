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

const directorMode = z.enum(['auto', 'manual', 'prd']);

const effortLevel = z.enum(EFFORT_LEVELS as readonly [string, ...string[]]);

const planRow = z.object({
  i: z.number(),
  role: agentRole,
  name: z.string(),
  task: z.string(),
  provider: provider.optional(),
});

// R-L7: each field is independently optional. The form sends
// `parseNum(input)` which yields `null` for empty inputs, and a user
// who fills only one of the three budget fields should get that one
// limit applied — not a generic IPC validation error. Internal
// budget code (internal.ts) treats undefined/null fields as
// "unlimited", so widening here matches runtime behaviour.
//
// Nonnegative guard: a direct-IPC bypass could otherwise pass a
// negative number, which the runtime treats as "always trip" and
// bricks spawns silently (R-L8).
const agentBudget = z.object({
  usd: z.number().nonnegative().nullable().optional(),
  tokens: z.number().nonnegative().nullable().optional(),
  seconds: z.number().nonnegative().nullable().optional(),
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
  planMessageId: z.string().optional(),
  baseBranch: z.string().optional(),
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
    // R-L8: clamp budget defaults to nonnegative. The runtime treats
    // negative as "always trip", which silently bricks every spawn.
    defaultBudgetUsd: z.number().nonnegative(),
    defaultBudgetTokens: z.number().nonnegative(),
    defaultBudgetSeconds: z.number().nonnegative(),
    // PRE-2a: run-wide spawn cap. Must be listed here or .partial() strips it
    // on save (same landmine as `theme`). Int, nonnegative; 0 = unlimited.
    maxSpawnsPerRun: z.number().int().nonnegative(),
    // N5 auto-replan cap. Same .partial() strip landmine — must be listed.
    maxReplansPerRun: z.number().int().nonnegative(),
    copyGlobalSubsToNewProjects: z.boolean(),
    // Without this, the .partial() z.object STRIPS the unknown `theme` key
    // and the setting never persists through setSettings.
    theme: z.enum(['light', 'dark', 'system']),
  })
  .partial();

/**
 * R-M4: renderer-forwarded crash payload. The renderer is the trusted
 * producer here, but the boundary is the right place to fail loud on
 * shape drift and (more importantly) cap pathological string sizes —
 * a deep React tree's componentStack can run into many KB and an
 * infinite-loop in componentDidCatch can spam the crashes folder.
 *
 * Field caps:
 *   - name/message     — kept short, fits an Error
 *   - stack            — 8 KB covers a typical V8 stack
 *   - componentStack   — 4 KB covers a deep-but-reasonable React tree
 *   - url              — under any reasonable browser-URL limit
 */
export const recordRendererCrashSchema = z.object({
  name: z.string().max(256).optional(),
  message: z.string().max(2048).optional(),
  stack: z.string().max(8192).optional(),
  componentStack: z.string().max(4096).optional(),
  url: z.string().max(2048).optional(),
});
