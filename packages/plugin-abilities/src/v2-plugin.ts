/**
 * OpenCode v2 plugin: ability execution + enforcement.
 *
 * Port of the v1 plugin (src/opencode-plugin.ts) to the v2 plugin API:
 * - ability tools are registered through `ctx.tool.transform` (editor.add),
 * - enforcement runs on `ctx.tool.hook("execute.before")` (throw = block),
 * - a second denial layer denies mutating permission actions via
 *   `ctx.permission.hook("evaluate")` (scope decision B1),
 * - the ENFORCEMENT ACTIVE notice is injected on `ctx.session.hook("context")`,
 * - execution state is mirrored to `ctx.storage` so a stale `running` record
 *   from a dead process is marked `interrupted` on startup (crash recovery).
 *
 * All decisions come from the pure module ./v2/enforcement.ts. Setup logic is
 * assembled in `setupAbilitiesV2(deps)` with narrow dependency interfaces so it
 * is testable without a live opencode host; `default` only adapts the real
 * `Plugin.Context` to those interfaces (scope decision A1: enforcement only
 * during script steps; C1: fail-closed unless options.strict === false).
 */

import { Plugin } from '@opencode/plugin'
import type { Ability, ExecutorContext, LoadedAbility } from './types/index.js'
import { loadAbilities } from './loader/index.js'
import { validateInputs } from './validator/index.js'
import { formatExecutionResult } from './executor/index.js'
import { ExecutionManager } from './executor/execution-manager.js'
import {
  EnforcementDenialError,
  NO_ENFORCEMENT,
  buildNotice,
  decidePermission,
  decideTool,
  isRunningStoredExecution,
  markInterrupted,
  runGuarded,
  type EnforcementState,
  type PermissionDecision,
  type StoredExecution,
  type ToolDecision,
} from './v2/enforcement.js'

/** Storage key for the active-execution mirror (crash recovery). */
export const STORAGE_KEY = 'active-execution'

export const PLUGIN_ID = 'plugin-abilities'

// ─────────────────────────────────────────────────────────────
// Dependency interfaces (narrow, structural — host-agnostic)
// ─────────────────────────────────────────────────────────────

export interface V2StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface PermissionEvaluationLike {
  action: string
  effect: 'allow' | 'deny' | 'ask'
  message?: string
}

export interface SessionContextLike {
  messages: unknown[]
  system: unknown[]
}

export interface AbilityToolRegistration {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: any) => Promise<{ content: string }>
}

export interface V2PluginDeps {
  readonly directory: string
  readonly options: Readonly<Record<string, unknown>>
  readonly storage: V2StorageLike
  /** Register the tool.execute.before enforcement hook. */
  registerToolHook(callback: (input: { tool: string }) => void | Promise<void>): unknown
  /** Register the permission.evaluate denial layer. */
  registerPermissionHook(callback: (evaluation: PermissionEvaluationLike) => void | Promise<void>): unknown
  /** Register the session.context notice injection hook. */
  registerSessionContextHook(callback: (context: SessionContextLike) => void | Promise<void>): unknown
  /** Register the ability tools with the host tool registry. */
  registerTools(register: (sink: (tool: AbilityToolRegistration) => void) => void): unknown
}

// ─────────────────────────────────────────────────────────────
// Setup (host-agnostic, fully testable)
// ─────────────────────────────────────────────────────────────

export async function setupAbilitiesV2(deps: V2PluginDeps): Promise<void> {
  const strict = (deps.options as { strict?: boolean }).strict !== false
  const abilitiesDir = `${deps.directory}/.opencode/abilities`

  const abilities = new Map<string, LoadedAbility>()
  const manager = new ExecutionManager()

  // Load ability definitions (non-fatal: an empty registry only means
  // ability.run has nothing to offer). Awaited so tools never race the load.
  try {
    const loaded = await loadAbilities({ projectDir: abilitiesDir, includeGlobal: false })
    for (const [name, ability] of loaded) abilities.set(name, ability)
    console.log(`[abilities] Loaded ${abilities.size} abilities from ${abilitiesDir}`)
  } catch (err) {
    console.log('[abilities] Could not load abilities:', err instanceof Error ? err.message : err)
  }

  const createExecutorContext = (): ExecutorContext => ({ cwd: deps.directory, env: {} })

  // ── Crash recovery ─────────────────────────────────────────
  // A 'running' mirror can only come from a previous process; this process
  // starts with an empty manager, so the execution was interrupted.
  void (async () => {
    try {
      const stored = await deps.storage.get(STORAGE_KEY)
      if (isRunningStoredExecution(stored)) {
        await deps.storage.set(STORAGE_KEY, markInterrupted(stored))
        console.error(
          `[abilities] Stale execution '${stored.ability}' (step '${stored.stepId}') from a previous ` +
          'session was interrupted — recovery recorded.',
        )
      }
    } catch (err) {
      console.error('[abilities] storage recovery failed:', err)
    }
  })()

  // ── Lazy storage mirror ────────────────────────────────────
  // The in-process manager is the live truth; storage is only the durable
  // mirror used for crash recovery. Mirror failures never gate decisions.
  let mirrorSig = 'idle'
  const mirrorState = async (): Promise<void> => {
    const execution = manager.getActive()
    const running = execution !== null && execution.status === 'running' && execution.currentStep !== null
    const sig = running && execution ? `${execution.ability.name}:${execution.currentStep!.id}` : 'idle'
    if (sig === mirrorSig) return
    mirrorSig = sig
    try {
      if (running && execution && execution.currentStep) {
        const stored: StoredExecution = {
          status: 'running',
          ability: execution.ability.name,
          stepId: execution.currentStep.id,
          stepType: execution.currentStep.type,
          startedAt: new Date(execution.startedAt).toISOString(),
        }
        await deps.storage.set(STORAGE_KEY, stored)
      } else {
        await deps.storage.remove(STORAGE_KEY)
      }
    } catch (err) {
      console.error('[abilities] storage mirror failed:', err)
    }
  }

  const currentState = (): EnforcementState => {
    const execution = manager.getActive()
    if (!execution || execution.status !== 'running' || !execution.currentStep) return NO_ENFORCEMENT
    return {
      activeStep: {
        ability: execution.ability.name,
        stepId: execution.currentStep.id,
        stepType: execution.currentStep.type,
      },
    }
  }

  // ── Enforcement layer 1: tool.execute.before (throw = block) ──
  deps.registerToolHook((input): Promise<void> | void =>
    runGuarded(
      strict,
      async () => {
        await mirrorState()
        const decision: ToolDecision = decideTool(input.tool, currentState())
        if (!decision.allow) throw new EnforcementDenialError(decision.reason)
      },
      err => console.error('[abilities] tool.execute.before error:', err),
    ),
  )

  // ── Enforcement layer 2: permission.evaluate (dynamic deny) ──
  deps.registerPermissionHook((evaluation): Promise<void> | void =>
    runGuarded(
      strict,
      () => {
        const decision: PermissionDecision = decidePermission(evaluation.action, currentState())
        if (decision.deny) {
          evaluation.effect = 'deny'
          evaluation.message = `[abilities] ${decision.reason}`
        }
      },
      err => console.error('[abilities] permission.evaluate error:', err),
    ),
  )

  // ── Notice injection: session.context (best-effort, never gates) ──
  deps.registerSessionContextHook(context => {
    try {
      const execution = manager.getActive()
      if (!execution || execution.status !== 'running' || !execution.currentStep) return
      const notice = buildNotice(
        {
          ability: execution.ability.name,
          stepId: execution.currentStep.id,
          stepType: execution.currentStep.type,
        },
        { completed: execution.completedSteps.length, total: execution.ability.steps.length },
      )
      context.messages.unshift({ type: 'text', text: notice })
    } catch (err) {
      console.error('[abilities] session.context error:', err)
    }
  })

  // ── Ability tools (ported from v1) ─────────────────────────
  deps.registerTools(register => {
    register({
      name: 'ability.list',
      description: 'List all available abilities',
      input: { type: 'object', properties: {} },
      async execute() {
        if (abilities.size === 0) return { content: 'No abilities loaded.' }
        const list = Array.from(abilities.values()).map(loaded => {
          const stepCount = loaded.ability.steps.length
          return `- **${loaded.ability.name}**: ${loaded.ability.description} (${stepCount} steps)`
        })
        return { content: list.join('\n') }
      },
    })

    register({
      name: 'ability.run',
      description: `Execute an ability workflow. Available: ${Array.from(abilities.keys()).join(', ') || 'none loaded'}`,
      input: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Ability name to run' },
          inputs: { type: 'object', description: 'Input values for the ability', additionalProperties: true },
        },
        required: ['name'],
      },
      async execute(input) {
        const { name, inputs = {} } = (input ?? {}) as { name?: string; inputs?: Record<string, unknown> }
        if (typeof name !== 'string' || name.length === 0) {
          return { content: JSON.stringify({ error: "Parameter 'name' is required" }) }
        }
        const loaded = abilities.get(name)
        if (!loaded) {
          return { content: JSON.stringify({ error: `Ability '${name}' not found` }) }
        }
        const ability: Ability = loaded.ability

        const inputErrors = validateInputs(ability, inputs)
        if (inputErrors.length > 0) {
          return {
            content: JSON.stringify({ error: 'Input validation failed', details: inputErrors.map(e => e.message) }),
          }
        }

        try {
          const execution = await manager.execute(ability, inputs, createExecutorContext())
          return {
            content: JSON.stringify({
              status: execution.status,
              ability: ability.name,
              result: formatExecutionResult(execution),
            }),
          }
        } catch (error) {
          return {
            content: JSON.stringify({
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    })

    register({
      name: 'ability.status',
      description: 'Get status of active ability execution',
      input: { type: 'object', properties: {} },
      async execute() {
        const execution = manager.getActive()
        if (!execution) {
          return { content: JSON.stringify({ status: 'none', message: 'No active ability' }) }
        }
        return {
          content: JSON.stringify({
            status: execution.status,
            ability: execution.ability.name,
            currentStep: execution.currentStep?.id,
            progress: `${execution.completedSteps.length}/${execution.ability.steps.length}`,
          }),
        }
      },
    })

    register({
      name: 'ability.cancel',
      description: 'Cancel the active ability execution',
      input: { type: 'object', properties: {} },
      async execute() {
        const cancelled = manager.cancelActive()
        return {
          content: JSON.stringify(
            cancelled
              ? { status: 'cancelled', message: 'Ability cancelled' }
              : { status: 'none', message: 'No active ability' },
          ),
        }
      },
    })
  })
}

// ─────────────────────────────────────────────────────────────
// Host adapter (the only place that touches opencode types)
// ─────────────────────────────────────────────────────────────

/**
 * Build the v2 plugin. `Plugin.define` returns the definition object that
 * opencode v2 loads from `.opencode/plugins/` or the `plugins` config array.
 * Tool registration payloads are structurally compatible with
 * ToolDomain's ToolEditor.add — the single cast lives at this boundary.
 */
export function createAbilitiesPluginV2(): ReturnType<typeof Plugin.define> {
  return Plugin.define({
    id: PLUGIN_ID,
    setup(context) {
      // The opencode v2 preview CLI ships a Context without the enforcement
      // domains. Degrade loudly (fail-open, plugin idle) instead of crashing
      // on a missing `context.location`.
      if (!isEnforcementCapableContext(context)) {
        console.error(
          '[abilities] opencode host does not expose the v2 enforcement domains (tool/permission/session/storage). ' +
            'This is expected on the v2 preview CLI — abilities enforcement is DISABLED here and the plugin stays idle. ' +
            'Upgrade opencode once these domains ship.',
        )
        return undefined
      }
      return setupAbilitiesV2({
        directory: context.location.directory,
        options: context.options ?? {},
        storage: context.storage,
        registerToolHook: callback => {
          void context.tool.hook('execute.before', callback)
        },
        registerPermissionHook: callback => {
          void context.permission.hook('evaluate', callback)
        },
        registerSessionContextHook: callback => {
          void context.session.hook('context', callback)
        },
        registerTools: register => {
          void context.tool.transform(editor => {
            // The host transform provides the editor; every tool the setup
            // registers through `register` is forwarded into it.
            register(tool => editor.add(tool as unknown as Parameters<typeof editor.add>[0]))
          })
        },
      })
    },
  })
}

export default createAbilitiesPluginV2()

// Capability probe

interface EnforcementContextShape {
  location?: { directory?: unknown }
  tool?: { hook?: unknown; transform?: unknown }
  permission?: { hook?: unknown }
  session?: { hook?: unknown }
  storage?: { get?: unknown; set?: unknown }
  options?: unknown
}

const isFn = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function'

/**
 * Structural probe for the enforcement surface of a host Context. True when
 * every domain the plugin needs is present (v2 target API); false on preview
 * hosts that only expose transform/catalog-style domains.
 */
export function isEnforcementCapableContext(context: unknown): boolean {
  const c = context as EnforcementContextShape | null | undefined
  if (!c || typeof c !== 'object') return false
  return (
    !!c.location &&
    typeof c.location.directory === 'string' &&
    !!c.tool &&
    isFn(c.tool.hook) &&
    isFn(c.tool.transform) &&
    !!c.permission &&
    isFn(c.permission.hook) &&
    !!c.session &&
    isFn(c.session.hook) &&
    !!c.storage &&
    isFn(c.storage.get) &&
    isFn(c.storage.set)
  )
}
