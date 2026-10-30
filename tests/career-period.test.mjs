import test from 'node:test';
import assert from 'node:assert/strict';
import { careerSchema } from '../lib/schema.mjs';

const base = {
  id: 'EXP-PERIOD-001', slug: 'period-test', title: '기간 테스트', company: '회사', kind: 'company',
  role: '개발자', status: 'verified', visibility: 'public', confirmedBy: '본인', tags: ['Java'],
  problem: '문제', action: '행동', result: '결과', contribution: '기여', statements: ['확인한 문장'],
};

test('경력 기간은 월 단위 값을 보존한다', () => {
  const parsed = careerSchema.parse({ ...base, start: '2024-03', end: '2025-08' });
  assert.equal(parsed.start, '2024-03');
  assert.equal(parsed.end, '2025-08');
});

test('유효하지 않은 월 단위 값은 거부한다', () => {
  assert.throws(() => careerSchema.parse({ ...base, start: '2024-13', end: null }));
});
