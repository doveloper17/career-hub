import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication, generate, verify, recordReview as rawReview, approve, snapshot, digest, resumeText, submissionState } from '../lib/workflow.mjs';
import { review as recordReview, evidence } from './review-fixture.mjs';
import { appDir, readJson, writeJson, careers, applications } from '../lib/store.mjs';
import { confirmSource, sourceDigest } from '../lib/source-approval.mjs';

function fixture(t, keywords = ['Kotlin']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-test-'));
  fs.cpSync('tests/fixtures/template-content/career', path.join(root,'content/career'), { recursive: true });
  fs.cpSync('tests/fixtures/template-content/source-approvals', path.join(root,'content/source-approvals'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createApplication({ id:'test-app', company:'가상 회사', position:'Backend', createdAt:'2026-10-28', deadline:null, jdUrl:null, keywords }, '가상 JD: Kotlin 개발자', root);
  generate('test-app', root);
  return { root, dir:appDir('test-app',root) };
}
function review(root) { return recordReview('test-app', { reviewer:'test-reviewer', verdict:'PASS', checks:{ hiring:true,naturalness:true,spelling:true,confidentiality:true }, notes:'테스트용 리뷰' }, root); }

test('새 지원도 동일한 확인 경력과 생성 절차를 사용한다', t => {
  const { root } = fixture(t);
  createApplication({ id:'real-only', company:'테스트 회사', position:'Backend', createdAt:'2026-10-28', deadline:null, jdUrl:null, keywords:['Kotlin'] }, '테스트 JD', root);
  assert.equal(generate('real-only', root).status, 'awaiting_human_approval');
  assert.equal(verify('real-only', root).passed, true);
  assert.equal(readJson(path.join(appDir('real-only', root), 'provenance.json')).claims.length, 2);
});

test('확인된 경력만 선택하고 모든 문장을 출처로 연결한다', t => {
  const { root, dir } = fixture(t);
  assert.equal(verify('test-app',root).passed,true);
  const claims = readJson(path.join(dir,'provenance.json')).claims;
  assert.equal(claims.length,2);
  assert.ok(claims.every(c => c.sources[0] === 'EXP-MORROW-001'));
});
test('표현은 달라도 구조 검사가 가능하며 의미 오류는 독립 리뷰에서 차단한다', t => {
  const { root, dir } = fixture(t);
  const p = readJson(path.join(dir,'provenance.json')); p.claims[0].text += ' 매출 100억 달성';
  writeJson(path.join(dir,'provenance.json'), p);
  fs.writeFileSync(path.join(dir, 'resume.md'), resumeText(readJson(path.join(dir, 'metadata.json')), p.claims));
  assert.equal(verify('test-app',root).passed,true); // Structural consistency is not proof of truth.
  assert.throws(() => rawReview('test-app', { reviewer: '테스트', verdict: 'PASS', checks: { hiring: true, naturalness: true, spelling: true, confidentiality: true }, notes: '근거 없는 통과' }, root), /두 독립 리뷰/);
  const pair = evidence('test-app', root);
  pair[0].claim_checks[0].supported = false;
  assert.throws(() => rawReview('test-app', { reviewer: '테스트', verdict: 'PASS', checks: pair[1].checks, notes: '의미 오류', agentReviews: pair }, root), /의미 검토/);
  assert.equal(submissionState('test-app', root).downloadable, false);
});
test('출처 밖의 문장을 이력서에 추가하면 실패한다', t => {
  const { root, dir } = fixture(t);
  fs.appendFileSync(path.join(dir,'resume.md'),'\n전사 개발을 총괄했다.');
  assert.match(verify('test-app',root).errors.join(' '), /출처 없는/);
});
test('pending ID로 출처를 바꾸면 실패한다', t => {
  const { root, dir } = fixture(t);
  const p = readJson(path.join(dir,'provenance.json')); p.claims[0].sources = ['PENDING-001'];
  writeJson(path.join(dir,'provenance.json'),p);
  assert.match(verify('test-app',root).errors.join(' '), /verified 출처/);
});
test('리뷰 없이 승인할 수 없고 모든 품질 체크가 필요하다', t => {
  const { root } = fixture(t);
  assert.throws(() => approve('test-app','사람',root,verify('test-app',root).digest));
  assert.throws(() => recordReview('test-app',{ reviewer:'r', verdict:'PASS', notes:'n',checks:{ hiring:true,naturalness:true,spelling:false,confidentiality:true } },root), /모든 리뷰/);
});
test('JD 또는 원본 변경은 리뷰와 승인을 무효화한다', t => {
  const { root, dir } = fixture(t); review(root); approve('test-app','사람',root,verify('test-app',root).digest);
  const before = digest('test-app',root);
  fs.appendFileSync(path.join(dir,'jd-raw.md'),'\n다른 요건');
  assert.notEqual(digest('test-app',root),before);
  assert.throws(() => snapshot('test-app',root), /승인/);
});
test('승인본은 재생성할 수 없고 제출 스냅샷은 덮어쓰지 않는다', t => {
  const { root, dir } = fixture(t); review(root); approve('test-app','사람',root,verify('test-app',root).digest);
  assert.throws(() => generate('test-app',root), /새 지원 ID/);
  const target = snapshot('test-app',root);
  assert.equal(fs.readFileSync(path.join(target,'resume.md'),'utf8'), fs.readFileSync(path.join(dir,'resume.md'),'utf8'));
  assert.throws(() => snapshot('test-app',root));
  assert.equal(applications(root).length,1);
});
test('근거가 없는 키워드는 입력 필요 상태이며 자동 수정 2회 후 중단한다', t => {
  const { root, dir } = fixture(t,['Rust']);
  assert.equal(readJson(path.join(dir,'metadata.json')).status,'needs_human_input');
  assert.equal(verify('test-app',root).passed,false);
  generate('test-app',root,true); generate('test-app',root,true);
  assert.throws(() => generate('test-app',root,true), /한도 2회/);
});
test('유효하지 않은 날짜, 디렉터리 탈출 및 기존 지원 덮어쓰기를 거부한다', t => {
  const { root } = fixture(t);
  assert.throws(() => appDir('../escape',root));
  const input = { id:'test-app', company:'x', position:'x', createdAt:'2026-10-28', deadline:null, jdUrl:null, keywords:['Kotlin'] };
  assert.throws(() => createApplication(input,'JD',root), /이미 존재/);
  assert.throws(() => createApplication({...input,id:'other',createdAt:'2026-02-30'},'JD',root));
});
test('콘텐츠를 본인 경력으로 교체하면 원본 확인 후 같은 명령으로 생성한다', t => {
  const { root } = fixture(t);
  const file = path.join(root,'content/career/verified/companies/morrow.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('모로우랩', '내 회사'));
  assert.equal(verify('test-app', root).passed, false);
  createApplication({ id:'real-app', company:'테스트 회사', position:'Backend', createdAt:'2026-10-28', deadline:null, jdUrl:null, keywords:['Kotlin'] }, '테스트 JD', root);
  generate('real-app', root);
  assert.equal(verify('real-app', root).passed, false); // verified 표기만으로 실제 원본을 승인하지 않음
  const source = careers(root).find(c => c.id === 'EXP-MORROW-001');
  confirmSource(source.id, '테스트 확인자', sourceDigest(source), root);
  assert.equal(generate('real-app', root).status, 'awaiting_human_approval');
  assert.equal(verify('real-app', root).passed, true);
});
