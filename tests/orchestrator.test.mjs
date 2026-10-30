import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplication, approve, digest, submissionState } from '../lib/workflow.mjs';
import { startRun, readRun, resumeRun, updateBudget, recoverRun } from '../lib/orchestrator.mjs';
import { preparePacket } from '../lib/agent-permissions.mjs';
import { passingResult } from './review-fixture.mjs';
import { readModelEvents } from '../lib/model-process.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('tests/fixtures/template-content', path.join(root, 'content'), { recursive: true });
  fs.copyFileSync('workflow-policy.json', path.join(root, 'workflow-policy.json'));
  createApplication({ id: 'flow', company: '테스트 회사', position: 'Backend', keywords: ['Kotlin'], createdAt: '2026-10-29', deadline: null, jdUrl: null }, 'Kotlin JD', root);
  return root;
}
const isolation = { read_packet: true, write_denied: true, delete_denied: true, private_read_denied: true, network_denied: true };
function fake(options = {}) {
  const calls = [];
  let coachRound = 0;
  const execute = async (id, role, _model, root, context) => {
    calls.push(role);
    const packet = preparePacket(id, role, root, context);
    const result = passingResult(packet);
    if (role === 'job-market-analyst') result.requirements = [];
    if (role === 'resume-writer') {
      const source = packet.sources.find(s => s.tags.includes('Kotlin'));
      Object.assign(result, { claims: [{ id: 'claim-one', text: '주문 조회 개선을 위해 실행 계획을 분석하고 인덱스를 조정했다.', sources: [source.id] }], strategy: '개인 기여 중심 표현', proposed_expressions: [] });
      if (options.requireFact) Object.assign(result, { status: 'NEEDS_INPUT', questions: ['이 작업의 정확한 기여 범위를 확인해 주세요.'] });
    }
    if (role === 'feedback-coach') {
      coachRound += 1;
      if (options.alwaysFail || options.failFirst && coachRound === 1) {
        result.status = 'FAIL'; result.checks.naturalness = false;
        result.findings = [{ claim_id: 'claim-one', source_ids: packet.provenance.claims[0].sources, text: '표현을 간결하게', reason: '중복 표현', acceptance_criteria: '원본 사실을 유지하며 간결하게' }];
      }
    }
    return { result, isolation, usage: { tokens: 10, metered: true }, execution: { model: 'test-double', reasoning_effort: 'medium' } };
  };
  return { execute, calls };
}
const opts = provider => ({ confirmSend: true, execute: provider.execute });
const sourceHash = root => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name))]);
  return crypto.createHash('sha256').update(Buffer.concat([...walk(path.join(root, 'content/career/verified')), ...walk(path.join(root, 'content/source-approvals'))])).digest('hex');
};

test('표현 작성→구조 검사→독립 리뷰 두 건→사람 승인 대기까지 자동 연결한다', async t => {
  const root = fixture(t), provider = fake();
  const before = sourceHash(root);
  startRun('flow', {}, root);
  const state = await resumeRun('flow', opts(provider), root);
  assert.equal(state.status, 'awaiting_human_approval');
  assert.deepEqual(provider.calls, ['job-market-analyst', 'resume-writer', 'verifier', 'feedback-coach']);
  assert.equal(state.spent.calls, 4); assert.equal(state.spent.tokens, 40);
  assert.equal(sourceHash(root), before);
  assert.equal(submissionState('flow', root).reviewed, true);
  assert.equal(submissionState('flow', root).approved, false);
  approve('flow', '테스트 사람', root, digest('flow', root));
  assert.equal((await resumeRun('flow', opts(provider), root)).status, 'completed');
  assert.equal(provider.calls.length, 4);
});
test('품질 FAIL을 작성자에게 전달하고 수정한 버전으로 두 리뷰를 다시 받는다', async t => {
  const root = fixture(t), provider = fake({ failFirst: true });
  let feedbackSeen = false;
  const original = provider.execute;
  provider.execute = async (...args) => { if (args[1] === 'resume-writer' && args[4].feedback.length) feedbackSeen = true; return original(...args); };
  startRun('flow', {}, root);
  const state = await resumeRun('flow', opts(provider), root);
  assert.equal(state.status, 'awaiting_human_approval');
  assert.equal(state.spent.calls, 7); assert.equal(feedbackSeen, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'content/applications/flow/metadata.json'))).retries, 1);
});
test('호출 예산 소진 후 단계·사용량을 유지하고 예산 변경 후 이어 간다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', { limits: { maxCalls: 2 } }, root);
  const paused = await resumeRun('flow', opts(provider), root);
  assert.equal(paused.status, 'budget_exhausted'); assert.equal(paused.step, 'verifier');
  assert.throws(() => startRun('flow', {}, root));
  updateBudget('flow', { maxCalls: 4 }, root);
  const done = await resumeRun('flow', opts(provider), root);
  assert.equal(done.status, 'awaiting_human_approval'); assert.equal(done.spent.calls, 4);
  assert.equal(provider.calls.filter(x => x === 'resume-writer').length, 1);
});
test('반복 FAIL은 수정 2회에서 멈추고 다시 resume해도 횟수를 초기화하지 않는다', async t => {
  const root = fixture(t), provider = fake({ alwaysFail: true });
  startRun('flow', {}, root);
  const state = await resumeRun('flow', opts(provider), root);
  assert.equal(state.status, 'repair_limit'); assert.equal(state.spent.calls, 10);
  const again = await resumeRun('flow', opts(provider), root);
  assert.equal(again.spent.calls, 10); assert.equal(provider.calls.length, 10);
});
test('사실 정보 부족은 원본을 바꾸지 않고 대기하며 같은 resume로 질문을 반복 호출하지 않는다', async t => {
  const root = fixture(t), provider = fake({ requireFact: true });
  const before = sourceHash(root);
  startRun('flow', {}, root);
  const state = await resumeRun('flow', opts(provider), root);
  assert.equal(state.status, 'awaiting_human_input'); assert.equal(state.questions.length, 1);
  assert.equal(sourceHash(root), before);
  assert.equal((await resumeRun('flow', opts(provider), root)).spent.calls, 2);
});
test('입력 변경은 이전 결과를 적용하지 않고 명시적으로 수락한 새 입력으로 재검토한다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', { limits: { maxCalls: 1 } }, root);
  await resumeRun('flow', opts(provider), root);
  fs.appendFileSync(path.join(root, 'content/applications/flow/jd-raw.md'), '\n추가 요건');
  assert.equal((await resumeRun('flow', opts(provider), root)).status, 'stale');
  updateBudget('flow', { maxCalls: 6 }, root);
  const state = await resumeRun('flow', { ...opts(provider), acceptChanges: true }, root);
  assert.equal(state.status, 'awaiting_human_approval'); assert.equal(state.spent.calls, 5);
});
test('중단된 호출도 사용 횟수를 차감하며 명시적 재시도 전에는 다시 모델을 부르지 않는다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', {}, root);
  const failed = await resumeRun('flow', { confirmSend: true, execute: async () => { throw new Error('연결 중단'); } }, root);
  assert.equal(failed.status, 'failed'); assert.equal(failed.spent.calls, 1); assert.equal(failed.spent.unmeteredCalls, 1);
  assert.equal((await resumeRun('flow', opts(provider), root)).status, 'interrupted');
  assert.equal(provider.calls.length, 0);
  const state = await resumeRun('flow', { ...opts(provider), retryInterrupted: true }, root);
  assert.equal(state.status, 'awaiting_human_approval'); assert.equal(state.spent.calls, 5);
});
test('관측 토큰 예산과 입력 크기 예산은 다음 호출 전에 중단한다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', { limits: { maxObservedTokens: 10 } }, root);
  assert.equal((await resumeRun('flow', opts(provider), root)).status, 'budget_exhausted');
  assert.equal(provider.calls.length, 1);
  updateBudget('flow', { maxObservedTokens: 100, maxInputBytes: 1 }, root);
  assert.equal((await resumeRun('flow', opts(provider), root)).status, 'budget_exhausted');
  assert.equal(provider.calls.length, 1);
});
test('살아 있는 실행 잠금과 전송 승인 없는 모델 실행을 거부한다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', {}, root);
  await assert.rejects(resumeRun('flow', { execute: provider.execute }, root), /전송 승인/);
  const lock = path.join(root, '.local/workflow-runs/flow/owner.json');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(resumeRun('flow', opts(provider), root));
  assert.throws(() => recoverRun('flow', root), /살아/);
  assert.equal(readRun('flow', root).spent.calls, 0);
});
test('JSONL에서 최종 응답과 실제 usage를 읽고 도구 실행·오류는 거부한다', () => {
  const stream = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3 } }].map(JSON.stringify).join('\n');
  assert.deepEqual(readModelEvents(stream), { final: '{"ok":true}', tokens: 15, metered: true });
  assert.throws(() => readModelEvents(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } })), /도구/);
  assert.throws(() => readModelEvents('{"type":"turn.failed"}'), /실패/);
});
test('결과 저장 직후 중단되면 현재 입력이 같은 결과를 재호출 없이 복구한다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', {}, root);
  const failed = await resumeRun('flow', { confirmSend: true, execute: async (...args) => {
    const envelope = await provider.execute(...args);
    args[4].onResult(envelope);
    throw new Error('결과 저장 직후 중단');
  } }, root);
  assert.equal(failed.spent.calls, 1);
  const state = await resumeRun('flow', opts(provider), root);
  assert.equal(state.status, 'awaiting_human_approval');
  assert.equal(provider.calls.filter(r => r === 'job-market-analyst').length, 1);
  assert.equal(state.spent.calls, 4);
});
test('모델 호출 중 원본이 바뀌면 반환한 작성·분석 결과를 저장하지 않는다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', {}, root);
  const original = provider.execute;
  provider.execute = async (...args) => {
    const result = await original(...args);
    fs.appendFileSync(path.join(root, 'content/career/verified/companies/morrow.md'), '\n원본 변경');
    return result;
  };
  const state = await resumeRun('flow', opts(provider), root);
  assert.equal(state.status, 'stale'); assert.equal(state.spent.calls, 1);
  assert.equal(fs.existsSync(path.join(root, 'content/applications/flow/jd-analysis.md')), false);
});
test('문장별 의미 검토 누락과 다른 문서 버전은 수동 PASS로도 승인할 수 없다', async t => {
  const root = fixture(t), provider = fake();
  startRun('flow', {}, root);
  const state = await resumeRun('flow', opts(provider), root);
  const file = path.join(root, 'content/applications/flow/quality-review.json');
  const review = JSON.parse(fs.readFileSync(file, 'utf8'));
  review.agentReviews[0].claim_checks = [];
  fs.writeFileSync(file, JSON.stringify(review));
  assert.equal(submissionState('flow', root).reviewed, false);
  assert.throws(() => approve('flow', '테스트 사람', root, digest('flow', root)), /PASS/);
  review.agentReviews = state.reviews;
  review.agentReviews[1].target_digest = '다른 버전';
  fs.writeFileSync(file, JSON.stringify(review));
  assert.equal(submissionState('flow', root).reviewed, false);
});
