#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createApplication, generate, verify, recordReview, approve, snapshot, validateAll, verifyAndRecord } from '../lib/workflow.mjs';
import { digest } from '../lib/workflow.mjs';
import { careers } from '../lib/store.mjs';
import { confirmSource, sourceDigest, sourceStatus } from '../lib/source-approval.mjs';
import { recover } from '../lib/transaction.mjs';

const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['digest','title','id','company','position','jd','keywords','url','deadline','reviewer','notes','by'].map(k => [k,{ type: 'string' }]).concat(['fictional','confirm','hiring','naturalness','spelling','confidentiality','fail'].map(k => [k,{ type:'boolean' }]))) });
const [command, id] = p;
try {
  let result;
  if (command === 'new' || command === 'new-representative') result = createApplication({ id: v.id, ...(command === 'new-representative' ? { kind: 'representative', title: v.title } : {}), company: v.company || '', position: v.position || '', fictional: !!v.fictional, keywords: (v.keywords || '').split(',').map(s => s.trim()).filter(Boolean), createdAt: new Date().toISOString().slice(0, 10), deadline: v.deadline || null, jdUrl: v.url || null }, v.jd ? fs.readFileSync(v.jd, 'utf8') : '');
  else if (command === 'generate') result = generate(id);
  else if (command === 'verify') { result = verifyAndRecord(id); if (!result.passed) process.exitCode = 1; }
  else if (command === 'repair') {
    result = verify(id);
    while (!result.passed) {
      generate(id, undefined, true);
      result = verify(id);
    }
  }
  else if (command === 'review') result = recordReview(id, { reviewer: v.reviewer, notes: v.notes, verdict: v.fail ? 'FAIL' : 'PASS', checks: { hiring: !!v.hiring, naturalness: !!v.naturalness, spelling: !!v.spelling, confidentiality: !!v.confidentiality } });
  else if (command === 'approve') { if (!v.confirm) throw new Error('사람 승인 후 --confirm --by 이름을 지정하세요.'); result = approve(id, v.by, undefined, v.digest); }
  else if (command === 'snapshot') { if (!v.confirm) throw new Error('고정본 생성 확인에 --confirm이 필요합니다.'); result = snapshot(id); }
  else if (command === 'source-digest') {
    const source = careers().find(c => c.id === id);
    if (!source) throw new Error('경력 ID를 찾을 수 없습니다.');
    result = { id, digest: sourceDigest(source), ...sourceStatus(source) };
  }
  else if (command === 'source-approve') {
    if (!v.confirm) throw new Error('원본을 사람이 직접 확인한 후 --confirm --by --digest를 지정하세요.');
    result = confirmSource(id, v.by, v.digest);
  }
  else if (command === 'recover') {
    if (!v.confirm) throw new Error('실행 중인 작성 작업을 모두 종료하고 백업을 확인한 뒤 --confirm으로 복구하세요.');
    result = recover();
  }
  else if (command === 'digest') result = digest(id);
  else if (command === 'validate') { result = validateAll(); if (result.errors.length) process.exitCode = 1; }
  else result = '명령: new-representative --id --title [--company --position --jd --keywords --fictional] | new --id --company --position --jd --keywords [--fictional] | generate ID | verify ID | repair ID | review ID --reviewer --notes --hiring --naturalness --spelling --confidentiality | approve ID --by 이름 --digest 확인한해시 --confirm | snapshot ID --confirm | source-digest EXP-ID | source-approve EXP-ID --by 이름 --digest 확인한해시 --confirm | recover --confirm | validate';
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
