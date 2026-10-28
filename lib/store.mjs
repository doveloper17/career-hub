import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { careerSchema, applicationSchema, slug } from './schema.mjs';

export function dataRoot(root = process.cwd()) { return path.join(root, 'content'); }
/** @param {string} dir @param {string} suffix @returns {string[]} */
export function files(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`심볼릭 링크 데이터 금지: ${p}`);
    return e.isDirectory() ? files(p, suffix) : p.endsWith(suffix) ? [p] : [];
  });
}
export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }
/** @returns {(import('zod').infer<typeof careerSchema> & {body: string, file: string})[]} */
export function careers(root = process.cwd()) {
  const entries = files(path.join(dataRoot(root), 'career/verified'), '.md').map(file => {
    const { data, content } = matter(fs.readFileSync(file, 'utf8'));
    const parsed = careerSchema.parse(data);
    return { ...parsed, body: content, file };
  });
  for (const key of ['id', 'slug']) if (new Set(entries.map(e => e[key])).size !== entries.length) throw new Error(`중복 경력 ${key}`);
  return entries;
}
export function appDir(id, root = process.cwd()) {
  slug.parse(id);
  const dir = path.join(dataRoot(root), 'applications', id);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('지원 디렉터리 심볼릭 링크 금지');
  return dir;
}
/** @returns {(import('zod').infer<typeof applicationSchema> & {dir: string})[]} */
export function applications(root = process.cwd()) {
  return files(path.join(dataRoot(root), 'applications'), 'metadata.json').filter(file => !file.split(path.sep).includes('submissions')).map(file => {
    const data = applicationSchema.parse(readJson(file));
    if (path.basename(path.dirname(file)) !== data.id) throw new Error('지원 ID와 폴더명 불일치');
    return { ...data, dir: path.dirname(file) };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function textFile(dir, name) { const p = path.join(dir, name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
