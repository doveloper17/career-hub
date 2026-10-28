import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rules = [
  ['개인 키', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['서비스 토큰', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['AWS 액세스 키', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['인증 정보 포함 URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['비밀정보 할당', /(?:api[_-]?key|access[_-]?token|secret|password|passwd|client[_-]?secret)\s*["']?\s*[:=]\s*["']?([A-Za-z0-9+_/.=-]{12,})/i],
];
export function inspect(name, content) {
  const findings = [];
  if (/(^|\/)\.env(?:\.|$)/.test(name) && !name.endsWith('.env.example')) findings.push({ file: name, reason: '환경변수 파일' });
  if (/\.(pem|key|p12|pfx)$/.test(name)) findings.push({ file: name, reason: '키 파일' });
  for (const [reason, pattern] of rules) if (pattern.test(content)) findings.push({ file: name, reason });
  return findings;
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function scanBlobs(names, read) { return names.flatMap(name => inspect(name, read(name))); }
export function stagedFindings() {
  const names = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  return scanBlobs(names, name => git('show', `:${name}`));
}
export function commitFindings(revisions) {
  const seen = new Set(); const findings = [];
  for (const rev of revisions) {
    if (!/^[a-f0-9]{40,64}$/.test(rev)) throw new Error('유효하지 않은 커밋');
    const names = git('ls-tree', '-r', '--name-only', '-z', rev).split('\0').filter(Boolean);
    for (const name of names) {
      const oid = git('rev-parse', `${rev}:${name}`).trim();
      if (seen.has(`${name}:${oid}`)) continue;
      seen.add(`${name}:${oid}`);
      findings.push(...inspect(name, git('show', `${rev}:${name}`)));
    }
  }
  return findings;
}
export function workspaceFindings(root = process.cwd()) {
  const ignore = new Set(['node_modules', '.git', '.astro', 'dist', '.local']);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (ignore.has(e.name) || e.isSymbolicLink()) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : inspect(path.relative(root,p), fs.readFileSync(p, 'utf8'));
  });
  return walk(root);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = process.argv.includes('--staged') ? stagedFindings() : workspaceFindings();
    console.log(JSON.stringify({ passed: !results.length, findings: results }, null, 2));
    if (results.length) process.exitCode = 1;
  } catch (error) { console.error('Secret 검사 실패:', error.message.split('\n')[0]); process.exitCode = 1; }
}
