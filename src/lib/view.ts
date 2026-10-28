import { marked } from 'marked';
import sanitize from 'sanitize-html';
export function markdown(text: string) {
  return sanitize(marked.parse(text, { async: false }) as string, { allowedTags: sanitize.defaults.allowedTags.concat(['details', 'summary']), allowedAttributes: { a: ['href', 'title'], '*': ['id'] }, allowedSchemes: ['http', 'https', 'mailto'] });
}
export const labels: Record<string, string> = {
  draft: '작성 전', needs_human_input: '정보 확인 필요', verification_failed: '사실 검증 실패',
  review_failed: '리뷰 수정 필요', awaiting_human_approval: '검토 대기', approved: '승인 완료', submitted: '고정본 보관',
  company: '회사 경력', project: '개인 프로젝트', study: '스터디',
};
