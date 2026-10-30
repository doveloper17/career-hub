import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { careers, applications, appDir, readJson, writeJson, textFile } from './store.mjs';
import { sourceStatus, sourceDigest } from './source-approval.mjs';
import { assertReadable, mutate, exclusive } from './transaction.mjs';
import { applicationSchema, provenanceSchema, reviewSchema } from './schema.mjs';
import { independentReviewsPass } from './agent-contract.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function resumeText(meta, claims) {
  const title = meta.kind === 'representative' ? meta.title : `${meta.company} · ${meta.position}`;
  return `# ${title}\n\n${claims.map(c => `- ${c.text} <!-- ${c.id}: ${c.sources.join(', ')} -->`).join('\n')}\n`;
}
export function load(id, root) {
  assertReadable(root);
  const dir = appDir(id, root);
  return { dir, meta: applicationSchema.parse(readJson(path.join(dir, 'metadata.json'))) };
}
export function digest(id, root) {
  const { dir, meta } = load(id, root);
  const { status, approval, retries, ...stable } = meta;
  let sourceIds = [];
  try { sourceIds = [...new Set(readJson(path.join(dir, 'provenance.json')).claims.flatMap(c => c.sources))].sort(); } catch {}
  const all = careers(root);
  const sources = sourceIds.map(id => {
    const c = all.find(c => c.id === id);
    return c ? { id, digest: sourceDigest(c), usable: sourceStatus(c, root).usable } : { id, missing: true };
  });
  return hash(JSON.stringify({ version: 2, stable, sources,
    jd: textFile(dir, 'jd-raw.md'), analysis: textFile(dir, 'jd-analysis.md'), plan: textFile(dir, 'tailoring-plan.md'),
    resume: textFile(dir, 'resume.md'), provenance: textFile(dir, 'provenance.json') }));
}
export function createApplication(input, jd, root) {
  return mutate(root, 'content/applications/' + input.id, () => createApplicationUnlocked(input, jd, root));
}
function createApplicationUnlocked(input, jd, root) {
  if (input.kind !== 'representative' && !jd.trim()) throw new Error('JD 원문이 필요합니다.');
  const meta = applicationSchema.parse({ ...input, status: 'draft', revision: 0, retries: 0, approval: null });
  const dir = appDir(meta.id, root);
  if (fs.existsSync(dir)) throw new Error('이미 존재하는 지원 ID입니다. 덮어쓰지 않습니다.');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'metadata.json'), meta);
  fs.writeFileSync(path.join(dir, 'jd-raw.md'), jd);
  return meta;
}
export function generate(id, root, retry = false) {
  return mutate(root, 'content/applications/' + id, () => generateUnlocked(id, root, retry));
}
function generateUnlocked(id, root, retry = false) {
  const { dir, meta } = load(id, root);
  if (['approved', 'submitted'].includes(meta.status)) throw new Error('승인·제출된 버전은 수정할 수 없습니다. 새 지원 ID를 만드세요.');
  if (retry && meta.retries >= 2) throw new Error('자동 수정 한도 2회에 도달했습니다. 사람의 확인이 필요합니다.');
  const all = careers(root).filter(c => sourceStatus(c, root).usable);
  const ranked = all.map(c => ({ c, matches: meta.keywords.filter(k => [...c.tags, c.title, ...c.statements].join(' ').toLowerCase().includes(k.toLowerCase())) }))
    .filter(v => v.matches.length || meta.kind === 'representative' && !meta.keywords.length).sort((a, b) => b.matches.length - a.matches.length || b.c.start.localeCompare(a.c.start));
  const missing = meta.keywords.filter(k => !ranked.some(v => v.matches.includes(k)));
  const analysis = `# JD 키워드와 경력 연결\n\n입력 키워드 기반 검색이며 JD의 필수·우대 요건에 대한 의미 분석은 사람이 확인합니다.\n\n${ranked.map(v => `- ${v.c.id}: ${v.matches.join(', ')}`).join('\n')}\n\n## 근거가 없는 키워드\n${missing.map(k => `- ${k}`).join('\n') || '- 없음'}\n`;
  fs.writeFileSync(path.join(dir, 'jd-analysis.md'), analysis);
  fs.writeFileSync(path.join(dir, 'tailoring-plan.md'), `# 작성 전략\n\n키워드 일치 수와 최근 경력 순으로 배치합니다.\n\n${ranked.map(v => `- ${v.c.id} — ${v.c.title}`).join('\n')}\n\n근거 없는 요구사항은 추가하지 않습니다. 최종 강조 전략은 사람이 검토합니다.\n`);
  const claims = ranked.flatMap(({ c }) => c.statements.map((text, i) => ({ id: `${c.id}-${i + 1}`, text, sources: [c.id] })));
  meta.revision += 1;
  if (retry) meta.retries += 1;
  meta.approval = null;
  meta.status = claims.length && !missing.length ? 'awaiting_human_approval' : 'needs_human_input';
  writeJson(path.join(dir, 'provenance.json'), { claims });
  fs.writeFileSync(path.join(dir, 'resume.md'), resumeText(meta, claims));
  writeJson(path.join(dir, 'metadata.json'), meta);
  return { selected: ranked.length, missing, status: meta.status };
}
export function verify(id, root) {
  return inspectApplication(id, root, true);
}
// Draft content can be viewed/built before local confirmation, but review/export always require it.
function inspectApplication(id, root, requireConfirmation) {
  const errors = [];
  const { dir, meta } = load(id, root);
  const all = careers(root).filter(c => c.visibility === 'public' && (!requireConfirmation || sourceStatus(c, root).usable));
  const parsed = provenanceSchema.safeParse(readJson(path.join(dir, 'provenance.json')));
  if (!parsed.success) return { passed: false, errors: ['유효한 출처/문장이 없습니다.'], digest: digest(id, root) };
  const { claims } = parsed.data;
  if (new Set(claims.map(c => c.id)).size !== claims.length) errors.push('중복 문장 ID');
  for (const claim of claims) {
    const sources = claim.sources.map(s => all.find(c => c.id === s));
    if (sources.some(s => !s)) errors.push(`${claim.id}: verified 출처가 없거나 원본 승인·공개 범위가 유효하지 않습니다.`);
    if (/TODO|TBD|\[작성 필요\]| {2,}|\t/.test(claim.text)) errors.push(`${claim.id}: 미완성 표현 또는 공백 오류`);
  }
  if (textFile(dir, 'resume.md') !== resumeText(meta, claims)) errors.push('이력서 본문과 출처 목록이 일치하지 않습니다. 출처 없는 문장 또는 변경 내용을 확인하세요.');
  const usedIds = new Set(claims.flatMap(c => c.sources));
  const missing = meta.keywords.filter(k => !all.filter(c => usedIds.has(c.id)).some(c => [...c.tags, c.title, ...c.statements].join(' ').toLowerCase().includes(k.toLowerCase())));
  if (missing.length) errors.push(`근거가 부족한 키워드: ${missing.join(', ')}`);
  if (meta.kind !== 'representative' && !textFile(dir, 'jd-raw.md').trim()) errors.push('JD 원문 없음');
  return { passed: errors.length === 0, kind: 'structure', semanticReviewRequired: true, errors, digest: digest(id, root) };
}
function reviewEvidence(id, root, review) {
  const { dir, meta } = load(id, root);
  return independentReviewsPass(review.agentReviews, { application_id: id, round: meta.retries,
    target_digest: digest(id, root), provenance: readJson(path.join(dir, 'provenance.json')),
    sources: careers(root).filter(c => sourceStatus(c, root).usable) });
}

// Only the trusted runner/coordinator writes drafts. Career originals are never mutated here.
export function saveDraft(id, proposal, expectedDigest, root) {
  return mutate(root, 'content/applications/' + id, () => {
    const { dir, meta } = load(id, root);
    if (['approved', 'submitted'].includes(meta.status)) throw new Error('승인·제출된 버전은 수정할 수 없습니다. 새 지원 ID를 만드세요.');
    if (digest(id, root) !== expectedDigest) throw new Error('초안 저장 전 입력 버전이 변경되었습니다.');
    const parsed = provenanceSchema.parse({ claims: proposal.claims });
    const available = new Set(careers(root).filter(c => sourceStatus(c, root).usable).map(c => c.id));
    if (new Set(parsed.claims.map(c => c.id)).size !== parsed.claims.length || parsed.claims.some(c => c.sources.some(s => !available.has(s)))) throw new Error('초안의 출처 또는 문장 ID가 유효하지 않습니다.');
    writeJson(path.join(dir, 'provenance.json'), parsed);
    fs.writeFileSync(path.join(dir, 'resume.md'), resumeText(meta, parsed.claims));
    fs.writeFileSync(path.join(dir, 'tailoring-plan.md'), proposal.strategy || '');
    meta.revision += 1; meta.approval = null; meta.status = 'awaiting_human_approval';
    writeJson(path.join(dir, 'metadata.json'), meta);
    return verify(id, root);
  });
}
export function reserveRepair(id, target, root) {
  return mutate(root, 'content/applications/' + id, () => {
    const { dir, meta } = load(id, root);
    if (['approved', 'submitted'].includes(meta.status)) throw new Error('승인된 버전의 수정 금지');
    if (meta.retries === target) return meta.retries;
    if (target !== meta.retries + 1 || target > 2) throw new Error('자동 수정 한도 2회 또는 수정 회차 불일치');
    meta.retries = target;
    writeJson(path.join(dir, 'metadata.json'), meta);
    return meta.retries;
  });
}
export function saveAnalysis(id, content, expectedDigest, root) {
  return mutate(root, 'content/applications/' + id, () => {
    const { dir, meta } = load(id, root);
    if (['approved', 'submitted'].includes(meta.status) || digest(id, root) !== expectedDigest) throw new Error('분석 저장 전 버전 변경 또는 승인된 문서');
    fs.writeFileSync(path.join(dir, 'jd-analysis.md'), content);
  });
}
export function recordReview(id, input, root) {
  return mutate(root, 'content/applications/' + id, () => recordReviewUnlocked(id, input, root));
}
function recordReviewUnlocked(id, input, root) {
  const { dir, meta } = load(id, root);
  if (['approved', 'submitted'].includes(meta.status)) throw new Error('승인·제출된 리뷰는 수정할 수 없습니다.');
  const result = verify(id, root);
  if (!result.passed) throw new Error(result.errors.join('\n'));
  const review = reviewSchema.parse({ ...input, digest: result.digest, at: new Date().toISOString() });
  if (review.verdict === 'PASS' && !Object.values(review.checks).every(Boolean)) throw new Error('모든 리뷰 항목을 확인해야 PASS 가능합니다.');
  if (review.verdict === 'PASS' && !reviewEvidence(id, root, review)) throw new Error('현재 버전의 두 독립 리뷰와 모든 문장별 의미 검토 PASS가 필요합니다.');
  writeJson(path.join(dir, 'quality-review.json'), review);
  meta.status = review.verdict === 'PASS' ? 'awaiting_human_approval' : 'review_failed';
  writeJson(path.join(dir, 'metadata.json'), meta);
  return review;
}
export function approve(id, by, root, expectedDigest) {
  return mutate(root, 'content/applications/' + id, () => approveUnlocked(id, by, root, expectedDigest));
}
function approveUnlocked(id, by, root, expectedDigest) {
  if (!by?.trim()) throw new Error('사람 승인자 이름이 필요합니다.');
  const { dir, meta } = load(id, root);
  if (meta.status === 'submitted') throw new Error('제출본은 변경할 수 없습니다.');
  const result = verify(id, root);
  if (!result.passed) throw new Error(result.errors.join('\n'));
  if (expectedDigest !== result.digest) throw new Error('직접 확인한 현재 digest 값이 필요합니다.');
  const review = reviewSchema.parse(readJson(path.join(dir, 'quality-review.json')));
  if (review.digest !== result.digest || review.verdict !== 'PASS' || !Object.values(review.checks).every(Boolean) || !reviewEvidence(id, root, review)) throw new Error('현재 버전에 대한 모든 항목 PASS 리뷰가 필요합니다.');
  meta.status = 'approved';
  meta.approval = { by, digest: result.digest, at: new Date().toISOString() };
  writeJson(path.join(dir, 'metadata.json'), meta);
  return meta;
}
export function snapshot(id, root) {
  return mutate(root, 'content/applications/' + id, () => snapshotUnlocked(id, root));
}
function snapshotUnlocked(id, root) {
  const { dir, meta } = load(id, root);
  const result = verify(id, root);
  if (meta.status !== 'approved' || !submissionState(id, root).approved) throw new Error('현재 버전에 대한 사람 승인이 필요합니다.');
  const target = path.join(dir, 'submissions', `v${meta.revision}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target, { recursive: false });
  for (const f of ['metadata.json', 'jd-raw.md', 'resume.md', 'provenance.json', 'quality-review.json', 'jd-analysis.md', 'tailoring-plan.md']) fs.copyFileSync(path.join(dir, f), path.join(target, f), fs.constants.COPYFILE_EXCL);
  writeJson(path.join(target, 'snapshot.json'), { digest: result.digest, at: new Date().toISOString(), note: '로컬 고정본. 실제 지원 사이트 제출은 별도 작업.' });
  meta.status = 'submitted';
  writeJson(path.join(dir, 'metadata.json'), meta);
  return target;
}
export function validateAll(root) {
  const cs = careers(root);
  const apps = applications(root);
  const errors = [];
  for (const app of apps) {
    if (app.kind !== 'representative' && !textFile(app.dir, 'jd-raw.md').trim()) errors.push(`${app.id}: JD 없음`);
    if (app.revision > 0) {
      const result = inspectApplication(app.id, root, false);
      if (!result.passed) errors.push(...result.errors.map(e => `${app.id}: ${e}`));
      if (['approved', 'submitted'].includes(app.status) && !submissionState(app.id, root).approved) errors.push(`${app.id}: 승인 또는 리뷰가 만료되었습니다.`);
    }
  }
  return { careers: cs.length, applications: apps.length, errors };
}

/** Computed from current content; stored status is not an authorization decision. */
export function submissionState(id, root) {
  const { dir, meta } = load(id, root);
  if (!meta.revision) return { status: 'draft', passed: false, reviewed: false, approved: false, downloadable: false, digest: '', errors: [], review: null };
  let result;
  try { result = verify(id, root); }
  catch { result = { passed: false, digest: '', errors: ['자료가 누락되거나 손상되었습니다. 검증 후 다시 시도하세요.'] }; }
  let review = null;
  try {
    const parsed = reviewSchema.safeParse(readJson(path.join(dir, 'quality-review.json')));
    if (parsed.success) review = parsed.data;
  } catch {}
  const current = review && review.digest === result.digest;
  const reviewed = !!(result.passed && current && review.verdict === 'PASS' && Object.values(review.checks).every(Boolean) && reviewEvidence(id, root, review));
  const approved = !!(reviewed && ['approved', 'submitted'].includes(meta.status) && meta.approval?.by?.trim() && meta.approval.digest === result.digest);
  const status = !result.passed ? 'verification_failed' : current && review.verdict === 'FAIL' ? 'review_failed' :
    approved ? meta.status : 'awaiting_human_approval';
  return { ...result, status, reviewed, approved, downloadable: approved, review };
}
export function applicationViews(root) {
  return applications(root).map(app => ({ ...app, status: submissionState(app.id, root).status }));
}
export function submissionText(id, root) {
  return exclusive(root, () => {
    const state = submissionState(id, root);
    if (!state.downloadable) throw new Error('제출 차단: 현재 원본 검증·PASS 리뷰·사람 승인이 모두 필요합니다.');
    const { dir } = load(id, root);
    return textFile(dir, 'resume.md');
  });
}
export function verifyAndRecord(id, root) {
  return mutate(root, 'content/applications/' + id, () => {
    const result = verify(id, root);
    const { dir } = load(id, root);
    writeJson(path.join(dir, 'fact-review.json'), result);
    return result;
  });
}
