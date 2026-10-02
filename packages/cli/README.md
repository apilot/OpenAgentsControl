# @nextsystems/oac-cli

OAC CLI — install, manage, and update AI agents and context files.

## Development

```bash
bun install        # from the repository root (workspace)
bun run dev        # run the CLI from source
bun test           # run tests
bun run typecheck  # tsc --noEmit
```

Typechecking resolves `@openagents-control/compatibility-layer` directly from
its TypeScript sources (`../compatibility-layer/src/index.ts` via tsconfig
`paths`), so no prebuilt `dist/` output of workspace dependencies is required.
Emitting is done by `bun build` (see `build` script); `tsc` is typecheck-only.
