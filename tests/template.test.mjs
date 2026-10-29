import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isLocalOnlyPath } from '../lib/repository-policy.mjs';
import { assertTemplateData } from '../lib/template-policy.mjs';
import { careers } from '../lib/store.mjs';
import { sourceStatus } from '../lib/source-approval.mjs';
import { verify, submissionState, validateAll } from '../lib/workflow.mjs';

test('기본 콘텐츠는 확인 기록과 함께 복제되며 최종 승인은 별도다', t => {
  const root = fixture(t);
  fs.cpSync('content', path.join(root, 'content'), { recursive: true });
  assert.ok(careers(root).every(c => sourceStatus(c, root).usable));
  assert.equal(verify('main-sample', root).passed, true);
  assert.equal(submissionState('main-sample', root).approved, false);
  assert.equal(submissionState('main-sample', root).downloadable, false);
  assert.deepEqual(validateAll(root).errors, []);
});
test('확인이 만료된 초안도 조회·빌드할 수 있지만 리뷰·다운로드는 잠긴다', t => {
  const root = fixture(t);
  fs.cpSync('content', path.join(root, 'content'), { recursive: true });
  fs.appendFileSync(path.join(root, 'content/career/verified/companies/morrow.md'), '\n추가 확인이 필요한 기록');
  assert.deepEqual(validateAll(root).errors, []);
  assert.equal(verify('northstar-backend', root).passed, false);
  assert.equal(submissionState('northstar-backend', root).downloadable, false);
  fs.appendFileSync(path.join(root, 'content/applications/northstar-backend/resume.md'), '\n출처에 없는 성과');
  assert.notDeepEqual(validateAll(root).errors, []);
});

test('공개 데이터는 등록된 샘플만 허용하고 수정·추가된 개인 자료는 차단한다', () => {
  const manifest = JSON.parse(fs.readFileSync('template-data.json', 'utf8'));
  assert.doesNotThrow(() => assertTemplateData(Object.keys(manifest), p => fs.readFileSync(p), manifest));
  assert.throws(() => assertTemplateData(['content/career/pending/personal.md'], () => '개인 기록', manifest), /등록되지 않은/);
  assert.throws(() => assertTemplateData([Object.keys(manifest)[0]], () => '변경한 개인 자료', manifest), /변경된 데이터/);
  assert.doesNotThrow(() => assertTemplateData(['README.md'], () => '문서', manifest));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('Git은 개인 기록을 제외하며 강제 staged한 기록도 guard가 거부한다', t => {
  const root = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init');
  fs.copyFileSync('.gitignore', path.join(root, '.gitignore'));
  fs.mkdirSync(path.join(root, '.local'));
  fs.mkdirSync(path.join(root, 'templates'));
  fs.writeFileSync(path.join(root, '.local/WORK_LOG.md'), 'local history');
  fs.writeFileSync(path.join(root, 'WORK_LOG.md'), 'legacy history');
  fs.writeFileSync(path.join(root, 'templates/work-log.md'), 'blank template');
  fs.writeFileSync(path.join(root, 'repository.json'), JSON.stringify({ mode: 'public-template' }));
  assert.match(git('check-ignore', '.local/WORK_LOG.md', 'WORK_LOG.md'), /\.local\/WORK_LOG\.md/);
  git('add', '.');
  const tracked = git('ls-files');
  assert.ok(!tracked.includes('WORK_LOG.md'));
  assert.ok(tracked.includes('templates/work-log.md'));
  git('add', '-f', '.local/WORK_LOG.md');
  const result = spawnSync(process.execPath, [path.resolve('scripts/git-guard.mjs'), 'commit'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /개인 작업 이력/);
  assert.equal(isLocalOnlyPath('.local\\WORK_LOG.md'), true);
  assert.equal(isLocalOnlyPath('WORK_LOG.backup.md'), true);
  assert.equal(isLocalOnlyPath('templates/work-log.md'), false);
});
test('새 작업 기록을 만들고 재실행해도 기존 기록을 보존한다', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'templates'));
  fs.copyFileSync('templates/work-log.md', path.join(root, 'templates/work-log.md'));
  const script = path.resolve('scripts/init-worklog.mjs');
  execFileSync(process.execPath, [script], { cwd: root });
  const file = path.join(root, '.local/WORK_LOG.md');
  assert.match(fs.readFileSync(file, 'utf8'), /순서별 체크리스트/);
  fs.appendFileSync(file, '\nkeep existing progress');
  execFileSync(process.execPath, [script], { cwd: root });
  assert.match(fs.readFileSync(file, 'utf8'), /keep existing progress/);
});
test('README CLI 예제가 단일 데이터 경로로 생성·검증된다', t => {
  const root = fixture(t);
  fs.cpSync('content', path.join(root, 'content'), { recursive: true });
  fs.copyFileSync('.env.example', path.join(root, '.env'));
  const env = { ...process.env };
  delete env.PORT;
  const run = args => JSON.parse(execFileSync(process.execPath, ['--env-file-if-exists=.env', path.resolve('scripts/cli.mjs'), ...args], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(run(['new', '--id', 'tutorial-backend', '--company', '튜토리얼 가상 회사', '--position', 'Backend Engineer', '--jd', path.resolve('templates/jd.md'), '--keywords', 'Kotlin,MySQL']).status, 'draft');
  assert.equal(run(['generate', 'tutorial-backend']).status, 'awaiting_human_approval');
  assert.equal(run(['verify', 'tutorial-backend']).passed, true);
  const override = execFileSync(process.execPath, ['--env-file-if-exists=.env', '-e', 'process.stdout.write(process.env.PORT)'], { cwd: root, env: { ...env, PORT: '5432' }, encoding: 'utf8' });
  assert.equal(override, '5432');
});
test('공유 소스에는 사용자 홈 절대 경로가 없다', () => {
  const excluded = new Set(['node_modules', '.git', '.local', '.astro', '.idea', 'dist', 'coverage']);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (excluded.has(e.name) || e.isSymbolicLink() || /^\.env(?:\.|$)/.test(e.name) && e.name !== '.env.example') return [];
    const file = path.join(dir, e.name);
    return e.isDirectory() ? walk(file) : [file];
  });
  const userPath = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)/;
  for (const file of walk('.')) assert.equal(userPath.test(fs.readFileSync(file, 'utf8')), false, file);
});
