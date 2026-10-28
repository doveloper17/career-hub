import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = process.argv.includes('--live') ? 'tests/integration' : 'tests';
const files = fs.readdirSync(dir).filter(name => name.endsWith('.test.mjs')).map(name => path.join(dir, name));
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit', env: { ...process.env },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
