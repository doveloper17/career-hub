import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { inspect } from '../scripts/secrets.mjs';
const token = ['gh','p_','a'.repeat(36)].join('');
test('토큰·키 파일·환경 파일을 검출하고 실제 값은 반환하지 않는다', () => {
  const results = inspect('example.txt', token);
  assert.ok(results.length); assert.ok(!JSON.stringify(results).includes(token));
  assert.ok(inspect('.env','').length);
  assert.ok(inspect('server.pem','').length);
  assert.equal(inspect('.env.example','PORT=').length,0);
});
test('pre-commit은 작업 파일이 깨끗해도 staged 비밀정보를 차단한다', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'career-git-test-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const git = (...args) => execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git('init');
  fs.writeFileSync(path.join(root,'example.txt'),token);
  git('add','example.txt');
  fs.writeFileSync(path.join(root,'example.txt'),'clean');
  const result = spawnSync(process.execPath,[path.resolve('scripts/secrets.mjs'),'--staged'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,1); assert.match(result.stdout,/서비스 토큰/); assert.ok(!result.stdout.includes(token));
});
test('pre-push는 upstream과 승인 없는 origin을 차단한다', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'career-push-test-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init'],{cwd:root,stdio:'pipe'});
  fs.writeFileSync(path.join(root,'repository.json'),JSON.stringify({mode:'public-template'}));
  const guard = path.resolve('scripts/git-guard.mjs');
  const upstream = spawnSync(process.execPath,[guard,'push','upstream','example'],{cwd:root,encoding:'utf8'});
  assert.equal(upstream.status,1); assert.match(upstream.stderr,/origin 외 push 금지/);
  const origin = spawnSync(process.execPath,[guard,'push','origin','example'],{cwd:root,input:'',encoding:'utf8'});
  assert.equal(origin.status,1);
});
