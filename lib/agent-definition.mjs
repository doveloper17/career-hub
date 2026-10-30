import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { assertRole } from './agent-contract.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function roleExecution(role, modelOverride, root = projectRoot) {
  assertRole(role);
  const definition = parse(fs.readFileSync(path.join(root, '.codex/agents', role + '.toml'), 'utf8'));
  if (definition.name !== role) throw new Error('역할 정의 불일치');
  const model = modelOverride ?? definition.model;
  const effort = definition.model_reasoning_effort;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('유효한 역할 model 설정 또는 --model이 필요합니다.');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('유효한 역할 model_reasoning_effort 설정이 필요합니다.');
  if (typeof definition.developer_instructions !== 'string') throw new Error('역할 지침이 필요합니다.');
  return { model, effort, instructions: definition.developer_instructions };
}

export function roleInstructions(execution, root = projectRoot) {
  const protocol = fs.readFileSync(path.join(root, 'docs/SUBAGENTS.md'), 'utf8');
  return execution.instructions + '\n\n다음은 호스트가 제공하는 실행 규약입니다. 총괄·실행기 전용 CLI와 파일 저장 절차는 호스트의 책임이며 당신은 역할 결과만 반환합니다.\n' + protocol + '\n총괄이 제공한 패킷만 사용하고 도구를 호출하지 마세요. 파일 경로를 탐색하지 마세요. JSON 결과만 반환하세요. 리뷰는 checks와 모든 필수 필드를 포함하고 분석·작성은 checks를 생략하세요. 판단 불가 시 NEEDS_INPUT입니다. PASS이면 findings와 questions는 반드시 빈 배열이며 checks가 있으면 전부 true여야 합니다. findings는 미해결 문제만 기록하는 필드입니다. 분석의 일반 결과·주의점·제안은 summary/requirements에 쓰세요. requirements의 missing은 진행에 필수인 미확인 정보만 쓰고, 없으면 설명문이 아니라 빈 문자열을 쓰세요. evidence는 sources.statements를 정확히 인용하며 출력 이력서의 문장 표현과는 별개입니다. 본문만으로 판단한 근거는 evidence에 임의 작성하지 말고 원문 statement 인용이 없으면 빈 배열로 두세요. verifier는 모든 claim의 claim_checks를 반환해야 합니다.';
}
