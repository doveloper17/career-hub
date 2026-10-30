import { z } from 'zod';

export const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, '유효한 날짜 필요');
const careerPeriod = z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/).refine(v => {
  if (/^\d{4}-\d{2}$/.test(v)) return Number(v.slice(5, 7)) >= 1 && Number(v.slice(5, 7)) <= 12;
  return !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
}, '유효한 경력 기간 필요');
export const careerSchema = z.object({
  id: z.string().regex(/^EXP-[A-Z0-9-]+$/), slug, title: z.string().min(1),
  company: z.string().min(1), kind: z.enum(['company', 'project', 'study']),
  role: z.string().min(1), start: careerPeriod, end: careerPeriod.nullable(),
  status: z.literal('verified'),
  visibility: z.enum(['public', 'private']), confirmedBy: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1), problem: z.string().min(1),
  action: z.string().min(1), result: z.string().min(1), contribution: z.string().min(1),
  statements: z.array(z.string().min(1)).min(1),
}).refine(v => !v.end || v.start <= v.end, '종료일은 시작일 이후여야 함');

export const statuses = ['draft', 'needs_human_input', 'verification_failed', 'review_failed', 'awaiting_human_approval', 'approved', 'submitted'];
export const applicationSchema = z.object({
  id: slug, company: z.string(), position: z.string(),
  kind: z.enum(['application', 'representative']).optional(),
  title: z.string().trim().min(1).optional(),
  createdAt: date, deadline: date.nullable(), jdUrl: z.url({ protocol: /^https?$/ }).nullable(),
  keywords: z.array(z.string().min(1)),
  status: z.enum(statuses), revision: z.number().int().nonnegative(),
  retries: z.number().int().min(0).max(2),
  approval: z.object({ digest: z.string(), by: z.string().min(1), at: z.string() }).nullable(),
}).refine(v => v.kind === 'representative'
  ? !!v.title
  : !!v.company.trim() && !!v.position.trim() && v.keywords.length > 0,
  '대표 이력서는 제목, 지원 이력서는 회사·포지션·키워드가 필요합니다.');

export const provenanceSchema = z.object({
  claims: z.array(z.object({ id: z.string(), text: z.string().min(1), sources: z.array(z.string()).min(1) })).min(1),
});
export const reviewSchema = z.object({
  digest: z.string(), verdict: z.enum(['PASS', 'FAIL']), reviewer: z.string().min(1),
  checks: z.object({ hiring: z.boolean(), naturalness: z.boolean(), spelling: z.boolean(), confidentiality: z.boolean() }),
  notes: z.string().min(1), at: z.string(),
});
