import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stagedFindings, commitFindings } from './secrets.mjs';
import { readJson, applications } from '../lib/store.mjs';
import { validateAll, submissionState } from '../lib/workflow.mjs';
import { isLocalOnlyPath } from '../lib/repository-policy.mjs';
import { assertTemplateData } from '../lib/template-policy.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
try {
  const root = git('rev-parse', '--show-toplevel');
  process.chdir(root);
  const policy = readJson('repository.json');
  if (!['public-template', 'private'].includes(policy.mode)) throw new Error('repository.json 모드가 유효하지 않습니다.');
  const command = process.argv[2];
  if (command === 'commit') {
    const findings = stagedFindings();
    const addedPaths = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0');
    if (addedPaths.some(isLocalOnlyPath)) throw new Error('개인 작업 이력과 .local 파일은 commit할 수 없습니다.');
    if (policy.mode === 'public-template' && addedPaths.some(p => p.startsWith('content/'))) {
      assertTemplateData(addedPaths, p => execFileSync('git', ['show', ':' + p]), JSON.parse(git('show', ':template-data.json')));
    }
    if (findings.length) throw new Error(`비밀정보 감지: ${findings.map(f => `${f.file} (${f.reason})`).join(', ')}`);
  } else if (command === 'authorize') {
    if (!process.argv.includes('--confirm-human')) throw new Error('사용자의 명시적 push 승인 후 --confirm-human을 지정하세요.');
    const origin = git('remote', 'get-url', '--push', 'origin');
    fs.mkdirSync('.local', { recursive: true });
    fs.writeFileSync('.local/push-approval.json', JSON.stringify({ head: git('rev-parse', 'HEAD'), origin, expires: Date.now() + 15 * 60 * 1000 }));
    console.log('현재 HEAD와 origin에 대한 15분 유효 승인 기록. 다음 push 시 1회 사용됩니다.');
  } else if (command === 'push') {
    const [, , , remote, url] = process.argv;
    if (remote !== 'origin') throw new Error('origin 외 push 금지');
    const lines = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
    const head = git('rev-parse', 'HEAD');
    const approvalPath = path.join(root, '.local/push-approval.json');
    const approval = readJson(approvalPath);
    if (approval.head !== head || approval.origin !== url || approval.expires < Date.now()) throw new Error('현재 HEAD·origin에 대한 유효한 사람 승인 필요');
    if (lines.length !== 1) throw new Error('한 번에 하나의 브랜치만 push 가능');
    const [localRef, localSha, remoteRef, remoteSha] = lines[0].split(/\s+/);
    if (localSha !== head || !localRef.startsWith('refs/heads/') || !remoteRef.startsWith('refs/heads/')) throw new Error('현재 HEAD 브랜치만 push 가능; 삭제·태그 push 금지');
    const newBranch = /^0+$/.test(remoteSha);
    if (!newBranch) {
      execFileSync('git', ['merge-base','--is-ancestor',remoteSha,localSha]);
    }
    const revisions = git('rev-list', newBranch ? localSha : `${remoteSha}..${localSha}`).split('\n').filter(Boolean);
    const findings = commitFindings(revisions);
    if (findings.length) throw new Error(`전송 이력에 비밀정보 감지: ${findings.map(f => f.file).join(', ')}`);
    for (const rev of revisions) {
      const paths = git('ls-tree','-r','--name-only', rev).split('\n');
      if (paths.some(isLocalOnlyPath)) throw new Error('전송 이력에 개인 작업 기록이 포함되어 있습니다.');
      if (policy.mode === 'public-template' && paths.some(p => p.startsWith('content/'))) {
        assertTemplateData(paths, p => execFileSync('git', ['show', rev + ':' + p]), JSON.parse(git('show', rev + ':template-data.json')));
      }
    }
    if (git('status','--porcelain')) throw new Error('작업 트리를 정리한 뒤 push하세요.');
    const validation = validateAll();
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    if (policy.mode === 'private') for (const app of applications()) {
      if (app.revision > 0 && !submissionState(app.id).approved) throw new Error(`${app.id}: 현재 이력서 사람 승인 필요`);
    }
    fs.unlinkSync(approvalPath);
  } else throw new Error('알 수 없는 Git guard 명령');
} catch (error) { console.error('Git 작업 차단:', error.message.split('\n')[0]); process.exitCode = 1; }
