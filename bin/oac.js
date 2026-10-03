#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const cliDist = path.join(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');

if (!fs.existsSync(cliDist)) {
  console.error('Error: OAC CLI not built yet. Run: npm run build -w packages/cli');
  process.exit(1);
}

// Dev/monorepo mode: the CLI's package-root walk (packages/cli/src/lib/bundled.ts)
// excludes the monorepo root by design (registry.json marker), so point it at the
// repo root explicitly. Production npm installs resolve the package root on their
// own; an already-set OAC_PACKAGE_ROOT takes precedence.
process.env.OAC_PACKAGE_ROOT = process.env.OAC_PACKAGE_ROOT || path.join(__dirname, '..');

try {
  execFileSync('bun', [cliDist, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('Error: Bun is required to run OAC CLI. Install from https://bun.sh');
    process.exit(1);
  }
  process.exitCode = err.status ?? 1;
}
