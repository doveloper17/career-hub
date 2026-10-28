import { applications, textFile } from '../../../../lib/store.mjs';
import type { APIRoute } from 'astro';
export const GET: APIRoute = ({ params }) => {
  const app = applications().find(item => item.id === params.id && item.revision > 0);
  if (!app) return new Response('생성된 이력서가 없습니다.', { status: 404 });
  return new Response(textFile(app.dir, 'resume.md'), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
