import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication, generate, verify, recordReview, approve, snapshot, digest } from '../lib/workflow.mjs';
import { appDir, readJson, writeJson, careers, applications } from '../lib/store.mjs';

function fixture(t, keywords = ['Kotlin']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-test-'));
  fs.cpSync('content/career', path.join(root,'content/career'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createApplication({ id:'test-app', company:'가상 회사', position:'Backend', createdAt:'2026-10-28', deadline:null, jdUrl:null, fictional:true, keywords }, '가상 JD: Kotlin 개발자', root);
  generate('test-app', root);
  return { root, dir:appDir('test-app',root) };
}
function review(root) { return recordReview('test-app', { reviewer:'test-reviewer', verdict:'PASS', checks:{ hiring:true,naturalness:true,spelling:true,confidentiality:true }, notes:'테스트용 리뷰' }, root); }

test('실제 지원은 샘플 경력을 근거로 사용하지 않는다', t => {
  const { root } = fixture(t);
  createApplication({ id:'real-only', company:'테스트 회사', position:'Backend', createdAt:'2026-10-28', deadline:null, jdUrl:null, fictional:false, keywords:['Kotlin'] }, '테스트 JD', root);
  assert.equal(generate('real-only', root).status, 'needs_human_input');
  assert.equal(verify('real-only', root).passed, false);
  assert.equal(readJson(path.join(appDir('real-only', root), 'provenance.json')).claims.length, 0);
});

test('확인된 경력만 선택하고 모든 문장을 출처로 연결한다', t => {
  const { root, dir } = fixture(t);
  assert.equal(verify('test-app',root).passed,true);
  const claims = readJson(path.join(dir,'provenance.json')).claims;
  assert.equal(claims.length,2);
  assert.ok(claims.every(c => c.sources[0] === 'EXP-MORROW-001'));
});
test('존재하는 출처 ID를 붙여도 수치를 조작하면 실패한다', t => {
  const { root, dir } = fixture(t);
  const p = readJson(path.join(dir,'provenance.json')); p.claims[0].text += ' 매출 100억 달성';
  writeJson(path.join(dir,'provenance.json'), p);
  assert.equal(verify('test-app',root).passed,false);
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
  const input = { id:'test-app', company:'x', position:'x', createdAt:'2026-10-28', deadline:null, jdUrl:null, fictional:true, keywords:['Kotlin'] };
  assert.throws(() => createApplication(input,'JD',root), /이미 존재/);
  assert.throws(() => createApplication({...input,id:'other',createdAt:'2026-02-30'},'JD',root));
});
test('실제 경력도 같은 경로에서 읽고 가상 지원의 근거와 분리한다', t => {
  const { root } = fixture(t);
  const file = path.join(root,'content/career/verified/companies/morrow.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('fictional: true','fictional: false'));
  assert.equal(careers(root).find(c => c.id === 'EXP-MORROW-001').fictional, false);
  assert.equal(verify('test-app', root).passed, false);
  createApplication({ id:'real-app', company:'테스트 회사', position:'Backend', createdAt:'2026-10-28', deadline:null, jdUrl:null, fictional:false, keywords:['Kotlin'] }, '테스트 JD', root);
  generate('real-app', root);
  assert.equal(verify('real-app', root).passed, false); // verified 표기만으로 실제 원본을 승인하지 않음
});
