import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
try {
  const root = execFileSync('git', ['rev-parse','--show-toplevel'], { encoding:'utf8' }).trim();
  if (path.resolve(root) !== process.cwd()) throw new Error('career-hub 자체 저장소 루트에서 실행하세요.');
  let existing = '';
  try { existing = execFileSync('git', ['config','--get','core.hooksPath'], { encoding:'utf8' }).trim(); } catch {}
  if (existing && existing !== '.githooks') throw new Error('기존 hooksPath가 있습니다. 수동으로 병합하세요.');
  const defaultHooks = execFileSync('git',['rev-parse','--git-path','hooks'],{encoding:'utf8'}).trim();
  for (const name of ['pre-commit','pre-push']) {
    if (!existing && fs.existsSync(path.join(defaultHooks,name))) throw new Error(`기존 ${name} Hook이 있습니다. 수동 병합 필요`);
    fs.chmodSync(`.githooks/${name}`, 0o755);
  }
  execFileSync('git',['config','core.hooksPath','.githooks']);
  console.log('pre-commit / pre-push Hook 설치 완료');
} catch (error) { console.error(error.message); process.exitCode = 1; }
