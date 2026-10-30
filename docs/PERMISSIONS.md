# 서브에이전트 권한과 실행

## 역할별 접근 범위

| 역할 | 전달 자료 | 파일 변경·승인·Git |
| --- | --- | --- |
| job-market-analyst | JD/목적, 사용 가능한 확인 경력 | 모두 금지, 분석 JSON만 반환 |
| resume-writer | 위 자료와 분석, 수정 시 기존 초안·리뷰 지적 | 모두 금지, 사실을 보존하는 표현·출처·전략 JSON만 반환 |
| verifier | JD/목적, 이력서·출처와 실제 사용한 경력 | 모두 금지, 사실 검증 JSON만 반환 |
| feedback-coach | verifier와 같은 버전의 자료 | 모두 금지, 품질 검토 JSON만 반환 |
| 총괄 | 프로젝트 자료와 검증 결과 | 요청 범위에서 저장·CLI 실행. 사람 승인 대행 금지 |
| 실행기(호스트 프로그램) | 검증된 입력과 역할별 결과·현재 상태 | 초안·전략·리뷰·실행 상태만 저장. 경력 원본·원본 확인·최종 승인·Git 변경 금지 |

검토자는 작성 대화·전략·다른 리뷰·승인자·승인 기록·개인 작업 로그를 받지 않는다. 분석/작성은 후보 선택을 위해 사용 가능한 경력을 받는다. 작성자는 기존 draft를 받으며 자동 수정 때는 findings도 받는다. 사용 불가·비공개 경력은 제외한다. 전달 패킷은 1MiB(1,048,576바이트) 한도와 비밀정보 패턴 검사를 거친다. 패턴 검사만으로 모든 개인정보나 기밀을 찾을 수 없으므로 전송 전 총괄이 범위를 확인한다.

## 실행 명령

Node.js 22.12 이상과 권한 프로필을 지원하는 Codex CLI, Codex 로그인이 필요하다. 프로젝트 루트에서 실행한다. macOS/Linux는 npm, Windows PowerShell에서 실행 정책 문제가 있으면 npm.cmd를 사용한다.

```sh
npm run agents -- doctor
npm run agents -- packet main-sample verifier
npm run agents -- run main-sample verifier --confirm-send
npm run agents -- run main-sample feedback-coach --confirm-send
```

모델·추론 강도는 `.codex/agents/ROLE.toml`의 주석 바로 아래 `model`·`model_reasoning_effort` 값을 수정한다. 기본은 모든 역할 gpt-6.1-sol, medium이다. `--model MODEL`로 한 번의 실행 모델만 변경할 수 있다. packet은 입력을 로컬 stdout으로 표시하므로 공개 로그에 남기지 않는다. run은 모델 서비스로 자료를 전달한다. `--confirm-send`는 사용자 승인을 받은 총괄이 지정하는 확인 장치이지 사람 인증이 아니다. 로그인 정보는 신뢰하는 Codex 호스트가 사용하며 패킷으로 전달하지 않는다. `.env`는 로딩하지 않고 API 키·토큰·프록시·NODE_OPTIONS 등 환경 변수도 상속하지 않는다.

lib/agent-definition.mjs가 TOML에서 읽는 실행 항목은 name·model·model_reasoning_effort·developer_instructions다. 강제 권한 프로필은 lib/agent-runner.mjs의 permissionConfig와 probePermissions가 구성한다. 역할 TOML의 features 표만 수정해 쓰기 권한이 달라진다고 가정하지 않는다. 네 모델의 읽기 전용 도구 권한은 동일하며 역할별 차이는 전달 패킷과 검토 지침이다. 호스트 실행기/총괄의 저장 권한과 모델 도구 권한은 별개다.

workflow는 모델 override와 실행 버전을 저장하고 재개 때 비교한다. --model의 변경은 --accept-version-change가 필요하며 단일 agents run은 독립 호출이다. 호스트가 기록하는 execution.version과 handoff.md는 모델 권한·사람 승인·사실 확인을 부여하지 않는다. 버전 메타데이터에는 사용자 경로·원격 URL·프롬프트 원문·경력 내용을 복제하지 않는다. 세부 범위와 한계는 [실행기](EXECUTOR.md)를 따른다.

## 강제되는 경계

1. 호스트가 원본을 검증하여 패킷을 구성하고 임시 작업 공간을 만든다. 사용자 원본을 복사해 수정하지 않는다.
2. 파일시스템 기본 접근은 deny, 임시 입력과 최소 OS 런타임은 read로 설정한다. 검사에 사용하는 Node 실행 파일도 읽기 허용한다. 쓰기 허용 경로는 지정하지 않는다.
3. 같은 프로필에서 패킷 읽기는 성공하고 파일 생성·변경·삭제, 허용 범위 밖 가상 비밀자료 읽기, TCP 연결은 권한 오류로 거절되는지 검사한다. 단순 파일 부재나 연결 실패는 통과가 아니다.
4. 실패하면 모델을 호출하지 않는다. 성공하면 새 `codex exec`에 같은 프로필을 지정한다. 사용자 설정·프로젝트 설정 상속을 피하며 shell/apps/plugins/memories/추가 위임·권한 확대·웹 검색을 비활성화하고 MCP 설정을 비운다.
5. 결과 JSON의 스키마·역할·실행 ID·수정 회차·해시·출처를 검사한다. 실행 중 입력이 바뀌면 폐기한다. 표현의 의미 보존은 verifier의 모든 claim_checks와 독립 품질 리뷰로 검사하며 문자열 일치로 판단하지 않는다.
6. 단일 역할 runner는 결과를 stdout으로만 반환하고 임시 공간은 정상 종료·오류 시 정리한다. runner 자체는 원본·이력서·리뷰·승인을 저장하지 않는다. 실행기는 원응답과 상태를 `.local/workflow-runs/ID/`에 저장하고, 검증한 초안·리뷰를 지원 폴더에 저장한다. 수동 호출 시 총괄이 기록과 후속 절차를 담당한다.

## 한계와 중단 조건

- doctor는 현재 OS와 설치된 Codex의 거부 동작을 검사한다. 다른 OS/버전의 성공을 보증하지 않는다. 지원하지 않는 옵션, 관리 정책 충돌, 거부 확인 실패는 중단 조건이다. 권한 완화나 일반 spawn으로 우회하지 않는다.
- 도구 네트워크 차단과 모델 추론 통신은 다르다. Codex 호스트는 모델 API와 인증에 네트워크를 사용한다. 호스트·설치된 CLI·OS·관리 정책은 신뢰 경계 안에 있다. 악성 호스트 또는 같은 OS 권한의 사람이 파일을 조작하는 상황을 방어하는 설계는 아니다.
- 거부 검사는 대표적인 경로와 동작을 시험하며 모든 시스템 호출의 증명이 아니다. 최소 OS 런타임 읽기는 허용한다. 모델의 잘못된 판단이나 사실 오류가 절대 발생하지 않는다는 보장도 아니다.
- 모델 실행은 600초 후 직접 자식 프로세스를 강제 종료하도록 요청한다. 프로세스 트리 전체 종료나 OS 장애까지 보장하지 않는다. 호스트 강제 종료 시 임시 자료가 남을 수 있으므로 실제 자료는 암호화된 사용자 디스크에서 운영한다.
- 단일 역할 runner의 모델 프로세스 기본 제한은 600초이고 실행기에서는 남은 활성 예산/정책에 따라 짧아질 수 있다. 권한 probe 등 동기식 준비 작업은 모델 프로세스 타이머와 별개다. CLI JSONL 출력은 4MiB를 넘으면 중단하며 도구 실행·turn.failed/error 이벤트도 거부한다.
- 단일 역할 runner는 콘텐츠 기록·승인을 하지 않는다. [실행기](EXECUTOR.md)는 검증된 초안 저장과 두 독립 결과 취합·최대 2회 표현 수정을 수행하고, 같은 버전의 두 PASS가 있을 때만 PASS 리뷰를 기록한다. FAIL 리뷰도 수정 전에 기록할 수 있고 NEEDS_INPUT은 로컬 상태·질문으로 보존한다. 원본 사실·최종 승인은 사람에게 남긴다. 실제 모델 호출의 성공은 doctor나 단위 테스트와 별도로 확인해야 한다.

구현: `lib/agent-permissions.mjs`, `lib/agent-runner.mjs`, `scripts/agents.mjs`. 권한 설정은 [Codex 권한 문서](https://learn.chatgpt.com/docs/permissions), 별도 실행은 [비대화형 실행 문서](https://learn.chatgpt.com/docs/non-interactive-mode)를 기준으로 한다.
