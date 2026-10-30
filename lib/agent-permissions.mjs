import path from 'node:path';
import { careers, textFile, readJson } from './store.mjs';
import { sourceStatus, sourceDigest } from './source-approval.mjs';
import { digest, load, verify } from './workflow.mjs';
import { exclusive } from './transaction.mjs';
import { inspect } from '../scripts/secrets.mjs';
import { assertRole, reviewRoles, findingSchema } from './agent-contract.mjs';
export { roles, reviewRoles, checksFor, assertRole, packetHash, resultSchema, validateResult } from './agent-contract.mjs';
import crypto from 'node:crypto';


// Rebuild a minimal packet from trusted local data, never forward a caller's raw object.
export function preparePacket(id, role, root = process.cwd(), options = {}) {
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
      run_id: options.runId || crypto.randomUUID(), application_id: id, role, round: meta.retries,
      target_digest: digest(id, root),
      purpose: title || position, metadata: { company, position, kind: kind || 'application', title: title || '', keywords },
      jd: textFile(dir, 'jd-raw.md'), sources,
      ...(isReview ? { resume: textFile(dir, 'resume.md'), provenance } : {}),
      ...(role === 'resume-writer' ? { analysis: textFile(dir, 'jd-analysis.md'), draft: textFile(dir, 'resume.md'),
        feedback: (options.feedback || []).map(f => findingSchema.parse(f)) } : {}),
    };
    const encoded = JSON.stringify(packet);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('입력 패킷이 너무 큽니다. 자료 범위를 줄이세요.');
    if (inspect('agent-packet.json', encoded).length) throw new Error('전달 자료에 비밀정보 의심 패턴이 있습니다. 값은 출력하지 않습니다.');
    return packet;
  });
}

export function minimalEnvironment(env = process.env) {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CODEX_HOME'];
  return Object.fromEntries(allowed.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
}
