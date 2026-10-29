import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { careers, textFile, readJson } from './store.mjs';
import { sourceStatus, sourceDigest } from './source-approval.mjs';
import { digest, load, verify } from './workflow.mjs';
import { exclusive } from './transaction.mjs';
import { inspect } from '../scripts/secrets.mjs';

export const roles = ['job-market-analyst', 'resume-writer', 'verifier', 'feedback-coach'];
export const reviewRoles = ['verifier', 'feedback-coach'];
export const checksFor = role => role === 'verifier' ? ['factuality', 'provenance', 'context'] :
  role === 'feedback-coach' ? ['hiring', 'naturalness', 'spelling', 'confidentiality'] : [];
export function assertRole(role) { if (!roles.includes(role)) throw new Error('지원하지 않는 에이전트 역할'); }
export const packetHash = packet => crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');

// Rebuild a minimal packet from trusted local data, never forward a caller's raw object.
export function preparePacket(id, role, root = process.cwd()) {
  assertRole(role);
  return exclusive(root, () => {
    const { dir, meta } = load(id, root);
    const isReview = reviewRoles.includes(role);
    if (isReview && !verify(id, root).passed) throw new Error('현재 코드 검증을 통과한 이력서만 검토할 수 있습니다.');
    const provenance = isReview ? readJson(path.join(dir, 'provenance.json')) : null;
    const used = new Set(provenance?.claims.flatMap(c => c.sources) || []);
    const sources = careers(root).filter(c => sourceStatus(c, root).usable &&
      (!isReview || used.has(c.id))).map(c => {
      // Do not forward file paths, confirmedBy, approval receipts, private records or unrelated history.
      const { id, title, company, kind, role, start, end, tags, problem, action, result, contribution, statements, body, visibility } = c;
      return { id, title, company, kind, role, start, end, tags, problem, action, result, contribution, statements, body,
        visibility, usable: true, source_digest: sourceDigest(c) };
    });
    if (!sources.length) throw new Error('사용 가능한 확인 경력이 없습니다.');
    const { company, position, kind, title, keywords } = meta;
    const packet = {
      run_id: crypto.randomUUID(), application_id: id, role, round: meta.retries,
      target_digest: digest(id, root),
      purpose: title || position, metadata: { company, position, kind: kind || 'application', title: title || '', keywords },
      jd: textFile(dir, 'jd-raw.md'), sources,
      ...(isReview ? { resume: textFile(dir, 'resume.md'), provenance } : {}),
      ...(role === 'resume-writer' ? { analysis: textFile(dir, 'jd-analysis.md') } : {}),
    };
    const encoded = JSON.stringify(packet);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('입력 패킷이 너무 큽니다. 자료 범위를 줄이세요.');
    if (inspect('agent-packet.json', encoded).length) throw new Error('전달 자료에 비밀정보 의심 패턴이 있습니다. 값은 출력하지 않습니다.');
    return packet;
  });
}

const finding = z.strictObject({ claim_id: z.string(), source_ids: z.array(z.string()), text: z.string(), reason: z.string().min(1), acceptance_criteria: z.string().min(1) });
export function resultSchema(role) {
  assertRole(role);
  const base = {
    run_id: z.string(), application_id: z.string(), role: z.literal(role), round: z.number().int().min(0).max(2),
    target_digest: z.string(), status: z.enum(['PASS', 'FAIL', 'NEEDS_INPUT']), summary: z.string().min(1),
    findings: z.array(finding), questions: z.array(z.string()),
  };
  if (reviewRoles.includes(role)) base.checks = z.strictObject(Object.fromEntries(checksFor(role).map(k => [k, z.boolean()])));
  if (role === 'job-market-analyst') base.requirements = z.array(z.strictObject({ requirement: z.string(), source_ids: z.array(z.string()), evidence: z.array(z.string()), missing: z.string() }));
  if (role === 'resume-writer') {
    base.claims = z.array(z.strictObject({ id: z.string(), text: z.string(), sources: z.array(z.string()).min(1) }));
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
    if (req.source_ids.some(id => !sourceIds.has(id)) || req.evidence.some(text => !packet.sources.some(s => req.source_ids.includes(s.id) && s.statements.includes(text)))) throw new Error('분석 결과의 근거 불일치');
    if (result.status === 'PASS' && req.missing.trim()) throw new Error('확인이 필요한 분석 결과는 PASS로 반환할 수 없습니다.');
  }
  if (result.role === 'resume-writer') {
    const ids = new Set();
    for (const claim of result.claims) {
      if (ids.has(claim.id)) throw new Error('중복 주장 ID');
      ids.add(claim.id);
      if (!claim.sources.every(id => packet.sources.some(s => s.id === id && s.statements.includes(claim.text)))) throw new Error('원본과 다른 작성 결과');
    }
    if (result.status === 'PASS' && !result.claims.length) throw new Error('빈 초안 PASS 금지');
  }
  return result;
}

export function minimalEnvironment(env = process.env) {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CODEX_HOME'];
  return Object.fromEntries(allowed.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
}
