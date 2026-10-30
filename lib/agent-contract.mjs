import crypto from 'node:crypto';
import { z } from 'zod';

export const roles = ['job-market-analyst', 'resume-writer', 'verifier', 'feedback-coach'];
export const reviewRoles = ['verifier', 'feedback-coach'];
export const checksFor = role => role === 'verifier' ? ['factuality', 'provenance', 'context'] :
  role === 'feedback-coach' ? ['hiring', 'naturalness', 'spelling', 'confidentiality'] : [];
export function assertRole(role) { if (!roles.includes(role)) throw new Error('지원하지 않는 에이전트 역할'); }
export const packetHash = packet => crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');
export const findingSchema = z.strictObject({ claim_id: z.string(), source_ids: z.array(z.string()), text: z.string(), reason: z.string().min(1), acceptance_criteria: z.string().min(1) });
export function resultSchema(role) {
  assertRole(role);
  const base = {
    run_id: z.string().min(1), application_id: z.string(), role: z.literal(role), round: z.number().int().min(0).max(2),
    target_digest: z.string(), status: z.enum(['PASS', 'FAIL', 'NEEDS_INPUT']), summary: z.string().min(1),
    findings: z.array(findingSchema).describe('해결해야 할 문제만 기록. 일반 분석·강점·권고는 summary/requirements에 기록. PASS이면 반드시 빈 배열.'),
    questions: z.array(z.string().min(1)).describe('사용자 답변이 반드시 필요한 질문만 기록. PASS이면 반드시 빈 배열.'),
  };
  if (reviewRoles.includes(role)) base.checks = z.strictObject(Object.fromEntries(checksFor(role).map(k => [k, z.boolean()])));
  if (role === 'verifier') base.claim_checks = z.array(z.strictObject({ claim_id: z.string(), supported: z.boolean(), reason: z.string().min(1) }));
  if (role === 'job-market-analyst') base.requirements = z.array(z.strictObject({ requirement: z.string(), source_ids: z.array(z.string()),
    evidence: z.array(z.string()).describe('지정한 출처의 statements에서 그대로 인용한 근거 문장. 요약·본문 인용은 넣지 않음.'),
    missing: z.string().describe('이 작업을 진행하려면 사람 확인이 반드시 필요한 정보. 필요 없으면 설명문 대신 빈 문자열. PASS는 모두 빈 문자열.') }));
  if (role === 'resume-writer') {
    base.claims = z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1), sources: z.array(z.string()).min(1) }));
    base.strategy = z.string();
    base.proposed_expressions = z.array(z.strictObject({ original: z.string(), proposed: z.string(), confirmation_needed: z.string() }));
  }
  return z.strictObject(base);
}
export function validateResult(value, packet) {
  const result = resultSchema(packet.role).parse(value);
  for (const key of ['run_id', 'application_id', 'role', 'round', 'target_digest']) {
    if (result[key] !== packet[key]) throw new Error('결과의 실행/역할/버전 불일치');
  }
  if (result.status === 'PASS' && (result.findings.length || result.questions.length ||
    result.checks && !Object.values(result.checks).every(Boolean))) throw new Error('미검토·문제·질문이 남은 PASS는 허용하지 않습니다.');
  const sourceIds = new Set(packet.sources.map(s => s.id));
  const claimIds = new Set(packet.provenance?.claims.map(c => c.id) || []);
  for (const f of result.findings) {
    if (f.source_ids.some(id => !sourceIds.has(id)) || f.claim_id && packet.provenance && !claimIds.has(f.claim_id)) throw new Error('검토 결과의 근거/문장 ID 불일치');
  }
  for (const req of result.requirements || []) {
    // This compares evidence quotations, not the rewritten resume text.
    if (req.source_ids.some(id => !sourceIds.has(id)) || req.evidence.some(text => !packet.sources.some(s => req.source_ids.includes(s.id) && s.statements.includes(text)))) throw new Error('분석 결과의 근거 불일치');
    if (result.status === 'PASS' && req.missing.trim()) throw new Error('확인이 필요한 분석 결과는 PASS로 반환할 수 없습니다.');
  }
  if (result.role === 'resume-writer') {
    const ids = new Set();
    for (const claim of result.claims) {
      if (ids.has(claim.id)) throw new Error('중복 주장 ID');
      ids.add(claim.id);
      if (!claim.sources.every(id => sourceIds.has(id))) throw new Error('작성 결과의 출처 ID 불일치');
    }
    if (result.status === 'PASS' && !result.claims.length) throw new Error('빈 초안 PASS 금지');
    if (result.status === 'PASS' && result.proposed_expressions.some(p => p.confirmation_needed.trim())) throw new Error('새 사실 확인이 필요한 작성 결과는 NEEDS_INPUT이어야 합니다.');
  }
  if (result.role === 'verifier') {
    const ids = result.claim_checks.map(c => c.claim_id);
    if (new Set(ids).size !== ids.length || ids.some(id => !claimIds.has(id))) throw new Error('문장별 의미 검토 ID 불일치');
    if (result.status === 'PASS' && (ids.length !== claimIds.size || !result.claim_checks.every(c => c.supported))) throw new Error('모든 문장의 의미 보존을 검토해야 PASS 가능합니다.');
  }
  return result;
}

// Revalidate persisted results at approval/download time. IDs are traceability, not signatures.
export function independentReviewsPass(results, packet) {
  try {
    if (!Array.isArray(results) || results.length !== 2) return false;
    const seen = new Set();
    const runs = new Set();
    for (const value of results) {
      if (!reviewRoles.includes(value.role) || seen.has(value.role) || runs.has(value.run_id)) return false;
      seen.add(value.role); runs.add(value.run_id);
      const result = validateResult(value, { ...packet, role: value.role, run_id: value.run_id });
      if (result.status !== 'PASS') return false;
    }
    return seen.size === 2;
  } catch { return false; }
}
