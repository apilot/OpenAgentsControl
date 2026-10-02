#!/usr/bin/env node

import { Command, CommanderError } from 'commander'
import { readCliVersion } from './lib/version.js'

const program = new Command()

program
  .name('oac')
  .description('OpenAgents Control — install, manage, and update AI agents and context files')
  .version(readCliVersion(), '-v, --version', 'Print version and exit')

// Throw CommanderError instead of calling process.exit, so main() can
// translate error codes into exit codes (replaces deprecated `command:*`).
program.exitOverride()

// Lazy-load command modules in parallel — keeps startup < 100ms
async function main(): Promise<void> {
  // Fast path: --version only — --help needs all commands registered first
  const args = process.argv.slice(2)
  const isFastPath =
    args.includes('--version') || args.includes('-v')

  const run = async (): Promise<void> => {
    // No command given: print help to stdout and exit successfully.
    // (Otherwise commander v12 would treat it as an error-help and write to stderr.)
    if (args.length === 0) {
      program.outputHelp()
      return
    }

    if (isFastPath) {
      await program.parseAsync(process.argv)
      return
    }

    const [
      { registerInitCommand },
      { registerUpdateCommand },
      { registerAddCommand },
      { registerApplyCommand },
      { registerDoctorCommand },
      { registerListCommand },
      { registerStatusCommand },
    ] = await Promise.all([
      import('./commands/init.js'),
      import('./commands/update.js'),
      import('./commands/add.js'),
      import('./commands/apply.js'),
      import('./commands/doctor.js'),
      import('./commands/list.js'),
      import('./commands/status.js'),
    ])

    registerInitCommand(program)
    registerUpdateCommand(program)
    registerAddCommand(program) // also registers `remove`
    registerApplyCommand(program)
    registerDoctorCommand(program)
    registerListCommand(program)
    registerStatusCommand(program)

    await program.parseAsync(process.argv)
  }

  try {
    await run()
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already written the message to stderr for error paths.
      switch (err.code) {
        case 'commander.unknownCommand':
          console.error(`\nRun 'oac --help' to see available commands.`)
          process.exitCode = 1
          return
        case 'commander.helpDisplayed':
        case 'commander.version':
        case 'commander.help':
          process.exitCode = 0
          return
        default:
          process.exitCode = err.exitCode || 1
          return
      }
    }
    throw err
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
