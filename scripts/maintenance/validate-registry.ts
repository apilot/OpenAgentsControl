/**
 * Registry linter for registry.json
 *
 * Validates the installer registry against the invariants the installer and
 * downstream tooling rely on. Surgical port of the *intent* of upstream PR #359
 * (whose wholesale diff was repo-incompatible):
 *
 *   1. Schema      — required top-level keys and per-component fields
 *   2. Dependencies — every component carries a `dependencies` array
 *   3. Cycles      — no component depends on itself
 *   4. References  — every dependency resolves (wildcards expanded in-registry)
 *   5. Artifacts   — no generator debris in descriptions
 *   6. Profiles    — every profile component reference resolves
 *
 * Usage:
 *   bun run scripts/maintenance/validate-registry.ts [registryPath]
 *   node  scripts/maintenance/validate-registry.ts [registryPath]
 *
 * Exit codes: 0 = valid, 1 = violations found, 2 = load error.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface RegistryComponent {
  id?: string
  name?: string
  type?: string
  path?: string
  description?: string
  dependencies?: unknown
  [key: string]: unknown
}

interface Registry {
  components?: Record<string, unknown>
  profiles?: Record<string, unknown>
  metadata?: Record<string, unknown>
  subagents?: Record<string, unknown>
  [key: string]: unknown
}

export interface Violation {
  rule: string
  location: string
  message: string
}

export interface LintResult {
  valid: boolean
  violations: Violation[]
  stats: { categories: number; components: number; profiles: number }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function entriesOf(value: unknown): RegistryComponent[] {
  if (Array.isArray(value)) return value.filter((v): v is RegistryComponent => typeof v === 'object' && v !== null)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).filter((v): v is RegistryComponent => typeof v === 'object' && v !== null)
  }
  return []
}

/** Collect `id -> component` across all component categories. */
export function indexComponents(registry: Registry): Map<string, RegistryComponent> {
  const index = new Map<string, RegistryComponent>()
  for (const category of Object.values(registry.components ?? {})) {
    for (const component of entriesOf(category)) {
      if (typeof component.id === 'string') index.set(component.id, component)
    }
  }
  return index
}

// ─────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────

function checkSchema(registry: Registry): Violation[] {
  const violations: Violation[] = []
  for (const key of ['components', 'profiles', 'metadata', 'subagents'] as const) {
    if (typeof registry[key] !== 'object' || registry[key] === null) {
      violations.push({ rule: 'schema', location: `$.${key}`, message: `missing required top-level key "${key}"` })
    }
  }
  for (const [category, value] of Object.entries(registry.components ?? {})) {
    for (const component of entriesOf(value)) {
      for (const field of ['id', 'name', 'type', 'path'] as const) {
        if (typeof component[field] !== 'string' || !component[field]) {
          violations.push({
            rule: 'schema',
            location: `components.${category}`,
            message: `component missing or empty "${field}"${component.id ? ` (id: ${component.id})` : ''}`,
          })
        }
      }
    }
  }
  return violations
}

function checkDependenciesField(registry: Registry): Violation[] {
  const violations: Violation[] = []
  for (const [category, value] of Object.entries(registry.components ?? {})) {
    for (const component of entriesOf(value)) {
      if (!Array.isArray(component.dependencies)) {
        violations.push({
          rule: 'dependencies-field',
          location: `components.${category}:${component.id ?? '?'}`,
          message: '"dependencies" key missing or not an array',
        })
      }
    }
  }
  return violations
}

function checkSelfDependency(registry: Registry): Violation[] {
  const violations: Violation[] = []
  for (const [category, value] of Object.entries(registry.components ?? {})) {
    for (const component of entriesOf(value)) {
      const id = component.id
      if (typeof id !== 'string') continue
      for (const dep of (component.dependencies as unknown[]) ?? []) {
        if (typeof dep !== 'string') continue
        const depId = dep.includes(':') ? dep.slice(dep.indexOf(':') + 1) : dep
        if (depId === id) {
          violations.push({ rule: 'self-dependency', location: `components.${category}:${id}`, message: `depends on itself via "${dep}"` })
        }
      }
    }
  }
  return violations
}

/**
 * A dependency resolves when its bare id exists in the component index, or —
 * for context wildcards — when at least one registered context component's
 * path lives under the wildcard prefix (mirrors install.sh's
 * expand_context_wildcard, which matches against registry paths).
 */
export function resolvesDependency(dep: string, index: Map<string, RegistryComponent>): boolean {
  const sep = dep.indexOf(':')
  const type = sep === -1 ? '' : dep.slice(0, sep)
  const id = sep === -1 ? dep : dep.slice(sep + 1)

  if (id.includes('*') && type === 'context') {
    const prefix = `.opencode/context/${id.replace(/\*.*$/, '')}`
    for (const component of index.values()) {
      if (component.type === 'context' && typeof component.path === 'string' && component.path.startsWith(prefix)) {
        return true
      }
    }
    return false
  }
  return index.has(id)
}

function checkDanglingReferences(registry: Registry, index: Map<string, RegistryComponent>): Violation[] {
  const violations: Violation[] = []
  for (const [category, value] of Object.entries(registry.components ?? {})) {
    for (const component of entriesOf(value)) {
      for (const dep of (component.dependencies as unknown[]) ?? []) {
        if (typeof dep !== 'string') continue
        if (!resolvesDependency(dep, index)) {
          violations.push({ rule: 'dangling-reference', location: `components.${category}:${component.id}`, message: `dependency "${dep}" resolves to nothing` })
        }
      }
    }
  }
  return violations
}

function checkDescriptionArtifacts(registry: Registry): Violation[] {
  const violations: Violation[] = []
  const artifact = /\\+$|\\"$|^\s*\.\.\./
  for (const [category, value] of Object.entries(registry.components ?? {})) {
    for (const component of entriesOf(value)) {
      const description = component.description
      if (typeof description === 'string' && artifact.test(description)) {
        violations.push({ rule: 'description-artifact', location: `components.${category}:${component.id}`, message: `generator debris in description: ${JSON.stringify(description.slice(0, 60))}` })
      }
    }
  }
  return violations
}

function checkProfiles(registry: Registry, index: Map<string, RegistryComponent>): Violation[] {
  const violations: Violation[] = []
  for (const [profileName, profileValue] of Object.entries(registry.profiles ?? {})) {
    if (typeof profileValue !== 'object' || profileValue === null) continue
    const profile = profileValue as Record<string, unknown>
    const refs = Array.isArray(profile.components) ? profile.components : []
    for (const ref of refs) {
      if (typeof ref !== 'string') continue
      const sep = ref.indexOf(':')
      const type = sep === -1 ? '' : ref.slice(0, sep)
      const id = sep === -1 ? ref : ref.slice(sep + 1)
      if (id.includes('*') && type === 'context') {
        if (!resolvesDependency(ref, index)) {
          violations.push({ rule: 'profile-reference', location: `profiles.${profileName}`, message: `wildcard "${ref}" matches no context component` })
        }
        continue
      }
      if (!index.has(id)) {
        violations.push({ rule: 'profile-reference', location: `profiles.${profileName}`, message: `reference "${ref}" resolves to no component` })
      }
    }
  }
  return violations
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export function lintRegistry(registry: Registry): LintResult {
  const index = indexComponents(registry)
  const violations: Violation[] = [
    ...checkSchema(registry),
    ...checkDependenciesField(registry),
    ...checkSelfDependency(registry),
    ...checkDanglingReferences(registry, index),
    ...checkDescriptionArtifacts(registry),
    ...checkProfiles(registry, index),
  ]
  const componentCount = index.size
  return {
    valid: violations.length === 0,
    violations,
    stats: { categories: Object.keys(registry.components ?? {}).length, components: componentCount, profiles: Object.keys(registry.profiles ?? {}).length },
  }
}

function main(): void {
  const path = resolve(process.argv[2] ?? 'registry.json')
  if (!existsSync(path)) {
    console.error(`✗ registry not found: ${path}`)
    process.exit(2)
  }
  let registry: Registry
  try {
    registry = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`✗ failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  const result = lintRegistry(registry)
  console.log(`Registry: ${path}`)
  console.log(`  categories: ${result.stats.categories}, components: ${result.stats.components}, profiles: ${result.stats.profiles}`)

  if (result.valid) {
    console.log('✓ registry valid — no violations')
    return
  }
  console.error(`✗ ${result.violations.length} violation(s):`)
  for (const v of result.violations) {
    console.error(`  [${v.rule}] ${v.location}: ${v.message}`)
  }
  process.exit(1)
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.path.replace('file://', '')
if (isDirectRun || (process.argv[1]?.endsWith('validate-registry.ts') && typeof Bun !== 'undefined')) {
  main()
}
