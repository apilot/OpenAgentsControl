/**
 * Pure enforcement decision logic for the opencode v2 plugin.
 *
 * No IO, no framework types — everything is decided from an explicit
 * EnforcementState so the rules stay unit-testable. The v2 plugin wires
 * these decisions into tool hooks, permission evaluation, and session
 * context injection.
 *
 * Semantics mirror the v1 plugin (scope decision A1): enforcement is active
 * ONLY while a script step of an ability execution is running; read-only
 * tools stay allowed.
 */

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

export interface EnforcementStepState {
  readonly ability: string;
  readonly stepId: string;
  readonly stepType: string;
}

export interface EnforcementState {
  readonly activeStep: EnforcementStepState | null;
}

export const NO_ENFORCEMENT: EnforcementState = { activeStep: null };

/** Enforcement is live only while a script step is executing (v1 semantics). */
export function isActiveScriptStep(state: EnforcementState): boolean {
  return state.activeStep !== null && state.activeStep.stepType === 'script';
}

// ─────────────────────────────────────────────────────────────
// Tool decisions (tool.hook "execute.before")
// ─────────────────────────────────────────────────────────────

/** Tools allowed even while a script step is running (v1 ALWAYS_ALLOWED_TOOLS). */
export const READONLY_TOOLS: readonly string[] = [
  'ability.list',
  'ability.status',
  'ability.cancel',
  'read',
  'glob',
  'grep',
];

export type ToolDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export function decideTool(tool: string, state: EnforcementState): ToolDecision {
  if (!isActiveScriptStep(state)) return { allow: true };
  if (READONLY_TOOLS.includes(tool)) return { allow: true };
  const step = state.activeStep!;
  return {
    allow: false,
    reason:
      `Tool '${tool}' blocked during script step '${step.stepId}'. ` +
      'Script steps run deterministically - wait for completion.',
  };
}

// ─────────────────────────────────────────────────────────────
// Permission decisions (permission.hook "evaluate")
// ─────────────────────────────────────────────────────────────

/**
 * Permission actions denied while a script step is running.
 * v2 renamed bash→shell / task→subagent / write+patch→edit; legacy names kept
 * so the layer also denies on hosts that still use v1 action names.
 */
export const DENIED_ACTIONS: readonly string[] = [
  'edit',
  'write',
  'patch',
  'shell',
  'bash',
  'subagent',
  'task',
  'webfetch',
];

export type PermissionDecision = { readonly deny: false } | { readonly deny: true; readonly reason: string };

export function decidePermission(action: string, state: EnforcementState): PermissionDecision {
  if (!isActiveScriptStep(state)) return { deny: false };
  if (!DENIED_ACTIONS.includes(action)) return { deny: false };
  const step = state.activeStep!;
  return {
    deny: true,
    reason:
      `Action '${action}' denied during script step '${step.stepId}' of ability '${step.ability}'. ` +
      'Wait for the step to complete.',
  };
}

// ─────────────────────────────────────────────────────────────
// Storage mirror / crash recovery
// ─────────────────────────────────────────────────────────────

/** JSON shape mirrored to ctx.storage while an execution is active. */
export interface StoredExecution {
  status: 'running' | 'interrupted';
  ability: string;
  stepId: string;
  stepType: string;
  startedAt: string;
  interruptedAt?: string;
}

/** Narrow an unknown storage payload into a running StoredExecution. */
export function isRunningStoredExecution(value: unknown): value is StoredExecution {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.status === 'running' &&
    typeof record.ability === 'string' &&
    typeof record.stepId === 'string' &&
    typeof record.stepType === 'string' &&
    typeof record.startedAt === 'string' &&
    !Number.isNaN(Date.parse(record.startedAt))
  );
}

/** A 'running' record found on startup belongs to a dead process — mark it. */
export function markInterrupted(stored: StoredExecution, now: Date = new Date()): StoredExecution {
  return { ...stored, status: 'interrupted', interruptedAt: now.toISOString() };
}

// ─────────────────────────────────────────────────────────────
// Session context notice
// ─────────────────────────────────────────────────────────────

/** v1 chat.message injection text, parameterised for the pure module. */
export function buildNotice(
  step: EnforcementStepState,
  progress?: { readonly completed: number; readonly total: number },
): string {
  const lines = [
    `## 🔄 Active Ability: ${step.ability}`,
    '',
  ];
  if (progress) {
    lines.push(`**Progress:** ${progress.completed}/${progress.total} steps completed`, '');
  }
  lines.push(
    `### Current Step: ${step.stepId}`,
    '**Action:** Script is executing. Wait for completion.',
    '',
    '⚠️ **ENFORCEMENT ACTIVE** - Other tools are blocked until step completes.',
  );
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Guard (scope decision C1: fail-closed by default, strict:false → fail-open)
// ─────────────────────────────────────────────────────────────

/**
 * A deliberate enforcement verdict (tool denial) — must always propagate,
 * in strict and non-strict mode alike.
 */
export class EnforcementDenialError extends Error {
  constructor(reason: string) {
    super(`[abilities] ${reason}`);
    this.name = 'EnforcementDenialError';
  }
}

/**
 * Runs a hook callback under the strictness policy:
 * - `EnforcementDenialError` always propagates (that is the enforcement verdict),
 *   after being reported through `onError` for the log.
 * - Internal errors rethrow in strict mode (fail-closed: block the operation)
 *   and are swallowed in non-strict mode (fail-open: allow it).
 */
export async function runGuarded<T>(
  strict: boolean,
  action: () => T | Promise<T>,
  onError: (err: unknown) => void = () => {},
): Promise<T | undefined> {
  try {
    return await action();
  } catch (err) {
    onError(err);
    if (err instanceof EnforcementDenialError) throw err;
    if (strict) throw err;
    return undefined;
  }
}
