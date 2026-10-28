import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { careers, readJson, writeJson } from './store.mjs';
import { mutate } from './transaction.mjs';

export function sourceDigest(record) {
  const { file, ...data } = record;
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
const receiptPath = (id, root) => path.join(root, '.local', 'source-approvals', id + '.json');
export function sourceStatus(record, root = process.cwd()) {
  if (record.visibility !== 'public') return { usable: false, reason: '비공개 경력: 제출 문장에 사용 금지' };
  if (record.fictional) return { usable: true, reason: '가상 샘플(실제 제출 금지)' };
  try {
    const receipt = readJson(receiptPath(record.id, root));
    const usable = receipt.id === record.id && receipt.digest === sourceDigest(record) &&
      typeof receipt.by === 'string' && !!receipt.by.trim() && !Number.isNaN(Date.parse(receipt.at));
    return { usable, reason: usable ? '현재 원본 확인 기록 있음' : '원본 변경 또는 승인 기록 오류' };
  } catch { return { usable: false, reason: '현재 원본의 사람 확인 기록 없음' }; }
}
export function confirmSource(id, by, expectedDigest, root = process.cwd()) {
  if (!/^EXP-[A-Z0-9-]+$/.test(id)) throw new Error('유효한 경력 ID 필요');
  return mutate(root, '.local/source-approvals/' + id + '.json', () => {
    const record = careers(root).find(c => c.id === id);
    if (!record || record.fictional) throw new Error('실제 경력만 원본 승인 대상으로 지정하세요.');
    if (!by?.trim() || expectedDigest !== sourceDigest(record)) throw new Error('확인자와 직접 확인한 현재 source-digest 값이 필요합니다.');
    const receipt = { id, by: by.trim(), digest: expectedDigest, at: new Date().toISOString() };
    const target = receiptPath(id, root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJson(target, receipt);
    return receipt;
  });
}
