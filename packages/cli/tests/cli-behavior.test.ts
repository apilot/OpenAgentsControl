import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

/**
 * Regression tests for CLI exit-code behavior.
 *
 * Replaces the deprecated commander `command:*` event handler:
 * unknown commands must fail loudly (exit 1 + hint), while help and
 * version paths must succeed (exit 0).
 */

const CLI = new URL('../src/index.ts', import.meta.url).pathname

function runCli(...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  })
}

describe('cli behavior (exit codes)', () => {
  test('unknown command: exit 1, error message and --help hint on stderr', () => {
    const r = runCli('definitely-not-a-command')
    expect(r.status).toBe(1)
    expect(String(r.stderr)).toContain("unknown command 'definitely-not-a-command'")
    expect(String(r.stderr)).toContain("Run 'oac --help' to see available commands.")
  })

  test('--help: exit 0 and usage on stdout', () => {
    const r = runCli('--help')
    expect(r.status).toBe(0)
    expect(String(r.stdout)).toContain('Usage')
  })

  test('no arguments: exit 0 and usage on stdout', () => {
    const r = runCli()
    expect(r.status).toBe(0)
    expect(String(r.stdout)).toContain('Usage')
  })

  test('-v: exit 0 and semver on stdout', () => {
    const r = runCli('-v')
    expect(r.status).toBe(0)
    expect(String(r.stdout).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
