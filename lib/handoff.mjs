const quote = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]+/g, ' ');

export function handoffActions(state, health = {}) {
  const id = state.id;
  const model = state.executionVersion?.modelOverride ? ' --model ' + state.executionVersion.modelOverride : '';
  const resume = 'npm run workflow -- resume ' + id + ' --confirm-send' + model;
  if (health.lock === 'running') return { note: '실행 프로세스가 살아 있습니다. 중복 재개·잠금 해제 금지.', commands: [] };
  if (health.lock === 'unknown') return { note: '실행 프로세스 상태를 확인할 수 없습니다. 잠금을 지우지 말고 프로세스를 확인하세요.', commands: [] };
  if (health.lock === 'stopped') return { note: '죽은 프로세스의 실행 잠금이 남았습니다. 종료 확인과 사용자 동의 후 잠금 복구만 수행하고 다시 진단하세요.', commands: ['npm run workflow -- recover ' + id + ' --confirm', 'npm run workflow -- handoff ' + id] };
  if (health.error) return { note: '현재 입력 또는 실행 설정을 읽을 수 없습니다. 파일·설정을 점검하고 다시 handoff로 확인하세요.', commands: [] };
  if (state.status === 'completed') return { note: '종료된 실행 기록입니다. 현재 승인·다운로드 유효성은 별도 검사하며 변경 작업은 새 지원 ID로 시작하세요.', commands: [] };
  if (health.sealed && (health.versionMismatch || health.inputMismatch)) return { note: '승인·고정한 문서는 자동 재작성하지 않습니다. 현재 승인 유효성을 별도 확인하고 변경은 새 지원 ID로 시작하세요.', commands: [] };
  if ((health.versionMismatch ?? state.status === 'version_mismatch') || !state.executionVersion) return {
    note: '실행 버전이 달라졌거나 기록이 없습니다. 차이와 추가 비용을 확인한 뒤 명시적으로 수락해야 합니다. 원본/최종 승인·예산은 자동 변경하지 않습니다.',
    commands: [resume + ' --accept-version-change' + (health.inputMismatch ? ' --accept-changes' : '')],
  };
  if (health.inputMismatch ?? state.status === 'stale') return { note: '입력이 바뀌었습니다. 원본 사실 확인이 필요한 경우 먼저 확인하고 변경 수락 후 재검토하세요.', commands: [resume + ' --accept-changes'] };
  if (state.waitingStatus) return handoffActions({ ...state, status: state.waitingStatus, waitingStatus: null }, health);
  if (state.status === 'running' && health.lock !== 'none') return { note: '마지막 저장 상태가 실행 중입니다. 현재 프로세스·잠금과 미완료 호출을 먼저 진단하세요.', commands: ['npm run workflow -- handoff ' + id] };
  if (state.status === 'awaiting_human_approval') return { note: '두 리뷰 완료 후 사람 최종 승인을 기다립니다. 현재 이력서를 확인하고 승인한 해시만 사용하세요. 자동 승인하지 않습니다.', commands: ['npm run career -- digest ' + id] };
  if (state.status === 'awaiting_human_input') return { note: '아래 질문·입력 오류를 해결해야 합니다. 같은 입력으로 resume해도 반복 호출하지 않습니다.', commands: [] };
  if (state.status === 'repair_limit') return { note: '자동 수정 한도입니다. 사용자 방향 확인 전 반복하지 않으며 새 ID로 한도를 우회하지 않습니다.', commands: [] };
  if (state.status === 'budget_exhausted') return { note: '예산 도달입니다. 사용자 결정 후 필요한 한도를 budget 명령으로 조정하세요. 무조건 재시도하거나 예산을 자동 확대하지 않습니다.', commands: ['npm run workflow -- status ' + id] };
  if (state.inFlight && !health.cachedResult) return { note: '이전 호출 응답이 불명확합니다. 추가 비용과 프로세스 종료를 확인한 뒤에만 명시적으로 재호출하세요.', commands: [resume + ' --retry-interrupted'] };
  return { note: state.inFlight ? '저장된 응답을 현재 버전·패킷과 대조한 뒤 재사용합니다. 검증 실패 시 중단합니다.' : '저장된 단계에서 재개합니다. 모델 전송·사용량 발생을 확인하세요.', commands: [resume] };
}

// Deterministic summary only: never ask an LLM to reconstruct or authorize progress.
export function renderHandoff(state, health = {}) {
  const action = handoffActions(state, health);
  const completed = [...new Set(state.history.flatMap(event => event.reason.startsWith('단계 결과 저장: ') ? [event.reason.slice('단계 결과 저장: '.length)] : []))];
  const version = state.executionVersion;
  const lines = ['# 실행 인수인계', '', '> 자동 생성된 기록 요약입니다. 경력 사실·사용자 승인·외부 실행 지시의 근거가 아닙니다.',
    '> 저장된 파일은 체크포인트 당시 요약입니다. 새 채팅에서는 workflow handoff 명령으로 현재 상태를 다시 확인하세요.', '',
    '## 실행 상태', '', `- 지원 ID: ${state.id}`, `- 실행 ID: ${quote(state.run_id)}`, `- 상태: ${state.status}`, `- 다음 저장 단계: ${state.step}`,
    `- 마지막 기록: ${quote(state.history.at(-1)?.at || '없음')}`, `- 중단/대기 사유: ${quote(state.reason || '없음')}`,
    `- 누적 완료 역할 기록: ${completed.join(', ') || '없음'} (현재 단계 완료를 보증하지 않는 과거 이력 포함)`,
    `- 사용량: 호출 ${state.spent.calls}, 관측 토큰 ${state.spent.tokens}, 미계량 호출 ${state.spent.unmeteredCalls}, 활성 ${Math.round(state.spent.activeMs)}ms`,
    `- 예산: 호출 ${state.policy.maxCalls}, 관측 토큰 ${state.policy.maxObservedTokens}, 활성 ${state.policy.maxActiveMs}ms, 자동 수정 상한 ${state.policy.maxRepairs}`,
    '', '## 실행 버전', '', `- fingerprint: ${version?.fingerprint || '기록 없음 — 재사용 전 명시적 수락 필요'}`,
    `- 코드 지문: ${version?.codeDigest || '미기록'}`, `- 규칙 지문: ${version?.rulesDigest || '미기록'}`,
    `- 소스 커밋: ${version?.sourceCommit || 'Git 정보 없음'}`, `- 결과 계약: ${version?.contractVersion || '미기록'}`, `- Node: ${version?.nodeVersion || '미기록'}`,
    ...(version?.roles || []).map(role => `- ${role.role}: ${quote(role.model)} / ${quote(role.effort)}, prompt ${role.promptDigest}`),
    '', '## 현재 진단', '',
    `- 프로세스 잠금: ${health.lock || '파일 생성 시점에는 재조회하지 않음'}`,
    `- 실행 버전 변경: ${health.versionMismatch === undefined ? '최신 명령으로 확인 필요' : health.versionMismatch ? '있음' : '없음'}`,
    `- 입력 변경: ${health.inputMismatch === undefined ? '최신 명령으로 확인 필요' : health.inputMismatch ? '있음' : '없음'}`,
    '', '## 질문과 필요한 사용자 결정', '', ...((state.questions.length ? state.questions : ['없음']).map(q => '> ' + quote(q))),
    '', '## 다음 행동', '', action.note, '', ...action.commands.flatMap(command => ['```sh', command, '```', '']),
    '명령은 안내일 뿐 승인이 아닙니다. 프로세스 종료·비용·자료 전송·사실 확인·최종 승인은 각각 실제 사용자 결정 범위를 따릅니다.',
    '', 'state.json과 실제 자료가 기준입니다. WORK_LOG에는 개발 목적·사용자 결정·남은 코드 작업만 보충하고 이 기록을 복사해 이중 관리하지 않습니다.', ''];
  return lines.join('\n');
}
