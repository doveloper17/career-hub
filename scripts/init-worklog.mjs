import fs from 'node:fs';
fs.mkdirSync('.local', { recursive: true });
try {
  fs.copyFileSync('templates/work-log.md', '.local/WORK_LOG.md', fs.constants.COPYFILE_EXCL);
  console.log('.local/WORK_LOG.md 생성 완료. Git에 포함하지 않습니다.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('기존 .local/WORK_LOG.md를 보존했습니다. 해당 기록에서 이어서 작업하세요.');
}
