import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('scenes');
const destination = resolve('dist', 'scenes');

if (!existsSync(source)) {
    throw new Error(`Scene source directory is missing: ${source}`);
}

// Node's filesystem API keeps the production asset copy identical on Windows,
// Linux CI, and macOS instead of depending on each shell's `cp` command.
cpSync(source, destination, { recursive: true, force: true });
