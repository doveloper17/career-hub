import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { roles, resultSchema, RESULT_CONTRACT_VERSION } from './agent-contract.mjs';
import { projectRoot, roleExecution, roleInstructions } from './agent-definition.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const executionVersionSchema = z.object({
  fingerprint: sha, sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  codeDigest: sha, rulesDigest: sha, contractVersion: z.number().int().positive(), nodeVersion: z.string(),
  modelOverride: z.string().regex(/^[a-zA-Z0-9._-]+$/).nullable(),
  roles: z.array(z.object({ role: z.enum(roles), model: z.string(), effort: z.string(), promptDigest: sha, schemaDigest: sha })).length(4),
});

// Hash actual runtime files, not the user's career data, logs, Git origin, or machine paths.
export function captureExecutionVersion(modelOverride, root = projectRoot) {
  const codePaths = [...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.mjs')).map(f => 'lib/' + f),
    'scripts/workflow.mjs', 'scripts/agents.mjs', 'scripts/secrets.mjs', 'package.json', 'package-lock.json'].sort();
  const rulePaths = ['AGENTS.md', 'docs/SUBAGENTS.md', 'docs/REVIEWS.md', 'docs/PERMISSIONS.md',
    ...roles.map(role => '.codex/agents/' + role + '.toml')].sort();
  const fileDigest = paths => digest(JSON.stringify(paths.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])));
  let sourceCommit = null;
  try {
    const gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (fs.realpathSync(gitRoot) === fs.realpathSync(root)) sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch { /* Cloned/exported code without Git still has an actual file fingerprint. */ }
  const configuration = {
    codeDigest: fileDigest(codePaths), rulesDigest: fileDigest(rulePaths),
    contractVersion: RESULT_CONTRACT_VERSION, nodeVersion: process.version,
    roles: roles.map(role => {
      const execution = roleExecution(role, modelOverride, root);
      return { role, model: execution.model, effort: execution.effort,
        promptDigest: digest(roleInstructions(execution, root)), schemaDigest: digest(JSON.stringify(z.toJSONSchema(resultSchema(role)))) };
    }),
  };
  // Commit ID is provenance only: a docs-only commit must not invalidate identical runtime files.
  return executionVersionSchema.parse({ ...configuration, sourceCommit, modelOverride: modelOverride ?? null,
    fingerprint: digest(JSON.stringify(configuration)) });
}
