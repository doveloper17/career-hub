import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { assertRole, preparePacket, packetHash, resultSchema, validateResult, minimalEnvironment } from './agent-permissions.mjs';
import { invokeModel } from './model-process.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const PROFILE = 'career-isolated';
const LIMIT = 2 * 1024 * 1024;
export function roleExecution(role, modelOverride) {
  assertRole(role);
  const definition = parse(fs.readFileSync(path.join(project, '.codex/agents', role + '.toml'), 'utf8'));
  if (definition.name !== role) throw new Error('역할 정의 불일치');
  const model = modelOverride ?? definition.model;
  const effort = definition.model_reasoning_effort;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('유효한 역할 model 설정 또는 --model이 필요합니다.');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('유효한 역할 model_reasoning_effort 설정이 필요합니다.');
  return { model, effort, instructions: definition.developer_instructions };
}
function invoke(args, cwd, input, timeout = 15000) {
  const r = spawnSync('codex', args, { cwd, env: minimalEnvironment(), input, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: LIMIT, shell: false });
  if (r.error || r.signal || r.status !== 0) throw new Error(`격리 실행 실패 (${r.error?.code || r.signal || r.status}). 권한을 완화하지 말고 Codex 설치·로그인·관리 정책을 확인하세요.`, { cause: r.stderr });
  return r.stdout;
}
export function permissionConfig(workspace, executable = process.execPath) {
  return {
    default_permissions: PROFILE, approval_policy: 'never', web_search: 'disabled',
    agents: { enabled: false }, mcp_servers: {},
    skills: { bundled: { enabled: false }, include_instructions: false },
    features: { shell_tool: false, apps: false, plugins: false, memories: false, request_permissions_tool: false },
    permissions: { [PROFILE]: {
      filesystem: { ':root': 'deny', ':minimal': 'read', [workspace]: 'read', [fs.realpathSync(executable)]: 'read' },
      network: { enabled: false },
    } },
  };
}
function inline(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  return '{ ' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ' = ' + inline(v)).join(', ') + ' }';
}
export function overrides(config) {
  // Argument arrays, no shell interpolation; parse the generated TOML before use.
  return Object.entries(config).flatMap(([key, value]) => {
    const assignment = key + '=' + inline(value);
    parse(assignment);
    return ['-c', assignment];
  });
}

export function createWorkspace(packet) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'career-agent-')));
  const workspace = path.join(base, 'input');
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'packet.json'), JSON.stringify(packet), { mode: 0o600 });
  // Synthetic canaries; no real secrets are read or changed by the permission test.
  const outside = path.join(base, 'private');
  fs.mkdirSync(outside, { mode: 0o700 });
  for (const name of ['.env', 'git-config', 'approval.json']) fs.writeFileSync(path.join(outside, name), 'permission-canary', { mode: 0o600 });
  return { base, workspace, outside };
}
export function probePermissions(area) {
  const config = permissionConfig(area.workspace);
  const help = invoke(['sandbox', '--help'], area.workspace);
  if (!help.includes('--permission-profile')) throw new Error('권한 프로필 지원을 확인할 수 없습니다.');
  // The installed current CLI exposes a platform-neutral sandbox command.
  if (/Commands:\s*\n\s*macos/.test(help)) throw new Error('이 CLI의 sandbox 진입점은 지원하지 않습니다.');
  const token = crypto.randomUUID();
  const probe = `
    const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
    const [workspace,outside,token]=process.argv.slice(1);
    let ok=true; const denied=fn=>{try{fn();ok=false;}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))ok=false;}};
    try { JSON.parse(fs.readFileSync(path.join(workspace,'packet.json'),'utf8')); } catch { ok=false; }
    denied(()=>fs.writeFileSync(path.join(workspace,'new.txt'),'forbidden'));
    denied(()=>fs.appendFileSync(path.join(workspace,'packet.json'),'forbidden'));
    denied(()=>fs.unlinkSync(path.join(workspace,'packet.json')));
    for(const name of ['.env','git-config','approval.json']) denied(()=>fs.readFileSync(path.join(outside,name)));
    const s=net.connect({host:'127.0.0.1',port:9});
    s.setTimeout(1500,()=>{s.destroy();process.exit(2)});
    s.on('connect',()=>{s.destroy();process.exit(3)});
    s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))ok=false; if(ok)process.stdout.write(token);process.exit(ok?0:4)});
  `;
  const answer = invoke(['sandbox', '--permission-profile', PROFILE, '--include-managed-config', '--cd', area.workspace,
    ...overrides(config), '--', process.execPath, ...(process.platform === 'win32' ? [] : ['--openssl-config=/dev/null']), '-e', probe, area.workspace, area.outside, token], area.workspace);
  if (answer.trim() !== token) throw new Error('권한 거부 검사를 확인할 수 없습니다.');
  return { read_packet: true, write_denied: true, delete_denied: true, private_read_denied: true, network_denied: true };
}
export function doctor() {
  const area = createWorkspace({ purpose: 'permission test only' });
  try { return probePermissions(area); }
  finally { fs.rmSync(area.base, { recursive: true, force: true }); }
}

export async function executeRole(id, role, model, root = process.cwd(), options = {}) {
  const execution = roleExecution(role, model);
  const packet = preparePacket(id, role, root, options);
  const initial = packetHash(packet);
  const area = createWorkspace(packet);
  try {
    const probe = probePermissions(area); // Never invoke a model if isolation cannot be demonstrated.
    const schema = z.toJSONSchema(resultSchema(role));
    fs.writeFileSync(path.join(area.workspace, 'result-schema.json'), JSON.stringify(schema), { mode: 0o600 });
    const protocol = fs.readFileSync(path.join(project, 'docs/SUBAGENTS.md'), 'utf8');
    const instructions = execution.instructions + '\n\n다음은 호스트가 제공하는 실행 규약입니다. 총괄·실행기 전용 CLI와 파일 저장 절차는 호스트의 책임이며 당신은 역할 결과만 반환합니다.\n' + protocol + '\n총괄이 제공한 패킷만 사용하고 도구를 호출하지 마세요. 파일 경로를 탐색하지 마세요. JSON 결과만 반환하세요. 리뷰는 checks와 모든 필수 필드를 포함하고 분석·작성은 checks를 생략하세요. 판단 불가 시 NEEDS_INPUT입니다. PASS이면 findings와 questions는 반드시 빈 배열이며 checks가 있으면 전부 true여야 합니다. findings는 미해결 문제만 기록하는 필드입니다. 분석의 일반 결과·주의점·제안은 summary/requirements에 쓰세요. requirements의 missing은 진행에 필수인 미확인 정보만 쓰고, 없으면 설명문이 아니라 빈 문자열을 쓰세요. evidence는 sources.statements를 정확히 인용하며 출력 이력서의 문장 표현과는 별개입니다. 본문만으로 판단한 근거는 evidence에 임의 작성하지 말고 원문 statement 인용이 없으면 빈 배열로 두세요. verifier는 모든 claim의 claim_checks를 반환해야 합니다.';
    const config = { ...permissionConfig(area.workspace), model_reasoning_effort: execution.effort, developer_instructions: instructions };
    const output = await invokeModel(['--no-daemon', 'exec', '--json', '--strict-config', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
      '--cd', area.workspace, '--model', execution.model, '--output-schema', path.join(area.workspace, 'result-schema.json'),
      ...overrides(config), '-'], { cwd: area.workspace, env: minimalEnvironment(), input: JSON.stringify(packet),
        timeoutMs: Math.min(options.timeoutMs || 600000, 600000), signal: options.signal, onUsage: options.onUsage });
    if (packetHash(JSON.parse(fs.readFileSync(path.join(area.workspace, 'packet.json'), 'utf8'))) !== initial) throw new Error('입력 패킷이 변경되었습니다.');
    const current = preparePacket(id, role, root, options);
    current.run_id = packet.run_id;
    if (packetHash(current) !== initial) throw new Error('검토 중 원본 또는 결과물이 변경되었습니다. 결과를 적용하지 않습니다.');
    const rawResult = JSON.parse(output.text);
    options.onResult?.({ execution: { model: execution.model, reasoning_effort: execution.effort }, usage: output.usage, isolation: probe, result: rawResult });
    const result = validateResult(rawResult, packet);
    // Output only: this runner never writes career, resume, review, approval, Git or external records.
    return { execution: { model: execution.model, reasoning_effort: execution.effort }, usage: output.usage, isolation: probe, result };
  } finally { fs.rmSync(area.base, { recursive: true, force: true }); }
}
