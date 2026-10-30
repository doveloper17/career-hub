import { Marked } from 'marked';
import sanitize from 'sanitize-html';
const parser = new Marked({ renderer: {
  code({ text, lang }) {
    if (lang?.trim() !== 'mermaid') return false;
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<pre class="mermaid"><code>${escaped}</code></pre>`;
  },
} });
export function markdown(text: string) {
  return sanitize(parser.parse(text, { async: false }) as string, { allowedTags: sanitize.defaults.allowedTags.concat(['details', 'summary']), allowedAttributes: { a: ['href', 'title'], pre: ['class'], '*': ['id'] }, allowedClasses: { pre: ['mermaid'] }, allowedSchemes: ['http', 'https', 'mailto'] });
}
export const labels: Record<string, string> = {
  draft: '작성 전', needs_human_input: '정보 확인 필요', verification_failed: '사실 검증 실패',
  review_failed: '리뷰 수정 필요', awaiting_human_approval: '검토 대기', approved: '승인 완료', submitted: '고정본 보관',
  company: '회사 경력', project: '개인 프로젝트', study: '스터디',
};
