/**
 * Tests for scripts/maintenance/validate-registry.ts
 *
 * Covers each lint rule against both the real repository registry and
 * synthetic fixtures that isolate one violation class at a time.
 *
 * Run: npx -y bun test scripts/maintenance/validate-registry.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { lintRegistry, indexComponents, resolvesDependency, type Registry } from './validate-registry.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const REAL_REGISTRY: Registry = JSON.parse(readFileSync(resolve(REPO_ROOT, 'registry.json'), 'utf8'))

function baseRegistry(): Registry {
  return {
    components: {
      contexts: [
        { id: 'alpha', name: 'Alpha', type: 'context', path: '.opencode/context/core/alpha.md', description: 'Alpha context', dependencies: [] },
        { id: 'beta', name: 'Beta', type: 'context', path: '.opencode/context/core/beta.md', description: 'Beta context', dependencies: ['context:alpha'] },
      ],
      config: [{ id: 'env-example', name: 'Env', type: 'config', path: 'env.example', description: 'Env template', dependencies: [] }],
    },
    profiles: {
      essential: { name: 'Essential', components: ['context:alpha', 'config:env-example'] },
    },
    metadata: { lastUpdated: '2026-10-01', schemaVersion: '2.0.0' },
    subagents: {},
  }
}

describe('lintRegistry — real repository registry', () => {
  const result = lintRegistry(REAL_REGISTRY)

  it('is valid', () => {
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('indexes a non-trivial component set', () => {
    expect(result.stats.components).toBeGreaterThan(50)
    expect(result.stats.categories).toBeGreaterThan(3)
    expect(result.stats.profiles).toBeGreaterThan(3)
  })
})

describe('rule: schema', () => {
  it('flags missing top-level keys', () => {
    const registry: Registry = { components: {}, profiles: {}, metadata: {} }
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'schema' && v.message.includes('subagents'))).toBe(true)
  })

  it('flags components missing required fields', () => {
    const registry = baseRegistry()
    ;(registry.components!.contexts as Array<Record<string, unknown>>)[0] = { id: 'alpha', type: 'context' }
    const result = lintRegistry(registry)
    expect(result.violations.filter((v) => v.rule === 'schema').length).toBeGreaterThanOrEqual(2) // name + path
  })
})

describe('rule: dependencies-field', () => {
  it('flags components without a dependencies array', () => {
    const registry = baseRegistry()
    delete (registry.components!.contexts as Array<Record<string, unknown>>)[1].dependencies
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'dependencies-field' && v.location.includes('beta'))).toBe(true)
  })
})

describe('rule: self-dependency', () => {
  it('flags a component depending on itself with and without prefix', () => {
    const registry = baseRegistry()
    ;(registry.components!.contexts as Array<Record<string, unknown>>)[1].dependencies = ['context:beta', 'beta']
    const result = lintRegistry(registry)
    const hits = result.violations.filter((v) => v.rule === 'self-dependency')
    expect(hits.length).toBe(2)
  })
})

describe('rule: dangling-reference', () => {
  it('flags unknown dependency ids', () => {
    const registry = baseRegistry()
    ;(registry.components!.contexts as Array<Record<string, unknown>>)[1].dependencies = ['context:nonexistent']
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'dangling-reference' && v.message.includes('nonexistent'))).toBe(true)
  })
})

describe('rule: description-artifact', () => {
  it('flags trailing escaped-quote debris (the #359 artifact class)', () => {
    const registry = baseRegistry()
    ;(registry.components!.contexts as Array<Record<string, unknown>>)[0].description = '{domain} orchestrator for {primary_purpose}\\"'
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'description-artifact' && v.location.includes('alpha'))).toBe(true)
  })

  it('flags leading ellipsis debris', () => {
    const registry = baseRegistry()
    ;(registry.components!.contexts as Array<Record<string, unknown>>)[0].description = '...truncated junk'
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'description-artifact')).toBe(true)
  })

  it('accepts clean placeholder-style descriptions', () => {
    const registry = baseRegistry()
    ;(registry.components!.contexts as Array<Record<string, unknown>>)[0].description = '{domain} orchestrator for {primary_purpose}'
    expect(lintRegistry(registry).violations).toEqual([])
  })
})

describe('rule: profile-reference', () => {
  it('flags profile refs that resolve to no component', () => {
    const registry = baseRegistry()
    registry.profiles!.essential = { name: 'Essential', components: ['agent:ghost'] }
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'profile-reference' && v.message.includes('ghost'))).toBe(true)
  })

  it('accepts context wildcards with at least one registry match', () => {
    const registry = baseRegistry()
    registry.profiles!.essential = { name: 'Essential', components: ['context:core/*'] }
    expect(lintRegistry(registry).violations).toEqual([])
  })

  it('flags context wildcards with no registry match', () => {
    const registry = baseRegistry()
    registry.profiles!.essential = { name: 'Essential', components: ['context:nowhere/*'] }
    const result = lintRegistry(registry)
    expect(result.violations.some((v) => v.rule === 'profile-reference' && v.message.includes('nowhere'))).toBe(true)
  })
})

describe('resolvesDependency / indexComponents', () => {
  const index = indexComponents(baseRegistry())

  it('indexes by bare id', () => {
    expect(index.has('alpha')).toBe(true)
    expect(index.has('env-example')).toBe(true)
  })

  it('resolves plain ids only when they exist', () => {
    expect(resolvesDependency('context:alpha', index)).toBe(true)
    expect(resolvesDependency('context:missing', index)).toBe(false)
  })

  it('resolves nested context wildcards via registry paths', () => {
    expect(resolvesDependency('context:core/*', index)).toBe(true)
    expect(resolvesDependency('context:core/context-system/*', index)).toBe(false)
  })
})
