/**
 * Tests for the pure v2 enforcement decision logic (src/v2/enforcement.ts).
 *
 * Run: npx -y bun test tests/v2-enforcement.test.ts
 */

import { describe, expect, it } from 'bun:test'
import {
  DENIED_ACTIONS,
  EnforcementDenialError,
  NO_ENFORCEMENT,
  READONLY_TOOLS,
  buildNotice,
  decidePermission,
  decideTool,
  isActiveScriptStep,
  isRunningStoredExecution,
  markInterrupted,
  runGuarded,
  type EnforcementState,
} from '../src/v2/enforcement.ts'

const scriptStep = (ability = 'deploy', stepId = 's1'): EnforcementState => ({
  activeStep: { ability, stepId, stepType: 'script' },
})

const futureStep = (stepType = 'future-type'): EnforcementState => ({
  activeStep: { ability: 'deploy', stepId: 's9', stepType },
})

describe('isActiveScriptStep', () => {
  it('is false without an active step', () => {
    expect(isActiveScriptStep(NO_ENFORCEMENT)).toBe(false)
    expect(isActiveScriptStep({ activeStep: null })).toBe(false)
  })

  it('is true only for script steps', () => {
    expect(isActiveScriptStep(scriptStep())).toBe(true)
    expect(isActiveScriptStep(futureStep())).toBe(false)
  })
})

describe('decideTool', () => {
  it('allows everything when no script step is active', () => {
    expect(decideTool('edit', NO_ENFORCEMENT)).toEqual({ allow: true })
    expect(decideTool('bash', futureStep())).toEqual({ allow: true })
  })

  it('allows read-only tools during a script step', () => {
    for (const tool of READONLY_TOOLS) {
      expect(decideTool(tool, scriptStep())).toEqual({ allow: true })
    }
  })

  it('denies write/execute tools during a script step with a v1-shaped reason', () => {
    for (const tool of ['edit', 'write', 'shell', 'bash', 'subagent', 'task', 'webfetch']) {
      const decision = decideTool(tool, scriptStep('deploy', 'build'))
      expect(decision.allow).toBe(false)
      if (!decision.allow) {
        expect(decision.reason).toContain(`'${tool}' blocked during script step 'build'`)
        expect(decision.reason).toContain('wait for completion')
      }
    }
  })
})

describe('decidePermission', () => {
  it('denies nothing outside a script step', () => {
    expect(decidePermission('edit', NO_ENFORCEMENT)).toEqual({ deny: false })
    expect(decidePermission('shell', futureStep())).toEqual({ deny: false })
  })

  it('denies v2 and legacy action names during a script step', () => {
    for (const action of DENIED_ACTIONS) {
      const decision = decidePermission(action, scriptStep('deploy', 'build'))
      expect(decision.deny).toBe(true)
      if (decision.deny) {
        expect(decision.reason).toContain(`'${action}'`)
        expect(decision.reason).toContain("ability 'deploy'")
      }
    }
  })

  it('covers the v2 renames and their legacy aliases', () => {
    expect(DENIED_ACTIONS).toContain('shell')
    expect(DENIED_ACTIONS).toContain('bash')
    expect(DENIED_ACTIONS).toContain('subagent')
    expect(DENIED_ACTIONS).toContain('task')
    expect(DENIED_ACTIONS).toContain('edit')
    expect(DENIED_ACTIONS).toContain('write')
    expect(DENIED_ACTIONS).toContain('patch')
  })

  it('denies only mutating/execute actions', () => {
    expect(decidePermission('read', scriptStep())).toEqual({ deny: false })
  })
})

describe('stored execution (crash recovery)', () => {
  const running = {
    status: 'running',
    ability: 'deploy',
    stepId: 'build',
    stepType: 'script',
    startedAt: new Date().toISOString(),
  }

  it('accepts a well-formed running record', () => {
    expect(isRunningStoredExecution(running)).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(isRunningStoredExecution(null)).toBe(false)
    expect(isRunningStoredExecution('running')).toBe(false)
    expect(isRunningStoredExecution({ ...running, status: 'interrupted' })).toBe(false)
    expect(isRunningStoredExecution({ ...running, startedAt: 'not-a-date' })).toBe(false)
    expect(isRunningStoredExecution({ ...running, ability: 42 })).toBe(false)
    expect(isRunningStoredExecution({ ...running, stepId: undefined })).toBe(false)
  })

  it('marks a running record interrupted without mutating the input', () => {
    const at = new Date('2026-10-01T12:00:00.000Z')
    const interrupted = markInterrupted(running, at)
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.interruptedAt).toBe('2026-10-01T12:00:00.000Z')
    expect(interrupted.ability).toBe('deploy')
    expect(running.status).toBe('running')
    expect(running.interruptedAt).toBeUndefined()
  })
})

describe('buildNotice', () => {
  it('matches the v1 injection text for a running script step', () => {
    const notice = buildNotice({ ability: 'deploy', stepId: 'build', stepType: 'script' }, { completed: 2, total: 5 })
    expect(notice).toContain('## 🔄 Active Ability: deploy')
    expect(notice).toContain('**Progress:** 2/5 steps completed')
    expect(notice).toContain('### Current Step: build')
    expect(notice).toContain('⚠️ **ENFORCEMENT ACTIVE**')
  })

  it('omits progress when not provided', () => {
    const notice = buildNotice({ ability: 'a', stepId: 'b', stepType: 'script' })
    expect(notice).not.toContain('Progress:')
  })
})

describe('runGuarded (strict policy)', () => {
  const denial = () => {
    throw new EnforcementDenialError('Tool blocked')
  }
  const internal = () => {
    throw new TypeError('storage exploded')
  }

  it('always propagates enforcement denials', async () => {
    await expect(runGuarded(true, denial)).rejects.toBeInstanceOf(EnforcementDenialError)
    await expect(runGuarded(false, denial)).rejects.toBeInstanceOf(EnforcementDenialError)
    expect(new EnforcementDenialError('Tool blocked').message).toBe('[abilities] Tool blocked')
  })

  it('fail-closed: rethrows internal errors in strict mode', async () => {
    await expect(runGuarded(true, internal)).rejects.toBeInstanceOf(TypeError)
  })

  it('fail-open: swallows internal errors in non-strict mode', async () => {
    const logged: unknown[] = []
    const result = await runGuarded(false, internal, e => logged.push(e))
    expect(result).toBeUndefined()
    expect(logged.length).toBe(1)
  })

  it('passes through values and works with sync callbacks', async () => {
    expect(await runGuarded(true, () => 42)).toBe(42)
    expect(await runGuarded(true, () => 'sync')).toBe('sync')
  })

  it('reports internal errors via onError before rethrowing in strict mode', async () => {
    const logged: unknown[] = []
    await expect(runGuarded(true, internal, e => logged.push(e))).rejects.toBeInstanceOf(TypeError)
    expect(logged.length).toBe(1)
  })
})
