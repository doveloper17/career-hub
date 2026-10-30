import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { roles, preparePacket, validateResult, checksFor, minimalEnvironment, packetHash } from '../lib/agent-permissions.mjs';
import { permissionConfig, overrides, createWorkspace, roleExecution } from '../lib/agent-runner.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-permission-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('tests/fixtures/template-content', path.join(root, 'content'), { recursive: true });
  return root;
}
function passing(packet) {
  return { run_id: packet.run_id, application_id: packet.application_id, role: packet.role, round: packet.round,
    target_digest: packet.target_digest, status: 'PASS', summary: '테스트 전용', findings: [], questions: [],
    checks: Object.fromEntries(checksFor(packet.role).map(k => [k, true])) };
}
test('분석 결과의 없는 출처·새 근거·미해결 PASS를 거절한다', t => {
  const packet = preparePacket('main-sample', 'job-market-analyst', fixture(t));
  const result = passing(packet);
  delete result.checks;
  result.requirements = [{ requirement: '검토', source_ids: [], evidence: [], missing: '사용자 확인 필요' }];
  assert.throws(() => validateResult(result, packet), /확인이 필요한/);
  result.status = 'NEEDS_INPUT';
  result.requirements[0].source_ids = ['NONEXISTENT'];
  assert.throws(() => validateResult(result, packet), /근거 불일치/);
  result.requirements[0].source_ids = [packet.sources[0].id];
  result.requirements[0].evidence = ['원본에 없는 성과'];
  assert.throws(() => validateResult(result, packet), /근거 불일치/);
});
test('역할의 모델·추론 설정을 읽고 명시적 모델 재정의만 우선한다', () => {
  for (const role of roles) {
    const config = parse(fs.readFileSync('.codex/agents/' + role + '.toml', 'utf8'));
    assert.equal(config.name, role);
    assert.ok(config.developer_instructions);
    const selected = roleExecution(role);
    assert.equal(selected.model, config.model);
    assert.equal(selected.effort, config.model_reasoning_effort);
    assert.equal(selected.instructions, config.developer_instructions);
    assert.equal(roleExecution(role, 'test-model').model, 'test-model');
    assert.equal(roleExecution(role, 'test-model').effort, selected.effort);
    assert.ok(Object.values(config.features).every(v => v === false));
  }
  assert.throws(() => roleExecution('../verifier'), /역할/);
  assert.throws(() => roleExecution('verifier', ''), /model/);
  assert.throws(() => roleExecution('verifier', '--invalid model'), /model/);
});
test('리뷰 입력은 사용 출처만 포함하고 승인자·경로·작성 전략·다른 리뷰는 제외한다', t => {
  const root = fixture(t);
  const packet = preparePacket('northstar-backend', 'verifier', root);
  const used = new Set(packet.provenance.claims.flatMap(c => c.sources));
  assert.ok(packet.sources.every(s => used.has(s.id) && s.usable && s.visibility === 'public'));
  assert.ok(!JSON.stringify(packet).includes(root));
  assert.equal(packet.metadata.approval, undefined);
  assert.equal(packet.analysis, undefined);
  assert.equal(packet.quality_review, undefined);
  assert.ok(packet.sources.every(s => s.confirmedBy === undefined && s.file === undefined));
  const coach = preparePacket('northstar-backend', 'feedback-coach', root);
  assert.equal(packet.target_digest, coach.target_digest);
  assert.deepEqual(packet.sources, coach.sources);
  assert.notEqual(packet.run_id, coach.run_id);
});
test('분석·작성 입력에 이력서/리뷰/승인 상태를 전달하지 않는다', t => {
  const root = fixture(t);
  for (const role of ['job-market-analyst', 'resume-writer']) {
    const packet = preparePacket('main-sample', role, root);
    assert.equal(packet.resume, undefined);
    assert.equal(packet.provenance, undefined);
    assert.equal(packet.metadata.status, undefined);
    assert.equal(packet.metadata.approval, undefined);
    if (role === 'job-market-analyst') assert.equal(packet.analysis, undefined);
  }
  assert.throws(() => preparePacket('main-sample', '../verifier', root), /역할/);
});
test('권한 프로필에는 쓰기 허용이 없고 네트워크·추가 위임이 비활성화된다', t => {
  const area = createWorkspace({ });
  t.after(() => fs.rmSync(area.base, { recursive: true, force: true }));
  const config = permissionConfig(area.workspace);
  const profile = config.permissions[config.default_permissions];
  assert.equal(profile.filesystem[':root'], 'deny');
  assert.equal(profile.filesystem[area.workspace], 'read');
  assert.ok(!Object.values(profile.filesystem).includes('write'));
  assert.equal(profile.network.enabled, false);
  assert.equal(config.approval_policy, 'never');
  assert.equal(config.agents.enabled, false);
  assert.equal(config.web_search, 'disabled');
  assert.deepEqual(config.mcp_servers, {});
  const args = overrides(config);
  for (let i = 1; i < args.length; i += 2) assert.doesNotThrow(() => parse(args[i]));
});
test('임시 작업 공간은 입력만 포함하고 가상 비밀자료는 읽기 허용 밖에 둔다', t => {
  const area = createWorkspace({ });
  t.after(() => fs.rmSync(area.base, { recursive: true, force: true }));
  assert.deepEqual(fs.readdirSync(area.workspace), ['packet.json']);
  assert.ok(!area.outside.startsWith(area.workspace + path.sep));
});
test('실행 환경에서 키·토큰·NODE_OPTIONS·프록시 환경 변수를 상속하지 않는다', () => {
  const env = minimalEnvironment({ PATH: 'runtime', HOME: 'unchanged-home', OPENAI_API_KEY: 'test-only', NODE_OPTIONS: '--require evil', HTTPS_PROXY: 'test', CUSTOM_SECRET: 'test' });
  assert.deepEqual(env, { PATH: 'runtime', HOME: 'unchanged-home' });
});
test('리뷰 결과는 역할·버전·실행 ID 및 모든 check가 일치해야 한다', t => {
  const root = fixture(t);
  const packet = preparePacket('main-sample', 'verifier', root);
  const result = passing(packet);
  assert.equal(validateResult(result, packet).status, 'PASS');
  for (const key of ['run_id', 'target_digest', 'application_id']) assert.throws(() => validateResult({ ...result, [key]: 'wrong' }, packet), /불일치/);
  assert.throws(() => validateResult({ ...result, checks: { ...result.checks, context: false } }, packet), /PASS/);
  assert.throws(() => validateResult({ ...result, questions: ['미확인 사실'] }, packet), /PASS/);
  assert.throws(() => validateResult({ ...result, approval: true }, packet));
  assert.notEqual(packetHash(packet), packetHash({ ...packet, jd: packet.jd + '변경' }));
});
test('손상된 원본 및 비밀정보 패턴이 있는 전달 자료를 차단한다', t => {
  const root = fixture(t);
  const dir = path.join(root, 'content/applications/main-sample');
  fs.appendFileSync(path.join(dir, 'resume.md'), '\n출처 없는 문장');
  assert.throws(() => preparePacket('main-sample', 'verifier', root), /검증/);
  fs.writeFileSync(path.join(dir, 'jd-raw.md'), ['sk', 'a'.repeat(30)].join('-'));
  assert.throws(() => preparePacket('main-sample', 'job-market-analyst', root), /비밀정보/);
});
test('작성자는 새로운 문장이나 빈 PASS를 반환할 수 없다', t => {
  const root = fixture(t);
  const packet = preparePacket('main-sample', 'resume-writer', root);
  const source = packet.sources[0];
  const { checks, ...result } = passing(packet);
  Object.assign(result, { claims: [{ id: 'one', text: source.statements[0], sources: [source.id] }], strategy: '원문 선택', proposed_expressions: [] });
  assert.equal(validateResult(result, packet).status, 'PASS');
  assert.throws(() => validateResult({ ...result, claims: [{ ...result.claims[0], text: '없는 성과' }] }, packet), /원본/);
  assert.throws(() => validateResult({ ...result, claims: [] }, packet), /빈 초안/);
});
