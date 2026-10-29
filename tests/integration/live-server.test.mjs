import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApplication, generate, recordReview, approve, digest } from '../../lib/workflow.mjs';
import { careers } from '../../lib/store.mjs';
import { confirmSource, sourceDigest } from '../../lib/source-approval.mjs';

test('실행 중 추가한 경력·지원·다운로드가 재시작 없이 열리고 삭제 시 404가 된다', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-live-'));
  fs.cpSync('content', path.join(root, 'content'), { recursive: true });
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const server = spawn(process.execPath, [path.resolve('scripts/start-server.mjs')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'pipe',
  });
  let logs = '';
  server.stdout.on('data', b => { logs += b; });
  server.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    if (server.exitCode === null) { const stopped = once(server, 'exit'); server.kill(); await stopped; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(url)).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const home = await (await fetch(url)).text();
  assert.doesNotMatch(home, /fictional|가상 예시는/);
  const representativePage = await (await fetch(url + '/resumes/')).text();
  assert.match(representativePage, /대표 이력서/);
  assert.doesNotMatch(representativePage, /가상 샘플/);
  const realFile = path.join(root, 'content/career/verified/companies/real-test.md');
  fs.writeFileSync(realFile, fs.readFileSync('content/career/verified/companies/morrow.md', 'utf8')
    .replaceAll('EXP-MORROW-001', 'EXP-REAL-001').replace('slug: morrow-api', 'slug: real-test'));
  const real = careers(root).find(c => c.id === 'EXP-REAL-001');
  confirmSource(real.id, '테스트 승인자', sourceDigest(real), root);
  createApplication({ id: 'real-export', company: '테스트', position: 'Backend', createdAt: '2026-10-29', deadline: null, jdUrl: null, keywords: ['Kotlin'] }, 'Kotlin JD', root);
  generate('real-export', root);
  const download = url + '/applications/real-export/resume.md';
  assert.equal((await fetch(download)).status, 403);
  recordReview('real-export', { reviewer: '테스트 검토자', verdict: 'PASS', checks: { hiring: true, naturalness: true, spelling: true, confidentiality: true }, notes: '테스트 기록' }, root);
  approve('real-export', '테스트 승인자', root, digest('real-export', root));
  assert.equal((await fetch(download)).status, 200);
  fs.appendFileSync(path.join(root, 'content/applications/real-export/jd-raw.md'), '\n변경');
  assert.equal((await fetch(download)).status, 403);
  const lock = path.join(root, '.local/workflow-lock');
  fs.mkdirSync(lock);
  assert.equal((await fetch(download)).status, 503);
  fs.rmdirSync(lock);
  createApplication({ id: 'runtime-main', kind: 'representative', title: '실행 중 대표 이력서', company: '', position: '', createdAt: '2026-10-28', deadline: null, jdUrl: null, keywords: [] }, '', root);
  generate('runtime-main', root);
  assert.match(await (await fetch(url + '/resumes/')).text(), /실행 중 대표 이력서/);
  assert.doesNotMatch(await (await fetch(url + '/applications/')).text(), /실행 중 대표 이력서/);
  assert.equal((await fetch(url + '/applications/runtime-main/')).status, 200);
  assert.equal((await fetch(url + '/applications/runtime-main/resume.md')).status, 403);
  assert.equal((await fetch(`${url}/applications/runtime-added/`)).status, 404);
  assert.equal((await fetch(`${url}/career/runtime-career/`)).status, 404);
  const careerFile = path.join(root, 'content/career/verified/companies/runtime.md');
  fs.writeFileSync(careerFile, fs.readFileSync('content/career/verified/companies/morrow.md', 'utf8')
    .replaceAll('EXP-MORROW-001', 'EXP-RUNTIME-001').replace('slug: morrow-api', 'slug: runtime-career'));
  createApplication({ id: 'runtime-added', company: '실행 중 추가 가상 회사', position: 'Backend', createdAt: '2026-10-28', deadline: null, jdUrl: null, keywords: ['Kotlin'] }, 'Kotlin 가상 JD', root);
  generate('runtime-added', root);
  for (const route of ['/career/runtime-career/', '/applications/runtime-added/']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(url + '/applications/runtime-added/resume.md')).status, 403);
  assert.match(await (await fetch(url + '/applications/')).text(), /실행 중 추가 가상 회사/);
  assert.match(await (await fetch(url + '/career/')).text(), /runtime-career/);
  fs.rmSync(path.join(root, 'content/applications/runtime-added'), { recursive: true });
  fs.unlinkSync(careerFile);
  assert.equal((await fetch(url + '/applications/runtime-added/')).status, 404);
  assert.equal((await fetch(url + '/applications/runtime-added/resume.md')).status, 404);
  assert.equal((await fetch(url + '/career/runtime-career/')).status, 404);
});
