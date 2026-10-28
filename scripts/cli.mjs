#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApplication, generate, verify, recordReview, approve, snapshot, validateAll } from '../lib/workflow.mjs';
import { load, digest } from '../lib/workflow.mjs';
import { writeJson } from '../lib/store.mjs';

const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['title','id','company','position','jd','keywords','url','deadline','reviewer','notes','by'].map(k => [k,{ type: 'string' }]).concat(['fictional','confirm','hiring','naturalness','spelling','confidentiality','fail'].map(k => [k,{ type:'boolean' }]))) });
const [command, id] = p;
try {
  let result;
  if (command === 'new' || command === 'new-representative') result = createApplication({ id: v.id, ...(command === 'new-representative' ? { kind: 'representative', title: v.title } : {}), company: v.company || '', position: v.position || '', fictional: !!v.fictional, keywords: (v.keywords || '').split(',').map(s => s.trim()).filter(Boolean), createdAt: new Date().toISOString().slice(0, 10), deadline: v.deadline || null, jdUrl: v.url || null }, v.jd ? fs.readFileSync(v.jd, 'utf8') : '');
  else if (command === 'generate') result = generate(id);
  else if (command === 'verify') { result = verify(id); const { dir } = load(id); writeJson(path.join(dir, 'fact-review.json'), result); if (!result.passed) process.exitCode = 1; }
  else if (command === 'repair') {
    result = verify(id);
    while (!result.passed) {
      generate(id, undefined, true);
      result = verify(id);
    }
  }
  else if (command === 'review') result = recordReview(id, { reviewer: v.reviewer, notes: v.notes, verdict: v.fail ? 'FAIL' : 'PASS', checks: { hiring: !!v.hiring, naturalness: !!v.naturalness, spelling: !!v.spelling, confidentiality: !!v.confidentiality } });
  else if (command === 'approve') { if (!v.confirm) throw new Error('사람 승인 후 --confirm --by 이름을 지정하세요.'); result = approve(id, v.by); }
  else if (command === 'snapshot') { if (!v.confirm) throw new Error('고정본 생성 확인에 --confirm이 필요합니다.'); const { dir } = load(id); fs.mkdirSync(path.join(dir, 'submissions'), { recursive:true }); result = snapshot(id); }
  else if (command === 'digest') result = digest(id);
  else if (command === 'validate') { result = validateAll(); if (result.errors.length) process.exitCode = 1; }
  else result = '명령: new-representative --id --title [--company --position --jd --keywords --fictional] | new --id --company --position --jd --keywords [--fictional] | generate ID | verify ID | repair ID | review ID --reviewer --notes --hiring --naturalness --spelling --confidentiality | approve ID --by 이름 --confirm | snapshot ID --confirm | validate';
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
