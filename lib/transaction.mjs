import fs from 'node:fs';
import path from 'node:path';

const active = new Set();
const lockPath = root => path.join(path.resolve(root), '.local', 'workflow-lock');
export function assertReadable(root = process.cwd()) {
  if (!active.has(path.resolve(root)) && fs.existsSync(lockPath(root))) throw new Error('저장 중이거나 중단된 작업이 있습니다. 복구 전에는 읽기·제출할 수 없습니다.');
}
function noLinks(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('트랜잭션 대상 심볼릭 링크 금지');
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) noLinks(path.join(target, name));
}
export function exclusive(root = process.cwd(), fn) {
  root = path.resolve(root);
  if (active.has(root)) return fn();
  const lock = lockPath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch { throw new Error('다른 저장 작업 또는 중단된 작업이 있습니다. 자동 잠금 해제는 하지 않습니다.'); }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  active.add(root);
  try { return fn(); }
  finally {
    active.delete(root);
    // A journal survives a crash/failed rollback and must be recovered explicitly.
    if (!fs.existsSync(path.join(lock, 'journal.json'))) fs.rmSync(lock, { recursive: true });
  }
}
function targetPath(root, relative) {
  if (!/^(content\/applications\/[a-z0-9]+(?:-[a-z0-9]+)*|(?:content|\.local)\/source-approvals\/EXP-[A-Z0-9-]+\.json)$/.test(relative)) throw new Error('잘못된 복구 대상');
  const target = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('경로의 심볼릭 링크 금지');
  }
  noLinks(target);
  return target;
}
function restore(root, lock, journal) {
  const target = targetPath(root, journal.relative);
  const backup = path.join(lock, 'backup');
  if (journal.existed && !fs.existsSync(backup)) throw new Error('복구 백업이 없습니다. 잠금을 보존합니다.');
  if (journal.existed) noLinks(backup);
  fs.rmSync(target, { recursive: true, force: true });
  if (journal.existed) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(backup, target, { recursive: true }); }
}
export function mutate(root = process.cwd(), relative, fn) {
  return exclusive(root, () => {
    const lock = lockPath(root);
    const target = targetPath(root, relative);
    const journal = { relative, existed: fs.existsSync(target) };
    if (journal.existed) fs.cpSync(target, path.join(lock, 'backup'), { recursive: true });
    fs.writeFileSync(path.join(lock, 'journal.json'), JSON.stringify(journal), { flag: 'wx' });
    try {
      const result = fn();
      fs.unlinkSync(path.join(lock, 'journal.json'));
      return result;
    } catch (error) {
      restore(root, lock, journal);
      fs.unlinkSync(path.join(lock, 'journal.json'));
      throw error;
    }
  });
}
// Run only after confirming all writers are stopped. Never automatically infer a stale lock.
export function recover(root = process.cwd()) {
  const lock = lockPath(root);
  const journalFile = path.join(lock, 'journal.json');
  if (!fs.existsSync(lock)) return '복구할 작업이 없습니다.';
  const ownerFile = path.join(lock, 'owner.json');
  if (fs.existsSync(ownerFile)) {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('잠금 소유자 정보 오류');
    let running = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running) throw new Error('잠금 소유 프로세스가 실행 중입니다. 작업 종료 후 복구하세요.');
  }
  if (fs.existsSync(journalFile)) {
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    if (typeof journal.existed !== 'boolean') throw new Error('복구 기록 형식 오류');
    restore(root, lock, journal);
  }
  fs.rmSync(lock, { recursive: true });
  return '중단된 작업의 변경 전 자료를 복구했습니다.';
}
