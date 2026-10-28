import crypto from 'node:crypto';

// Inspect Git blobs, not working-tree files. Unknown/changed data is private by default.
export function assertTemplateData(paths, read, manifest) {
  for (const file of paths.filter(p => p.startsWith('content/'))) {
    const hash = crypto.createHash('sha256').update(read(file)).digest('hex');
    if (manifest[file] !== hash) throw new Error('공개 템플릿에 등록되지 않은 데이터 또는 변경된 데이터: ' + file);
  }
}
