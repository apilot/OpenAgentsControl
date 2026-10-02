/**
 * Tests for the v2 plugin setup (src/v2-plugin.ts).
 *
 * The plugin logic is assembled in setupAbilitiesV2(deps) against narrow
 * dependency interfaces, so these tests drive it with hand-rolled stubs:
 * real ExecutionManager + real script executor + real ability loader, but no
 * live opencode host.
 *
 * Run: npx -y bun test tests/v2-plugin.test.ts
 */

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  STORAGE_KEY,
  setupAbilitiesV2,
  type AbilityToolRegistration,
  type V2PluginDeps,
} from '../src/v2-plugin.ts'
import { EnforcementDenialError } from '../src/v2/enforcement.ts'

interface Harness {
  deps: V2PluginDeps
  toolHooks: Array<(input: { tool: string }) => Promise<void> | void>
  permissionHooks: Array<(evaluation: { action: string; effect: 'allow' | 'deny' | 'ask'; message?: string }) => Promise<void> | void>
  sessionHooks: Array<(context: { messages: unknown[]; system: unknown[] }) => Promise<void> | void>
  tools: Map<string, AbilityToolRegistration>
  storage: Map<string, unknown>
}

function createHarness(directory: string, options: Readonly<Record<string, unknown>> = {}): Harness {
  const toolHooks: Harness['toolHooks'] = []
  const permissionHooks: Harness['permissionHooks'] = []
  const sessionHooks: Harness['sessionHooks'] = []
  const tools = new Map<string, AbilityToolRegistration>()
  const storage = new Map<string, unknown>()

  const deps: V2PluginDeps = {
    directory,
    options,
    storage: {
      get: async key => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value)
      },
      remove: async key => {
        storage.delete(key)
      },
    },
    registerToolHook: callback => {
      toolHooks.push(callback)
    },
    registerPermissionHook: callback => {
      permissionHooks.push(callback)
    },
    registerSessionContextHook: callback => {
      sessionHooks.push(callback)
    },
    registerTools: add => {
      add(tool => tools.set(tool.name, tool))
    },
  }

  return { deps, toolHooks, permissionHooks, sessionHooks, tools, storage }
}

const SLOW_ABILITY_YAML = `
name: slow-demo
description: Slow ability for enforcement tests

steps:
  - id: slow-step
    type: script
    run: sleep 0.5
    validation:
      exit_code: 0
`

const STRICT_INPUT_ABILITY_YAML = `
name: needs-input
description: Ability with a required input

inputs:
  message:
    type: string
    required: true

steps:
  - id: echo
    type: script
    run: echo "{{inputs.message}}"
    validation:
      exit_code: 0
`

const TWO_STEP_ABILITY_YAML = `
name: two-step
description: Two step ability for cancel tests

steps:
  - id: first
    type: script
    run: sleep 0.4
    validation:
      exit_code: 0
  - id: second
    type: script
    run: echo second
    needs: [first]
    validation:
      exit_code: 0
`

async function makeFixtureDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oac-v2-plugin-'))
  const abilitiesDir = path.join(root, '.opencode/abilities')
  await fs.mkdir(abilitiesDir, { recursive: true })
  await fs.writeFile(path.join(abilitiesDir, 'slow-demo.yaml'), SLOW_ABILITY_YAML)
  await fs.writeFile(path.join(abilitiesDir, 'needs-input.yaml'), STRICT_INPUT_ABILITY_YAML)
  await fs.writeFile(path.join(abilitiesDir, 'two-step.yaml'), TWO_STEP_ABILITY_YAML)
  return root
}

describe('v2 plugin setup', () => {
  it('registers the four ability tools', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await setupAbilitiesV2(harness.deps)

    expect(Array.from(harness.tools.keys()).sort()).toEqual([
      'ability.cancel',
      'ability.list',
      'ability.run',
      'ability.status',
    ])
  })

  it('lists loaded abilities', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await setupAbilitiesV2(harness.deps)

    const result = await harness.tools.get('ability.list')!.execute({})
    expect(result.content).toContain('**slow-demo**: Slow ability for enforcement tests (1 steps)')
  })

  it('marks a stale running record interrupted on startup (crash recovery)', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await harness.storage.set(STORAGE_KEY, {
      status: 'running',
      ability: 'old-ability',
      stepId: 'old-step',
      stepType: 'script',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })

    await setupAbilitiesV2(harness.deps)

    const stored = harness.storage.get(STORAGE_KEY) as Record<string, unknown>
    expect(stored.status).toBe('interrupted')
    expect(stored.ability).toBe('old-ability')
    expect(typeof stored.interruptedAt).toBe('string')
  })

  it('ignores garbage in storage', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await harness.storage.set(STORAGE_KEY, 'garbage')

    await setupAbilitiesV2(harness.deps)

    expect(harness.storage.get(STORAGE_KEY)).toBe('garbage')
  })

  it('ability.run returns a JSON error for unknown abilities', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await setupAbilitiesV2(harness.deps)

    const result = await harness.tools.get('ability.run')!.execute({ name: 'nope' })
    expect(JSON.parse(result.content)).toEqual({ error: "Ability 'nope' not found" })
  })

  it('ability.run reports input validation failures', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await setupAbilitiesV2(harness.deps)

    const result = await harness.tools.get('ability.run')!.execute({ name: 'needs-input' })
    const payload = JSON.parse(result.content)
    expect(payload.error).toBe('Input validation failed')
    expect(payload.details.length).toBeGreaterThan(0)
  })

  describe('enforcement during a running script step', () => {
    it('denies tools, denies permission actions, injects the notice, and mirrors state', async () => {
      const root = await makeFixtureDir()
      const harness = createHarness(root)
      await setupAbilitiesV2(harness.deps)

      const toolHook = harness.toolHooks[0]!
      const permissionHook = harness.permissionHooks[0]!
      const sessionHook = harness.sessionHooks[0]!

      // Idle: everything allowed, no notice, no mirror.
      await expect(toolHook({ tool: 'edit' })).resolves.toBeUndefined()
      const idleContext = { messages: [] as unknown[], system: [] as unknown[] }
      await sessionHook(idleContext)
      expect(idleContext.messages.length).toBe(0)
      expect(harness.storage.get(STORAGE_KEY)).toBeUndefined()

      // Start a slow execution without awaiting it.
      const run = harness.tools.get('ability.run')!.execute({ name: 'slow-demo' })

      // Layer 1: tools other than read-only ones are denied with a v1-shaped error.
      await expect(toolHook({ tool: 'edit' })).rejects.toBeInstanceOf(EnforcementDenialError)
      await expect(toolHook({ tool: 'bash' })).rejects.toBeInstanceOf(EnforcementDenialError)
      await expect(toolHook({ tool: 'read' })).resolves.toBeUndefined()
      await expect(toolHook({ tool: 'ability.status' })).resolves.toBeUndefined()

      // Layer 2: mutating permission actions get effect=deny + message.
      const evaluation = { action: 'edit', effect: 'allow' as const }
      await permissionHook(evaluation)
      expect(evaluation.effect).toBe('deny')
      expect(evaluation.message).toContain('[abilities]')
      expect(evaluation.message).toContain("'edit' denied during script step 'slow-step'")

      // Read-only-ish actions stay untouched by the permission layer.
      const untouched = { action: 'read', effect: 'allow' as const }
      await permissionHook(untouched)
      expect(untouched.effect).toBe('allow')

      // Notice injection while running.
      const runningContext = { messages: [] as unknown[], system: [] as unknown[] }
      await sessionHook(runningContext)
      expect(runningContext.messages.length).toBe(1)
      expect(JSON.stringify(runningContext.messages[0])).toContain('ENFORCEMENT ACTIVE')
      expect(JSON.stringify(runningContext.messages[0])).toContain('Active Ability: slow-demo')

      // Storage mirror reflects the running step.
      const mirror = harness.storage.get(STORAGE_KEY) as Record<string, unknown>
      expect(mirror.status).toBe('running')
      expect(mirror.ability).toBe('slow-demo')
      expect(mirror.stepId).toBe('slow-step')

      // ability.status sees the running execution.
      const status = JSON.parse((await harness.tools.get('ability.status')!.execute({})).content)
      expect(status.status).toBe('running')
      expect(status.currentStep).toBe('slow-step')

      // After completion everything returns to idle.
      const execution = JSON.parse((await run).content)
      expect(execution.status).toBe('completed')

      await expect(toolHook({ tool: 'edit' })).resolves.toBeUndefined()
      const afterContext = { messages: [] as unknown[], system: [] as unknown[] }
      await sessionHook(afterContext)
      expect(afterContext.messages.length).toBe(0)
      expect(harness.storage.get(STORAGE_KEY)).toBeUndefined()
    })

    it('ability.cancel stops the execution and the mirror clears', async () => {
      const root = await makeFixtureDir()
      const harness = createHarness(root)
      await setupAbilitiesV2(harness.deps)

      // Two steps: cancel during the first; abort is honored before the second
      // (executor checks the signal between steps — v1 semantics).
      const run = harness.tools.get('ability.run')!.execute({ name: 'two-step' })
      const cancel = JSON.parse((await harness.tools.get('ability.cancel')!.execute({})).content)
      expect(cancel.status).toBe('cancelled')

      const execution = JSON.parse((await run).content)
      expect(execution.status).toBe('failed')

      // Next hook invocation clears the mirror.
      await harness.toolHooks[0]!({ tool: 'read' })
      expect(harness.storage.get(STORAGE_KEY)).toBeUndefined()
    })

    it('ability.run while another execution is active surfaces the manager error', async () => {
      const root = await makeFixtureDir()
      const harness = createHarness(root)
      await setupAbilitiesV2(harness.deps)

      const first = harness.tools.get('ability.run')!.execute({ name: 'slow-demo' })
      const second = JSON.parse((await harness.tools.get('ability.run')!.execute({ name: 'slow-demo' })).content)
      expect(second.status).toBe('error')

      await first
    })
  })
})

// --- preview-Context graceful degradation ---

describe('preview-Context graceful degradation', () => {
  it('isEnforcementCapableContext accepts a fully capable host', async () => {
    const { isEnforcementCapableContext } = await import('../src/v2-plugin.ts')
    const capable = {
      location: { directory: '/tmp/project' },
      options: {},
      tool: { hook: () => {}, transform: () => {} },
      permission: { hook: () => {} },
      session: { hook: () => {} },
      storage: { get: () => {}, set: () => {} },
    }
    expect(isEnforcementCapableContext(capable)).toBe(true)
  })

  it('isEnforcementCapableContext rejects preview hosts missing each domain', async () => {
    const { isEnforcementCapableContext } = await import('../src/v2-plugin.ts')
    const capable: Record<string, unknown> = {
      location: { directory: '/tmp/project' },
      options: {},
      tool: { hook: () => {}, transform: () => {} },
      permission: { hook: () => {} },
      session: { hook: () => {} },
      storage: { get: () => {}, set: () => {} },
    }
    expect(isEnforcementCapableContext(capable)).toBe(true)
    for (const domain of ['location', 'tool', 'permission', 'session', 'storage']) {
      const broken = { ...capable }
      delete broken[domain]
      expect(isEnforcementCapableContext(broken)).toBe(false)
    }
    expect(isEnforcementCapableContext(null)).toBe(false)
    expect(isEnforcementCapableContext('nope')).toBe(false)
    // Tool domain without transform (hook-only) is not enough.
    expect(
      isEnforcementCapableContext({ ...capable, tool: { hook: () => {} } }),
    ).toBe(false)
  })

  it('setup() on a preview host logs a loud warning and stays idle', async () => {
    const { createAbilitiesPluginV2, isEnforcementCapableContext } = await import('../src/v2-plugin.ts')
    // Shape observed on opencode2 preview: transform/catalog domains only.
    const previewContext = {
      options: {},
      agent: { transform: () => {}, reload: () => {} },
      skill: { transform: () => {}, reload: () => {} },
      command: { transform: () => {}, reload: () => {} },
    }
    expect(isEnforcementCapableContext(previewContext)).toBe(false)

    const errors: string[] = []
    const originalError = console.error
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }
    try {
      const plugin = createAbilitiesPluginV2()
      const result = await plugin.setup(previewContext as never)
      expect(result).toBeUndefined()
    } finally {
      console.error = originalError
    }
    const warning = errors.join('\n')
    expect(warning).toContain('[abilities]')
    expect(warning).toContain('DISABLED')
    expect(warning).toContain('preview')
  })
})

describe('review hardening (#5, #7, M4)', () => {
  it('degrades per domain: a tool-only host still enforces via layer 1 (#5)', async () => {
    const root = await makeFixtureDir()
    const toolHooks: Array<(input: { tool: string }) => Promise<void> | void> = []
    const tools = new Map<string, AbilityToolRegistration>()

    // Preview-like host: location + tool only. permission/session/storage absent.
    const context = {
      location: { directory: root },
      options: {},
      tool: {
        hook: (_name: string, cb: (input: { tool: string }) => Promise<void> | void) => {
          toolHooks.push(cb)
          return Promise.resolve({ dispose() {} })
        },
        transform: (cb: (editor: { add: (tool: AbilityToolRegistration) => void }) => void) => {
          cb({ add: tool => tools.set(tool.name, tool) })
          return Promise.resolve({ dispose() {} })
        },
      },
    }

    const { createAbilitiesPluginV2 } = await import('../src/v2-plugin.ts')
    const errors: string[] = []
    const originalError = console.error
    console.error = (message?: unknown) => { errors.push(String(message)) }
    try {
      const plugin = createAbilitiesPluginV2()
      await plugin.setup(context as never)
    } finally {
      console.error = originalError
    }

    expect(errors.join('\n')).toContain('permission domain unavailable')
    expect(errors.join('\n')).toContain('storage domain unavailable')
    expect(toolHooks.length).toBe(1)
    expect(Array.from(tools.keys()).sort()).toEqual([
      'ability.cancel', 'ability.list', 'ability.run', 'ability.status',
    ])

    // Layer 1 keeps working even without the other domains.
    const run = tools.get('ability.run')!.execute({ name: 'slow-demo' })
    await expect(toolHooks[0]!({ tool: 'bash' })).rejects.toBeInstanceOf(EnforcementDenialError)
    const execution = JSON.parse((await run).content)
    expect(execution.status).toBe('completed')
  })

  it('retries a failed mirror write on the next hook call (#7)', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    let failWrites = true
    const realSet = harness.deps.storage.set.bind(harness.deps.storage)
    harness.deps.storage.set = async (key, value) => {
      if (failWrites) throw new Error('disk full')
      return realSet(key, value)
    }
    await setupAbilitiesV2(harness.deps)

    const toolHook = harness.toolHooks[0]!
    const run = harness.tools.get('ability.run')!.execute({ name: 'slow-demo' })

    await toolHook({ tool: 'read' }) // mirror attempt fails (read stays allowed)
    expect(harness.storage.get(STORAGE_KEY)).toBeUndefined()

    failWrites = false
    await toolHook({ tool: 'read' }) // same signature — must retry, not skip
    const mirror = harness.storage.get(STORAGE_KEY) as Record<string, unknown>
    expect(mirror.status).toBe('running')

    await run
  })

  it('mirrors state on step start even before any tool call (M4)', async () => {
    const root = await makeFixtureDir()
    const harness = createHarness(root)
    await setupAbilitiesV2(harness.deps)

    const run = harness.tools.get('ability.run')!.execute({ name: 'slow-demo' })
    await new Promise(resolve => setTimeout(resolve, 150))
    const mirror = harness.storage.get(STORAGE_KEY) as Record<string, unknown>
    expect(mirror?.status).toBe('running')
    expect(mirror?.ability).toBe('slow-demo')

    await run
  })
})
