import { parseArgs } from 'node:util';
import { doctor, executeRole } from '../lib/agent-runner.mjs';
import { preparePacket } from '../lib/agent-permissions.mjs';

const { positionals: p, values: v } = parseArgs({ allowPositionals: true, options: { model: { type: 'string' }, 'confirm-send': { type: 'boolean' } } });
try {
  if (p[0] === 'doctor') console.log(JSON.stringify(doctor(), null, 2));
  else if (p[0] === 'packet' && p.length === 3) console.log(JSON.stringify(preparePacket(p[1], p[2]), null, 2));
  else if (p[0] === 'run' && p.length === 3) {
    if (!v['confirm-send']) throw new Error('검토 자료를 Codex 모델 서비스로 전달할 사용자 승인 후 --confirm-send를 지정하세요.');
    console.log(JSON.stringify(await executeRole(p[1], p[2], v.model), null, 2));
  } else throw new Error('명령: agents doctor | packet ID ROLE | run ID ROLE [--model MODEL] --confirm-send');
} catch (error) { console.error(error.message); process.exitCode = 1; }
