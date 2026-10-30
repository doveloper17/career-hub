import { parseArgs } from 'node:util';
import { startRun, readRun, resumeRun, updateBudget, recoverRun } from '../lib/orchestrator.mjs';

try {
  const { positionals: [command, id], values: v } = parseArgs({ allowPositionals: true, options: {
    model: { type: 'string' }, 'confirm-send': { type: 'boolean' }, 'review-only': { type: 'boolean' },
    'accept-changes': { type: 'boolean' }, 'retry-interrupted': { type: 'boolean' }, confirm: { type: 'boolean' },
    'max-calls': { type: 'string' }, 'max-tokens': { type: 'string' }, 'max-active-ms': { type: 'string' },
  } });
  const limits = {};
  for (const [flag, key] of [['max-calls', 'maxCalls'], ['max-tokens', 'maxObservedTokens'], ['max-active-ms', 'maxActiveMs']]) {
    if (v[flag] !== undefined) limits[key] = Number(v[flag]);
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const options = { model: v.model, confirmSend: v['confirm-send'], reviewOnly: v['review-only'],
    acceptChanges: v['accept-changes'], retryInterrupted: v['retry-interrupted'], signal: controller.signal, limits };
  let result;
  if (command === 'start') {
    result = startRun(id, options);
    if (options.confirmSend) result = await resumeRun(id, options);
  } else if (command === 'resume') result = await resumeRun(id, options);
  else if (command === 'status') result = readRun(id);
  else if (command === 'budget' && v.confirm) result = updateBudget(id, limits);
  else if (command === 'recover' && v.confirm) result = recoverRun(id);
  else throw new Error('명령: workflow start ID [--review-only --confirm-send] | resume ID --confirm-send [--accept-changes --retry-interrupted] | status ID | budget ID --max-calls N --max-tokens N --confirm | recover ID --confirm');
  console.log(JSON.stringify(result, null, 2));
  if (['failed', 'stale', 'budget_exhausted', 'repair_limit', 'interrupted'].includes(result.status)) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
