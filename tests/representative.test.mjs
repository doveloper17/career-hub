import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApplication, generate, verify, validateAll, approve, snapshot } from '../lib/workflow.mjs';
import { review as recordReview } from './review-fixture.mjs';
import { careers, appDir } from '../lib/store.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-representative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('tests/fixtures/template-content/career', path.join(root, 'content/career'), { recursive: true });
  fs.cpSync('tests/fixtures/template-content/source-approvals', path.join(root, 'content/source-approvals'), { recursive: true });
  return root;
}
const base = { id: 'main-resume', kind: 'representative', title: '대표 이력서', company: '', position: '', keywords: [], createdAt: '2026-10-28', deadline: null, jdUrl: null, };
test('대표 이력서는 회사·JD·키워드 없이 전체 확인 경력으로 생성한다', t => {
  const root = setup(t);
  createApplication(base, '', root);
  assert.equal(generate(base.id, root).selected, careers(root).length);
  assert.equal(verify(base.id, root).passed, true);
  assert.deepEqual(validateAll(root).errors, []);
  assert.match(fs.readFileSync(path.join(appDir(base.id, root), 'resume.md'), 'utf8'), /^# 대표 이력서/);
});
test('대표 이력서는 회사만 또는 JD만 연결할 수 있다', t => {
  const root = setup(t);
  createApplication({ ...base, company: '가상 회사' }, '', root);
  generate(base.id, root);
  createApplication({ ...base, id: 'targeted', keywords: ['Kotlin'] }, 'Kotlin 가상 JD', root);
  assert.equal(generate('targeted', root).selected, 1);
  assert.equal(verify('targeted', root).passed, true);
});
test('일반 지원의 필수 입력과 대표 제목 검증을 유지한다', t => {
  const root = setup(t);
  assert.throws(() => createApplication({ ...base, title: '' }, '', root));
  assert.throws(() => createApplication({ ...base, kind: 'application' }, '', root), /JD/);
  assert.throws(() => createApplication({ ...base, kind: 'application' }, 'JD', root));
});
test('대표 이력서도 승인 없이 고정할 수 없고 JD 변경 시 승인이 만료된다', t => {
  const root = setup(t);
  createApplication(base, '', root); generate(base.id, root);
  assert.throws(() => snapshot(base.id, root), /승인/);
  recordReview(base.id, { reviewer: '테스트', verdict: 'PASS', notes: '테스트 검토', checks: { hiring: true, naturalness: true, spelling: true, confidentiality: true } }, root);
  approve(base.id, '테스트 승인자', root, verify(base.id, root).digest);
  fs.writeFileSync(path.join(appDir(base.id, root), 'jd-raw.md'), '새 JD');
  assert.throws(() => snapshot(base.id, root), /승인/);
});
test('대표 CLI는 별도 콘텐츠 모드 없이 확인 경력으로 생성한다', t => {
  const root = setup(t);
  const cli = path.resolve('scripts/cli.mjs');
  execFileSync(process.execPath, [cli, 'new-representative', '--id', 'real-main', '--title', '나의 대표 이력서'], { cwd: root });
  assert.equal(generate('real-main', root).status, 'awaiting_human_approval');
  assert.equal(verify('real-main', root).passed, true);
});
