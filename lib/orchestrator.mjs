import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { slug } from './schema.mjs';
import { careers, readJson } from './store.mjs';
import { sourceDigest, sourceStatus } from './source-approval.mjs';
import { digest, load, verify, saveDraft, saveAnalysis, reserveRepair, recordReview, submissionState } from './workflow.mjs';
import { preparePacket } from './agent-permissions.mjs';
import { validateResult, packetHash } from './agent-contract.mjs';
import { executeRole } from './agent-runner.mjs';

const policySchema = z.strictObject({ maxRepairs: z.number().int().min(0).max(2), maxCalls: z.number().int().positive(),
  maxObservedTokens: z.number().int().positive(), maxInputBytes: z.number().int().positive().max(1048576),
  callTimeoutMs: z.number().int().min(1000).max(600000), maxActiveMs: z.number().int().positive() });
const stateSchema = z.object({ version: z.literal(1), id: slug, run_id: z.string(), reviewOnly: z.boolean(),
  status: z.enum(['ready', 'running', 'awaiting_human_input', 'awaiting_human_approval', 'budget_exhausted', 'repair_limit', 'stale', 'interrupted', 'failed', 'completed']),
  step: z.enum(['job-market-analyst', 'resume-writer', 'verify', 'verifier', 'feedback-coach', 'aggregate', 'done']),
  inputVersion: z.string(), policy: policySchema,
  spent: z.object({ calls: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), unmeteredCalls: z.number().int().nonnegative(), activeMs: z.number().nonnegative() }),
  feedback: z.array(z.unknown()), reviews: z.array(z.unknown()), questions: z.array(z.string()), reason: z.string(),
  repairTarget: z.number().int().min(1).max(2).nullable(),
  inFlight: z.object({ call_id: z.uuid(), role: z.string(), digest: z.string(), packetHash: z.string() }).nullable(),
  history: z.array(z.object({ at: z.string(), step: z.string(), status: z.string(), reason: z.string() })),
});
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function runDir(id, root) {
  slug.parse(id);
  let current = fs.realpathSync(root);
  for (const part of ['.local', 'workflow-runs', id]) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('실행 상태 경로의 심볼릭 링크 금지');
  }
  return current;
}
function atomicJson(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function inputVersion(id, root = process.cwd()) {
  return hash({ digest: digest(id, root), retries: load(id, root).meta.retries,
    sources: careers(root).map(c => ({ id: c.id, digest: sourceDigest(c), usable: sourceStatus(c, root).usable })).sort((a, b) => a.id.localeCompare(b.id)) });
}
export function readRun(id, root = process.cwd()) {
  const dir = runDir(id, root);
  const state = stateSchema.parse(readJson(path.join(dir, 'state.json')));
  if (state.id !== id) throw new Error('실행 ID와 폴더 불일치');
  return state;
}
function saveRun(state, root, reason = state.reason) {
  state.reason = reason;
  state.history.push({ at: new Date().toISOString(), step: state.step, status: state.status, reason });
  stateSchema.parse(state);
  atomicJson(path.join(runDir(state.id, root), 'state.json'), state);
}
export function startRun(id, options = {}, root = process.cwd()) {
  const { meta } = load(id, root);
  if (['approved', 'submitted'].includes(meta.status)) throw new Error('승인된 버전은 새 지원 ID로 시작하세요.');
  const policy = policySchema.parse({ ...readJson(path.join(root, 'workflow-policy.json')), ...options.limits });
  const dir = runDir(id, root);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // One durable run per application; never reset budgets with another start.
  const state = { version: 1, id, run_id: crypto.randomUUID(), reviewOnly: !!options.reviewOnly,
    status: 'ready', step: options.reviewOnly ? 'verify' : 'job-market-analyst', inputVersion: inputVersion(id, root), policy,
    spent: { calls: 0, tokens: 0, unmeteredCalls: 0, activeMs: 0 }, feedback: [], reviews: [], questions: [], reason: '', repairTarget: null, inFlight: null, history: [] };
  saveRun(state, root, '시작 준비 완료. 모델 호출은 전송 승인 후 resume에서 실행합니다.');
  return state;
}
export function updateBudget(id, limits, root = process.cwd()) {
  const state = readRun(id, root);
  if (fs.existsSync(path.join(runDir(id, root), 'owner.json'))) throw new Error('실행 중에는 예산 변경 금지');
  state.policy = policySchema.parse({ ...state.policy, ...limits });
  saveRun(state, root, '사용자 지시에 따라 예산 변경. 사용량·수정 횟수는 유지합니다.');
  return state;
}
export function recoverRun(id, root = process.cwd()) {
  const file = path.join(runDir(id, root), 'owner.json');
  const owner = readJson(file);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('실행 소유자 정보 오류');
  try { process.kill(owner.pid, 0); throw new Error('실행 프로세스가 살아 있습니다.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  fs.unlinkSync(file);
  return readRun(id, root); // In-flight calls and charged budget intentionally survive.
}

export async function resumeRun(id, options = {}, root = process.cwd()) {
  if (!options.confirmSend) throw new Error('자료 전송 승인 후 --confirm-send가 필요합니다.');
  const dir = runDir(id, root);
  const lock = path.join(dir, 'owner.json');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
  let state, lastClock = Date.now();
  const checkpoint = reason => {
    const now = Date.now(); state.spent.activeMs += now - lastClock; lastClock = now;
    saveRun(state, root, reason);
  };
  const halt = (status, reason) => { state.status = status; checkpoint(reason); return state; };
  try {
    state = readRun(id, root);
    if (state.status === 'completed') return state;
    if (state.status === 'awaiting_human_approval' && submissionState(id, root).approved) return halt('completed', '사람의 현재 버전 최종 승인 확인');
    const current = inputVersion(id, root);
    if (current !== state.inputVersion) {
      if (!options.acceptChanges) return halt('stale', '입력 변경 감지. 원본 확인 후 --accept-changes로 재검토하세요.');
      state.step = state.reviewOnly ? 'verify' : 'job-market-analyst';
      state.inputVersion = current; state.reviews = []; state.feedback = []; state.questions = []; state.inFlight = null; state.repairTarget = null;
      checkpoint('변경된 입력으로 검토 재시작. 호출·토큰·수정 횟수 유지');
    } else if (['awaiting_human_approval', 'awaiting_human_input', 'repair_limit'].includes(state.status)) return state;
    state.status = 'running'; checkpoint('저장된 단계에서 재개');
    while (state.step !== 'done') {
      if (options.signal?.aborted) return halt('interrupted', '사용자 중단. 단계와 사용량을 보존했습니다.');
      if (inputVersion(id, root) !== state.inputVersion) return halt('stale', '실행 중 입력 변경. 이전 결과를 적용하지 않습니다.');
      if (state.step === 'verify') {
        const result = verify(id, root);
        if (!result.passed) { state.questions = result.errors; return halt('awaiting_human_input', '구조/출처 검사 실패. 사실·원본·출처를 확인하세요.'); }
        state.step = 'verifier'; checkpoint('구조 검사 통과. 문장 의미 검토는 아직 완료되지 않았습니다.'); continue;
      }
      if (state.step === 'aggregate') {
        const [, quality] = state.reviews;
        const needsInput = state.reviews.some(r => r.status === 'NEEDS_INPUT' || r.questions.length);
        if (needsInput) {
          state.questions = state.reviews.flatMap(r => r.questions.length ? r.questions : [r.summary]);
          return halt('awaiting_human_input', '경력 사실 확인 필요. 실행기는 원본을 수정하거나 승인하지 않습니다.');
        }
        if (state.reviews.every(r => r.status === 'PASS')) {
          recordReview(id, { verdict: 'PASS', reviewer: 'AI verifier + feedback-coach', checks: quality.checks,
            notes: state.reviews.map(r => `${r.role} ${r.run_id}: ${r.summary}`).join('\n'), agentReviews: state.reviews }, root);
          state.inputVersion = inputVersion(id, root); state.step = 'done';
          return halt('awaiting_human_approval', '두 독립 리뷰 통과. 현재 이력서는 사람이 최종 승인해야 합니다.');
        }
        recordReview(id, { verdict: 'FAIL', reviewer: 'AI verifier + feedback-coach', checks: quality.checks,
          notes: state.reviews.map(r => r.summary).join('\n'), agentReviews: state.reviews }, root);
        state.inputVersion = inputVersion(id, root);
        const retries = load(id, root).meta.retries;
        if (retries >= state.policy.maxRepairs) return halt('repair_limit', '자동 수정 한도 도달. 사용자 방향 확인 필요');
        state.feedback = state.reviews.flatMap(r => r.findings);
        if (!state.feedback.length) return halt('awaiting_human_input', '리뷰 FAIL에 수정 근거가 없습니다. 검토 내용 확인 필요');
        state.repairTarget = retries + 1; state.reviews = []; state.step = 'resume-writer';
        checkpoint('표현 수정 준비. 원본은 그대로 유지합니다.'); continue;
      }
      if (state.step === 'resume-writer' && state.repairTarget !== null) {
        reserveRepair(id, state.repairTarget, root);
        state.inputVersion = inputVersion(id, root);
        checkpoint('수정 회차를 모델 호출 전에 기록했습니다.');
      }
      const role = state.step;
      let inFlight = state.inFlight;
      let cached = null;
      if (inFlight) {
        if (inFlight.role !== role) throw new Error('실행 중 단계 불일치');
        const file = path.join(dir, inFlight.call_id + '.json');
        if (fs.existsSync(file) && !options.retryInterrupted) cached = readJson(file);
        else if (!options.retryInterrupted) return halt('interrupted', '이전 호출 결과가 불명확합니다. --retry-interrupted로만 재호출하며 이전 비용은 유지합니다.');
      }
      if (!cached) {
        const active = state.spent.activeMs + Date.now() - lastClock;
        if (state.spent.calls >= state.policy.maxCalls || state.spent.tokens >= state.policy.maxObservedTokens || active >= state.policy.maxActiveMs) return halt('budget_exhausted', '호출·관측 토큰·활성 실행 시간 예산 도달');
        inFlight = { call_id: crypto.randomUUID(), role, digest: digest(id, root), packetHash: '' };
      }
      const args = { runId: inFlight.call_id, feedback: role === 'resume-writer' ? state.feedback : [] };
      let packet;
      try { packet = preparePacket(id, role, root, args); }
      catch { return halt('awaiting_human_input', '사용할 원본 확인 또는 입력 자료 검사가 필요합니다.'); }
      if (Buffer.byteLength(JSON.stringify(packet)) > state.policy.maxInputBytes) return halt('budget_exhausted', '입력 크기 예산 초과. 자료 범위를 줄이세요.');
      if (cached && packetHash(packet) !== inFlight.packetHash) return halt('stale', '중단된 호출의 입력과 현재 입력이 다릅니다.');
      let envelope = cached;
      if (!envelope) {
        inFlight.packetHash = packetHash(packet); state.inFlight = inFlight; state.spent.calls += 1; state.spent.unmeteredCalls += 1;
        checkpoint('모델 호출 예약·입력 버전 저장: ' + role);
        let metered = false;
        envelope = await (options.execute || executeRole)(id, role, options.model, root, { ...args, signal: options.signal,
          timeoutMs: Math.min(state.policy.callTimeoutMs, Math.max(1, state.policy.maxActiveMs - state.spent.activeMs)),
          onResult: value => atomicJson(path.join(dir, inFlight.call_id + '.json'), value),
          onUsage: usage => { state.spent.tokens += usage.tokens; if (!metered) state.spent.unmeteredCalls -= 1; metered = true; checkpoint('모델 사용량 기록'); } });
        if (!metered) {
          if (envelope.usage?.metered) { state.spent.tokens += envelope.usage.tokens; state.spent.unmeteredCalls -= 1; }
        }
        atomicJson(path.join(dir, inFlight.call_id + '.json'), envelope);
      }
      if (inputVersion(id, root) !== state.inputVersion) return halt('stale', '모델 실행 중 입력 변경. 반환 결과 폐기');
      const result = validateResult(envelope.result, packet);
      if (!envelope.isolation || !['read_packet', 'write_denied', 'delete_denied', 'private_read_denied', 'network_denied'].every(k => envelope.isolation[k] === true)) throw new Error('격리 검사 결과 누락');
      state.inFlight = null;
      if (role === 'job-market-analyst') {
        if (result.status !== 'PASS') { state.questions = result.questions.length ? result.questions : [result.summary]; return halt('awaiting_human_input', '분석에 사용자 확인이 필요합니다.'); }
        saveAnalysis(id, JSON.stringify(result, null, 2), packet.target_digest, root);
        // A pre-existing draft may be rewritten at most twice, across all runs and CLI repairs.
        if (load(id, root).meta.revision > 0) {
          const retries = load(id, root).meta.retries;
          if (retries >= state.policy.maxRepairs) return halt('repair_limit', '기존 초안의 자동 수정 한도 도달');
          state.repairTarget = retries + 1;
        }
        state.step = 'resume-writer';
      } else if (role === 'resume-writer') {
        if (result.status !== 'PASS') { state.questions = result.questions.length ? result.questions : [result.summary]; return halt('awaiting_human_input', '작성에 새 사실 확인이 필요합니다. 원본은 자동 변경하지 않습니다.'); }
        saveDraft(id, result, packet.target_digest, root);
        state.repairTarget = null; state.feedback = []; state.reviews = []; state.step = 'verify';
      } else {
        state.reviews.push(result); state.step = role === 'verifier' ? 'feedback-coach' : 'aggregate';
      }
      state.inputVersion = inputVersion(id, root); checkpoint('단계 결과 저장: ' + role);
    }
    return state;
  } catch (error) {
    if (!state) throw error;
    atomicJson(path.join(dir, 'last-error.json'), { at: new Date().toISOString(), step: state.step, call_id: state.inFlight?.call_id || null, message: String(error.message).slice(0, 4000) });
    return halt(options.signal?.aborted ? 'interrupted' : 'failed', '모델·결과 형식·저장 오류. 상태와 사용량을 보존했습니다.');
  } finally { fs.unlinkSync(lock); }
}
