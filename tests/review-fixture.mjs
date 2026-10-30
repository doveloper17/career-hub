// Synthetic model results for temporary fixtures only. Never used by production code.
import { preparePacket, checksFor } from '../lib/agent-permissions.mjs';
import { recordReview } from '../lib/workflow.mjs';
export function passingResult(packet) {
  const result = { run_id: packet.run_id, application_id: packet.application_id, role: packet.role, round: packet.round,
    target_digest: packet.target_digest, status: 'PASS', summary: '테스트 전용 검토', findings: [], questions: [] };
  if (['verifier', 'feedback-coach'].includes(packet.role)) result.checks = Object.fromEntries(checksFor(packet.role).map(k => [k, true]));
  if (packet.role === 'verifier') result.claim_checks = packet.provenance.claims.map(c => ({ claim_id: c.id, supported: true, reason: '테스트 fixture의 의미 검토 대역' }));
  return result;
}
export function evidence(id, root) {
  return ['verifier', 'feedback-coach'].map(role => passingResult(preparePacket(id, role, root)));
}
export function review(id, input, root) {
  return recordReview(id, { ...input, agentReviews: input.agentReviews || (input.verdict === 'PASS' ? evidence(id, root) : undefined) }, root);
}
