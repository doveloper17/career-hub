import { applications } from '../../../../lib/store.mjs';
import { submissionText } from '../../../../lib/workflow.mjs';
import type { APIRoute } from 'astro';
export const GET: APIRoute = ({ params }) => {
  try {
    const app = applications().find(item => item.id === params.id && item.revision > 0);
    if (!app) return new Response('생성된 이력서가 없습니다.', { status: 404 });
    return new Response(submissionText(app.id), { headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + app.id + '-approved.md"',
      'Cache-Control': 'no-store',
    } });
  } catch {
    return new Response('제출 차단: 실제 이력서의 최신 검증·PASS 리뷰·사람 승인이 필요합니다. 저장 중이거나 복구가 필요한 경우에도 다운로드할 수 없습니다.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
};
