import { defineMiddleware } from 'astro:middleware';
import { assertReadable } from '../lib/transaction.mjs';

export const onRequest = defineMiddleware(async (_context, next) => {
  try { assertReadable(); }
  catch { return new Response('저장 중이거나 중단된 작업이 있습니다. 작업 종료 또는 명시적 복구 후 새로고침하세요.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } }); }
  const response = await next();
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
