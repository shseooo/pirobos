# pirobos

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md)

[Ouroboros](https://github.com/Q00/ouroboros) 워크플로를
[pi](https://github.com/badlogic/pi-mono) 확장으로 네이티브 이식.

`ouroboros` Python CLI를 감싼 래퍼가 **아닙니다**. spec-first 루프
(interview → seed → evaluate → drift → unstuck → ralph)를 pi 안에서
TypeScript 확장으로 직접 구현합니다. 상태는 프로젝트 루트의 `.ouroboros/`에
저장되며, [Karpathy 코딩 하네스](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)는
`index.ts` 안에 인라인 번들되어 있고 **seed가 잠겨 있을 때만** system
prompt 에 주입됩니다 (스펙 이전 세션은 augment 안 됨).

`.ouroboros/`는 [clauroboros](https://github.com/shseooo/clauroboros)
(Claude Code 포팅) 와 바이트 단위 호환 — 동일 프로젝트를 두 에이전트에서
번갈아 열어도 인터뷰를 다시 할 필요 없음.

## 설치

```sh
# clone
git clone https://github.com/shseooo/pirobos.git
cd pirobos && npm install

# 프로젝트 로컬 설치
mkdir -p .pi/extensions
ln -s "$(pwd)" .pi/extensions/pirobos

# 또는 글로벌 설치
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pirobos
```

이후 pi에서 `/reload`.

## 이식한 개념

| 개념        | 본 확장에서의 구현                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Seed       | `.ouroboros/seed.json` (정본) + `seed.yaml` (미러). 한 번 finalize 되면 잠김.                          |
| Interview  | `before_agent_start`가 Socratic 지시를 system prompt에 주입. LLM이 `ooo_seed_set` / `ooo_seed_finalize` 로 기록. |
| Evaluate   | Mechanical (자동 감지: `npm test` / `pytest` / `make test` / `cargo test` / `go test`) + Semantic (LLM이 `ooo_grade_ac` 로 각 AC 채점). |
| Drift      | LLM이 goal / constraint / ontology 를 [0,1] 로 자가 보고 → 가중 평균 0.5 / 0.3 / 0.2, 임계치 ≤ 0.30.        |
| Unstuck    | 5개 lateral persona (inverter, first-principles, naive-newcomer, adversary, architect)를 3턴 동안 system prompt 에 주입. |
| Ralph      | `agent_end` → `pi.sendUserMessage({deliverAs:"followUp"})` 로 다음 evaluate-and-fix 자동 주입. 모든 AC 통과 또는 cap 도달 시 자동 정지. |
| 하네스       | `index.ts` 의 `KARPATHY_HARNESS` 상수 — `before_agent_start` 가 seed 잠금 상태에서만 system prompt 에 prepend. |

## 용어집

- **Seed (시드)** — 불변 스펙: goal + acceptance criteria + constraints +
  ontology + exposed assumptions. 한 번 잠기면 모든 명령이 권위 데이터로
  취급. `seed.json` (정본) + `seed.yaml` (미러) 로 저장.
- **Acceptance Criterion (AC)** — "완료"의 일부를 정의하는 검증 가능한
  단일 진술. 각 AC는 mechanical 테스트 또는 코드베이스 검사로
  `pass` / `fail` / `n/a` 채점. seed 잠금 조건: AC ≥ 5.
- **Ambiguity score (모호성 점수)** — 인터뷰 중 스펙의 흐릿함을 나타내는
  0–1 점수. ambiguity ≤ 0.2 일 때만 seed 잠금 가능.
- **Constraint (제약)** — 솔루션이 지켜야 하는 비기능 요구사항 (성능,
  보안, 호환성, 의존성 정책 등).
- **Ontology (온톨로지)** — 프로젝트별 어휘를 고정하는 용어 → 정의 맵.
  모든 명령과 AC가 동일 개념을 가리키도록 보장.
- **Persona (페르소나)** — 막힘 상태를 깨는 lateral-thinking 렌즈 5종:
  `inverter`, `first-principles`, `naive-newcomer`, `adversary`,
  `architect`. `state.json`에 기록되며 `agent_end`가 3턴 동안 자동 차감.
- **Drift (드리프트)** — 현재 작업과 잠긴 seed 간의 발산. 가중치
  `0.5*goal + 0.3*constraint + 0.2*ontology`. ≤ 0.30 OK, 초과는 DRIFTED.
- **Ralph (랠프)** — 자율 evaluate-and-fix 루프. 매 `agent_end` 후
  pirobos가 `/ooo-evaluate` 후속을 자동 주입 → 모든 AC pass (CONVERGED)
  또는 cap 도달 시 정지.
- **Hard cap (하드 cap)** — `/ooo-ralph` 강제 정지까지의 최대 반복 수
  (기본 8, `/ooo-ralph on <N>` 으로 변경 가능). 무한 루프 방지장치 — cap
  도달 시 AC 미수렴이면 ralph가 정직하게 멈추고 보고 (수렴 가짜 성공
  위해 AC 약화 절대 금지). "하드"인 이유: 진행 중 에이전트가 cap 을
  올리거나 우회 불가.
- **Scope creep (스코프 크리프)** — 잠긴 seed 로부터의 점진적 발산: 추가
  기능, 목표 확장, 용어 재정의, 제약 조용한 완화 등. `/ooo-drift` 로 검출.
  seed 는 권고가 아니라 경계선 — 정말 목표가 바뀌었다면 조용히 확장하지
  말고 멈추고 `/ooo-interview` 재실행.
- **Karpathy 하네스** — 코딩 행동 가이드라인 (먼저 생각, 외과적 변경,
  성공 기준 정의, 가정 명시). `index.ts`의 `KARPATHY_HARNESS` 상수에
  인라인 번들. seed 잠금 시에만 `before_agent_start`가 system prompt 에
  주입.
- **Hard evaluate gate (하드 평가 게이트)** — pi 전용: `tool_call` 훅이
  `edit` / `write` / `notebook_edit` 호출에 대해 seed 미잠금 시
  `{block: true}` 반환. 모든 프로젝트에서 인터뷰-우선 코딩 강제.
- **Session lock (세션 락)** — `session_start` 에서 `fs.openSync(.lock,
  "wx")` 로 atomic 생성. 같은 프로젝트의 동시 pi 세션은 state.json 손상
  대신 명시적 에러로 실패.

## 슬래시 커맨드

| 커맨드                    | 동작                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `/ooo-interview <목표>`    | 목표를 seed 로 결정화하는 Socratic 인터뷰 시작                        |
| `/ooo-seed`               | 잠긴 seed (또는 작성 중 draft) 출력                                   |
| `/ooo-evaluate`           | Mechanical 테스트 실행 + 각 AC 를 파일 단위 증거로 채점                |
| `/ooo-drift`              | 잠긴 seed 대비 drift 자가 평가                                       |
| `/ooo-unstuck [id]`       | 3턴 동안 lateral persona 로 전환. 인자 없으면 선택 다이얼로그          |
| `/ooo-ralph [on\|off\|N]` | 자동 follow-up 루프 토글. `N` 으로 턴 cap 지정                        |
| `/ooo-status`             | interview / seed / persona / ralph / drift 현재 상태                  |
| `/ooo-reset`              | 세션 상태 초기화 (잠긴 seed 보존)                                     |

## LLM 호출 가능한 툴

| 툴                  | 용도                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `ooo_seed_set`      | 인터뷰 중 seed draft 를 누적 업데이트 (필드 머지)                        |
| `ooo_seed_finalize` | draft 를 `seed.yaml` 로 잠금. 조건: ambiguity ≤ 0.2, AC ≥ 5             |
| `ooo_grade_ac`      | 평가 단계에서 단일 AC 의 verdict (pass / fail / n/a) 기록               |
| `ooo_record_drift`  | drift 컴포넌트와 가중 점수 기록                                          |

## 언제 어느 명령을 쓰는가

| 상황                                                       | 명령                     |
| ---------------------------------------------------------- | ------------------------ |
| 모호한 목표로 새 기능/태스크 시작                             | `/ooo-interview <목표>`   |
| 현재 스펙 (잠긴 seed 또는 draft) 확인                        | `/ooo-seed`              |
| 의미 있는 작업 단계 완료 — AC 대비 검증                       | `/ooo-evaluate`          |
| 여러 차례 편집 후 scope creep 의심                           | `/ooo-drift`             |
| 막힘, 루프, 저품질 결과만 나옴                                | `/ooo-unstuck [persona]` |
| 하드 cap 안에서 자율적으로 모든 AC 통과 시키고 싶음            | `/ooo-ralph [N]`         |
| 루프 위치 잊음                                              | `/ooo-status`             |
| 진행 중 상태 정리하되 seed 보존                               | `/ooo-reset`             |

### `/ooo-unstuck` persona 선택 가이드

| 막힌 이유                                            | Persona            |
| ---------------------------------------------------- | ------------------ |
| 설계가 과하게 복잡하게 느껴짐                          | `inverter`         |
| 나쁜 토대 위에 패치만 쌓고 있음                         | `first-principles` |
| 코드베이스가 낯설고 가정이 숨어 있음                    | `naive-newcomer`   |
| 솔루션이 정확한지 판단 못함                            | `adversary`        |
| 모듈 경계가 잘못됐다고 느낌                            | `architect`        |

### 루프 운용 가이드

- 비-사소한 작업이라면 **코드 작성 전에** `/ooo-interview` 실행. 하드
  평가 게이트가 이를 강제 — seed 잠금 전에는 `Edit`/`Write` 가 차단되어
  스펙 없이 코딩 시작이 불가능.
- "완료" 선언 전 게이트로 `/ooo-evaluate` 사용 — AC 채점 없는 자가 선언
  금지.
- `/ooo-drift` 는 정기적으로 (수회 편집 후, 리팩터 후) 실행 — 저렴하고
  scope creep 조기 검출 효과 큼.
- `/ooo-ralph` 는 잔여 작업이 mechanical (실패 AC + 명확한 수정) 일 때
  사용. **AC 가 잘못된 상태에서는 사용 금지**. AC 가 잘못이라면 멈추고
  `/ooo-interview` 재실행하여 seed 개정. 수렴 위해 AC 약화 절대 금지.

## pirobos 가 사용하는 pi extension 기능

Claude Code 와 달리 pi 는 턴 단위 라이프사이클 훅을 제공. pirobos 는
이를 활용해 `clauroboros` 가 못하는 더 강한 강제력을 가짐:

- **턴별 system prompt 주입** — `before_agent_start` 가 매 턴마다
  Karpathy 하네스, 현재 seed, interview 상태, persona, ralph 상태를
  system prompt 에 추가 (seed 잠금 시에만).
- **턴 간 자동 follow-up** — `agent_end` +
  `pi.sendUserMessage(..., {deliverAs:"followUp"})` 조합으로 Ralph 가
  단일 확장 명령이 아닌 자연스러운 멀티턴 루프로 동작.
- **Hard evaluate gate** — `tool_call` 훅이 `{block:true}` 를 반환 →
  seed 미잠금 시 `Edit` / `Write` / `NotebookEdit` 거부 + 사유 표시.
  스펙 우회 차단.
- **Session lock** — `fs.openSync(.lock, "wx")` atomic 생성. 같은
  프로젝트의 동시 pi 세션이 state.json 경합 대신 명시 에러로 실패.
- **로컬 전용 텔레메트리** — `.ouroboros/telemetry.jsonl` 에 ambiguity
  샘플 + ralph 수렴/cap 이벤트 append. 외부 송신 일체 없음.

## 상태 파일

```
.ouroboros/
├── seed.json        # 정본 seed (확장이 권위 데이터로 읽음)
├── seed.yaml        # 사람용 / Ouroboros 호환 미러
├── state.json       # interview / persona / ralph / acGrades / drift
├── interview.jsonl  # seed_set / finalize 이벤트 append-only 로그
├── telemetry.jsonl  # 로컬 전용 ambiguity & ralph 이벤트
└── .lock            # atomic 쓰기 락; session_shutdown 시 자동 제거
```

## 본 확장의 파일 구성

```
pirobos/
├── index.ts         # 확장 진입점 — 이벤트, 명령, 툴, 하네스
├── package.json     # pi-ai + pi-coding-agent 의존성, MIT 라이선스
├── tsconfig.json    # 로컬 타입체크 전용 (pi 가 자체 TS 런타임)
├── LICENSE          # MIT
└── README{.md,.ko.md,.ja.md}
```

## 워크플로 예시

```
1. /ooo-interview "할 일 관리 CLI 만들기"
   → 에이전트가 한 번에 한 질문씩 Socratic 인터뷰 진행
   → 답변마다 ooo_seed_set 호출하여 state.json 의 draft 업데이트
   → ambiguity ≤ 0.2 + AC ≥ 5 도달 시 ooo_seed_finalize → seed.json + seed.yaml 잠김

2. (코드 작성 — seed 잠겼으므로 Edit/Write 허용)

3. /ooo-evaluate
   → npm test / pytest / make test / cargo test / go test 자동 감지 + 실행
   → ooo_grade_ac 로 각 AC 를 파일 단위 증거로 채점
   → pass / fail 집계 출력

4. /ooo-drift
   → goal / constraint / ontology divergence 자가 평가
   → 가중 ≤ 0.30 OK, 초과면 DRIFTED

5. (막혔을 때) /ooo-unstuck adversary
   → 3턴 동안 "현재 솔루션을 깨려고 시도" persona 활성

6. /ooo-ralph on 8
   → 매 agent_end 후 /ooo-evaluate 자동 주입
   → 실패 AC 를 외과적으로 수정 → CONVERGED 또는 cap=8 도달 시 종료
```

## 메모

- `@mariozechner/pi-ai` 와 `@mariozechner/pi-coding-agent` 외 npm 의존성
  없음. YAML 은 손으로 직렬화하고, 정본은 JSON 사이드카에서 읽으므로
  YAML 파서 불필요.
- Mechanical 평가기는 다음 순서로 자동 감지:
  `package.json#scripts.test` → `npm test --silent` →
  `pyproject.toml`/`pytest.ini` → `pytest -q` →
  `Makefile` 의 `test:` 타겟 → `make test` →
  `Cargo.toml` → `cargo test --quiet` →
  `go.mod` → `go test ./...` →
  감지 실패 시 skipped 처리. 변경하려면 `index.ts` 의 `detectMechanical`
  패치.
- Ralph 는 사용자 지정 N (기본 8) 으로 하드 cap 정지. 수렴을 위해 AC
  약화 일체 없음 — 정직하게 통과 못하면 멈추고 보고.
- 이미 seed 가 잠긴 상태에서 새로 `/ooo-interview` 시작하면 새 draft 가
  생성되지만 기존 `seed.yaml` 은 보존. 덮어쓰려면 `ooo_seed_finalize`
  재호출.
