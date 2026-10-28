export function isLocalOnlyPath(file) {
  const normalized = file.replaceAll('\\', '/');
  return normalized.split('/').includes('.local') || /(^|\/)WORK_LOG(?:\.[^/]*)?\.md$/i.test(normalized);
}
