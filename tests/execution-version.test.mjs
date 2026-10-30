import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureExecutionVersion } from '../lib/execution-version.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['lib', 'scripts', 'docs', '.codex']) fs.cpSync(name, path.join(root, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'AGENTS.md']) fs.copyFileSync(name, path.join(root, name));
  return root;
}

test('실행 버전은 코드·규칙·실효 프롬프트·스키마·모델·추론 설정을 기록한다', t => {
  const root = fixture(t), first = captureExecutionVersion(undefined, root);
  assert.equal(first.sourceCommit, null);
  assert.equal(first.contractVersion, 1);
  assert.equal(first.roles.length, 4);
  assert.ok(first.roles.every(role => role.model === 'gpt-6.1-sol' && role.effort === 'medium' && role.promptDigest.length === 64 && role.schemaDigest.length === 64));
  fs.appendFileSync(path.join(root, 'lib/handoff.mjs'), '\n// test change\n');
  const code = captureExecutionVersion(undefined, root);
  assert.notEqual(code.codeDigest, first.codeDigest);
  fs.appendFileSync(path.join(root, 'docs/SUBAGENTS.md'), '\n추가 실행 규약\n');
  const rule = captureExecutionVersion(undefined, root);
  assert.notEqual(rule.rulesDigest, code.rulesDigest);
  assert.notEqual(rule.roles[0].promptDigest, code.roles[0].promptDigest);
  const model = captureExecutionVersion('test-model', root);
  assert.notEqual(model.fingerprint, rule.fingerprint);
  assert.equal(model.modelOverride, 'test-model');
  fs.appendFileSync(path.join(root, '.codex/agents/verifier.toml'), '\n# rule comment\n');
  assert.notEqual(captureExecutionVersion('test-model', root).fingerprint, model.fingerprint);
});

test('콘텐츠·로그·기본 정책과 실행에 쓰이지 않는 문서 변경은 실행 버전을 바꾸지 않는다', t => {
  const root = fixture(t), before = captureExecutionVersion(undefined, root);
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'content/local.md'), '사용자 경력은 이 해시의 대상이 아님');
  fs.mkdirSync(path.join(root, '.local'));
  fs.writeFileSync(path.join(root, '.local/WORK_LOG.md'), '개인 개발 일지');
  fs.writeFileSync(path.join(root, 'workflow-policy.json'), '{}');
  fs.appendFileSync(path.join(root, 'docs/EXECUTOR.md'), '\n안내 설명\n');
  fs.writeFileSync(path.join(root, 'README.md'), '안내 설명');
  assert.equal(captureExecutionVersion(undefined, root).fingerprint, before.fingerprint);
});

test('커밋 ID는 기록하지만 실행 파일이 같은 문서 전용 커밋은 버전 불일치가 아니다', t => {
  const root = fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('commit', '-m', 'fixture');
  const before = captureExecutionVersion(undefined, root);
  fs.writeFileSync(path.join(root, 'README.md'), '설명만 변경');
  git('add', 'README.md'); git('commit', '-m', 'docs');
  const after = captureExecutionVersion(undefined, root);
  assert.notEqual(after.sourceCommit, before.sourceCommit);
  assert.equal(after.fingerprint, before.fingerprint);
});
