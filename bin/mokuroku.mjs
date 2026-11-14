#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = resolve(rootDir, 'src', 'cli.ts');
const tsxCli = resolve(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', '--use-env-proxy', tsxCli, cliEntry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost'
    }
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
