import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { careers, appDir, readJson, writeJson } from '../lib/store.mjs';
import { sourceDigest, sourceStatus, confirmSource } from '../lib/source-approval.mjs';
import { createApplication, generate, verify, approve, digest, submissionState, submissionText, snapshot } from '../lib/workflow.mjs';
import { review as recordReview } from './review-fixture.mjs';
import { mutate, recover, assertReadable } from '../lib/transaction.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('tests/fixtures/template-content/career', path.join(root, 'content/career'), { recursive: true });
  const file = path.join(root, 'content/career/verified/companies/morrow.md');
  const meta = { id: 'real', company: '테스트 회사', position: '개발자', keywords: ['Kotlin'], createdAt: '2026-10-29', deadline: null, jdUrl: null };
  createApplication(meta, '테스트 JD', root);
  const source = () => careers(root).find(c => c.id === 'EXP-MORROW-001');
  const confirm = () => confirmSource(source().id, '테스트 승인자', sourceDigest(source()), root);
  return { root, file, source, confirm, dir: appDir('real', root) };
}
const checks = { hiring: true, naturalness: true, spelling: true, confidentiality: true };
function reviewAndApprove(root) {
  recordReview('real', { reviewer: '테스트 검토자', verdict: 'PASS', checks, notes: '실제 검토가 아닌 회귀 테스트' }, root);
  approve('real', '테스트 승인자', root, digest('real', root));
}
test('verified와 confirmedBy만 지정한 원본은 사용 불가, 해시 확인 후만 사용', t => {
  const f = fixture(t);
  assert.equal(sourceStatus(f.source(), f.root).usable, false);
  assert.equal(generate('real', f.root).status, 'needs_human_input');
  assert.throws(() => confirmSource(f.source().id, '사람', 'wrong', f.root), /digest/);
  f.confirm();
  assert.equal(sourceStatus(f.source(), f.root).usable, true);
  assert.equal(generate('real', f.root).status, 'awaiting_human_approval');
  assert.equal(verify('real', f.root).passed, true);
});
test('원본 변경·승인 기록 삭제는 검증과 제출을 차단한다', t => {
  const f = fixture(t); f.confirm(); generate('real', f.root); reviewAndApprove(f.root);
  assert.match(submissionText('real', f.root), /^# 테스트 회사/);
  const before = fs.readFileSync(f.file, 'utf8');
  fs.appendFileSync(f.file, '\n확인하지 않은 원본 수정');
  assert.equal(verify('real', f.root).passed, false);
  assert.throws(() => submissionText('real', f.root), /제출 차단/);
  fs.writeFileSync(f.file, before);
  fs.unlinkSync(path.join(f.root, 'content/source-approvals/EXP-MORROW-001.json'));
  assert.equal(submissionState('real', f.root).approved, false);
});
test('승인한 경력도 private이면 생성과 제출에 사용할 수 없다', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('visibility: public', 'visibility: private'));
  f.confirm();
  assert.equal(sourceStatus(f.source(), f.root).usable, false);
  assert.equal(generate('real', f.root).selected, 0);
  assert.equal(verify('real', f.root).passed, false);
});
test('승인 해시는 실제 사용한 출처만 포함한다', t => {
  const f = fixture(t); f.confirm(); generate('real', f.root); reviewAndApprove(f.root);
  const before = digest('real', f.root);
  fs.appendFileSync(path.join(f.root, 'content/career/verified/companies/folio.md'), '\n다른 경력 수정');
  assert.equal(digest('real', f.root), before);
  assert.equal(submissionState('real', f.root).downloadable, true);
  fs.appendFileSync(f.file, '\n사용한 경력 수정');
  assert.notEqual(digest('real', f.root), before);
});
test('미승인·FAIL·오래된 리뷰·손상된 리뷰는 제출 차단, FAIL 체크 통과하지 않음', t => {
  const f = fixture(t); f.confirm(); generate('real', f.root);
  assert.throws(() => submissionText('real', f.root), /제출 차단/);
  recordReview('real', { reviewer: '테스트', verdict: 'FAIL', checks, notes: '수정 필요' }, f.root);
  assert.equal(submissionState('real', f.root).reviewed, false);
  assert.equal(submissionState('real', f.root).status, 'review_failed');
  assert.throws(() => approve('real', '사람', f.root, digest('real', f.root)), /PASS/);
  reviewAndApprove(f.root);
  const reviewFile = path.join(f.dir, 'quality-review.json');
  const review = readJson(reviewFile);
  writeJson(reviewFile, { ...review, checks: { ...checks, spelling: false } });
  assert.throws(() => submissionText('real', f.root), /제출 차단/);
  writeJson(reviewFile, { ...review, digest: 'old' });
  assert.equal(submissionState('real', f.root).approved, false);
  fs.writeFileSync(reviewFile, '{broken');
  assert.throws(() => submissionText('real', f.root), /제출 차단/);
});
test('최종 승인에는 확인한 현재 digest를 명시해야 하며 본문 변조는 표시 상태에 반영', t => {
  const f = fixture(t); f.confirm(); generate('real', f.root);
  recordReview('real', { reviewer: '테스트', verdict: 'PASS', checks, notes: '테스트' }, f.root);
  assert.throws(() => approve('real', '사람', f.root), /digest/);
  reviewAndApprove(f.root);
  fs.appendFileSync(path.join(f.dir, 'resume.md'), '\n출처 없는 성과');
  assert.equal(submissionState('real', f.root).status, 'verification_failed');
  assert.throws(() => snapshot('real', f.root), /승인/);
});
test('모든 이력서는 동일한 원본 확인·리뷰·최종 승인 후 다운로드한다', t => {
  const f = fixture(t);
  const project = careers(f.root).find(c => c.id === 'EXP-TINY-001');
  confirmSource(project.id, '테스트 확인자', sourceDigest(project), f.root);
  createApplication({ id: 'sample', company: '가상', position: '개발자', keywords: ['TypeScript'], createdAt: '2026-10-29', deadline: null, jdUrl: null }, '가상 JD', f.root);
  generate('sample', f.root);
  recordReview('sample', { reviewer: '테스트', verdict: 'PASS', checks, notes: '테스트' }, f.root);
  approve('sample', '사람', f.root, digest('sample', f.root));
  assert.equal(submissionState('sample', f.root).approved, true);
  assert.equal(submissionState('sample', f.root).downloadable, true);
  assert.match(submissionText('sample', f.root), /TypeScript/);
});
test('일부 파일 저장 실패는 원래 파일로 복구하고 쓰기 잠금을 해제한다', t => {
  const f = fixture(t);
  const original = fs.readFileSync(path.join(f.dir, 'metadata.json'), 'utf8');
  assert.throws(() => mutate(f.root, 'content/applications/real', () => {
    fs.writeFileSync(path.join(f.dir, 'metadata.json'), 'broken');
    throw new Error('저장 실패 재현');
  }), /저장 실패/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'metadata.json'), 'utf8'), original);
  assert.doesNotThrow(() => assertReadable(f.root));
});
test('다른 프로세스의 동시 쓰기를 거부하고 강제 중단 후 명시적 복구한다', t => {
  const f = fixture(t);
  const moduleUrl = pathToFileURL(path.resolve('lib/transaction.mjs')).href;
  const original = fs.readFileSync(path.join(f.dir, 'metadata.json'), 'utf8');
  mutate(f.root, 'content/applications/real', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { mutate } from ' + JSON.stringify(moduleUrl) + '; mutate(process.argv[1], "content/applications/real", () => {});', f.root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /저장 작업/);
    assert.throws(() => recover(f.root), /실행 중/);
  });
  const code = 'import fs from "node:fs"; import path from "node:path"; import { mutate } from ' + JSON.stringify(moduleUrl) + '; mutate(process.argv[1], "content/applications/real", () => { fs.writeFileSync(path.join(process.argv[1], "content/applications/real/metadata.json"), "broken"); process.exit(77); });';
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.root]);
  assert.equal(crashed.status, 77);
  assert.throws(() => assertReadable(f.root), /중단된/);
  assert.throws(() => generate('real', f.root), /중단된/);
  recover(f.root);
  assert.equal(fs.readFileSync(path.join(f.dir, 'metadata.json'), 'utf8'), original);
});
test('CLI 원본 승인과 최종 승인 입력 검증', t => {
  const f = fixture(t);
  const cli = path.resolve('scripts/cli.mjs');
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: 'utf8' });
  assert.equal(run(['source-approve', 'EXP-MORROW-001', '--by', '테스트']).status, 1);
  const d = JSON.parse(run(['source-digest', 'EXP-MORROW-001']).stdout).digest;
  assert.equal(run(['source-approve', 'EXP-MORROW-001', '--by', '테스트', '--digest', d, '--confirm']).status, 0);
  assert.equal(run(['generate', 'real']).status, 0);
  assert.equal(run(['approve', 'real', '--by', '테스트', '--confirm']).status, 1);
});
