# pirobos

[pi](https://github.com/badlogic/pi-mono)를 위한 [Ouroboros](https://github.com/Q00/ouroboros) 네이티브 루프.

`ouroboros` Python CLI를 감싼 래퍼가 **아닙니다**. spec-first 루프
(interview → seed → evaluate → drift → unstuck → ralph)를 pi 안에서 TypeScript
확장으로 직접 구현합니다. 상태는 프로젝트 루트의 `.ouroboros/`에 저장되며,
`seed.yaml`은 사람이 읽을 수 있고 원본 Ouroboros 포맷과 호환됩니다.

## 코딩 하네스

본 확장이 로드된 동안 [Karpathy 코딩
가이드라인](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)
(Think Before Coding · Simplicity First · Surgical Changes · Goal-Driven
Execution)을 system prompt 에 항상 주입합니다. `index.ts` 의
`KARPATHY_HARNESS` 상수로 인라인 번들되어 있으며, 끄려면 prompt block
에서 해당 상수를 제외하면 됩니다.

## 이식한 개념

| 개념        | 본 확장에서의 구현                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Seed       | `.ouroboros/seed.json` (정본) + `seed.yaml` (미러). 한 번 finalize 되면 잠김.                          |
| Interview  | `before_agent_start`가 Socratic 지시를 system prompt에 주입. LLM이 `ooo_seed_set` / `ooo_seed_finalize` 로 기록. |
| Evaluate   | Mechanical (자동 감지: `npm test` / `pytest` / `make test` / `cargo test` / `go test`) + Semantic (LLM이 `ooo_grade_ac` 로 각 AC 채점). |
| Drift      | LLM이 goal / constraint / ontology 를 [0,1] 로 자가 보고 → 가중 평균 0.5 / 0.3 / 0.2, 임계치 ≤ 0.30.        |
| Unstuck    | 5개 lateral persona (inverter, first-principles, naive-newcomer, adversary, architect)를 3턴 동안 system prompt 에 주입. |
| Ralph      | 매 턴마다 follow-up 자동 주입 → 모든 AC 통과 (CONVERGED) 또는 cap (기본 8) 도달 시 자동 종료.                |

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

## 슬래시 커맨드

| 커맨드                    | 동작                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `/ooo-interview <목표>`    | 주어진 목표에 대해 Socratic 인터뷰 시작                               |
| `/ooo-seed`               | 잠긴 seed (또는 작성 중 draft) 출력                                   |
| `/ooo-evaluate`           | Mechanical 테스트 실행 + 각 AC 를 LLM 이 채점하도록 지시              |
| `/ooo-drift`              | 잠긴 seed 대비 drift 를 LLM 이 자가 평가                              |
| `/ooo-unstuck [id]`       | 3턴 동안 lateral persona 로 전환. 인자 없으면 선택 다이얼로그          |
| `/ooo-ralph [on\|off\|N]` | 자동 follow-up 루프 토글. `N` 으로 턴 cap 지정                        |
| `/ooo-status`             | interview / seed / persona / ralph / drift 현재 상태                  |
| `/ooo-reset`              | 세션 상태 초기화 (잠긴 seed 는 삭제하지 않음)                          |

## LLM 호출 가능한 툴

| 툴                  | 용도                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `ooo_seed_set`      | 인터뷰 중 seed draft 를 누적 업데이트 (필드 머지)                        |
| `ooo_seed_finalize` | draft 를 `seed.yaml` 로 잠금. 조건: ambiguity ≤ 0.2, AC ≥ 5             |
| `ooo_grade_ac`      | 평가 단계에서 단일 AC 의 verdict (pass / fail / n/a) 기록               |
| `ooo_record_drift`  | drift 컴포넌트와 가중 점수 기록                                          |

## Lateral Persona 5종

| ID                | 역할                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `inverter`        | 모든 요구사항의 반대를 가정 — 어떤 요구가 본질적이고 어떤 것이 장식인지 노출 |
| `first-principles`| 물리/수학/논리 근본까지 분해 — 기존 접근을 잊고 공리에서 재구성          |
| `naive-newcomer`  | 코드베이스를 처음 보는 사람 시점 — 문서화되지 않은 모든 암묵적 가정 노출   |
| `adversary`       | 현재 솔루션을 적극적으로 깨려 시도 — 엣지 케이스, 레이스, 보안 구멍       |
| `architect`       | 줌 아웃해서 모듈 경계를 다시 그림 — 만약 seam 이 다른 곳에 있었다면?     |

## 라이프사이클

`session_start` → `.ouroboros/state.json` 과 `seed.json` 로드.
`before_agent_start` → 현재 seed / interview / persona / ralph 상태를 system
prompt 끝에 컨텍스트 블록으로 추가.
`agent_end` → persona 잔여 턴 감소, interview 턴 카운트, ralph 가 켜져 있으면
다음 evaluate-and-continue follow-up 메시지를 자동 주입 (cap 도달 시 자동 종료).

## 워크플로우 예시

```
1. /ooo-interview "할 일 관리 CLI 만들기"
   → LLM 이 한 번에 한 질문씩 Socratic 인터뷰 진행
   → 답변할 때마다 LLM 이 ooo_seed_set 으로 draft 갱신
   → ambiguity ≤ 0.2, AC ≥ 5 도달 시 ooo_seed_finalize → seed.yaml 잠김

2. (코드 작성)

3. /ooo-evaluate
   → npm test / pytest / make test 자동 실행 (mechanical)
   → LLM 이 각 AC 별로 ooo_grade_ac 호출 (semantic)
   → pass / fail / n-a 집계

4. /ooo-drift
   → LLM 이 goal / constraint / ontology divergence 자가 보고
   → 가중 점수 ≤ 0.30 이면 OK, 초과면 DRIFTED

5. (막혔을 때) /ooo-unstuck adversary
   → 3턴 동안 "현재 솔루션을 깨려고 시도" persona 주입

6. /ooo-ralph on
   → 매 턴 후 자동으로 evaluate → 실패한 AC 수정 반복
   → 모두 pass 면 CONVERGED 출력 후 자동 정지 (또는 cap 도달 시)
```

## 파일

```
.ouroboros/
├── seed.json        # 정본 (확장이 읽음)
├── seed.yaml        # 사람용 / Ouroboros 호환 미러
├── state.json       # interview / persona / ralph / AC 채점 / drift
└── interview.jsonl  # seed_set / finalize 이벤트 트랜스크립트
```

## 용어 설명

- **하드 cap (Hard cap)** — Ralph 루프의 절대 상한 턴 수 (기본 `8`,
  `/ooo-ralph on <N>` 으로 변경 가능). cap 도달까지 모든 AC 가 pass 되지
  않으면 ralph 가 스스로 OFF 되고 실패한 AC 를 보고함 — 무한 루프 방지장치.
  "하드"인 이유: 진행 중에 에이전트가 cap 을 올리거나 우회할 수 없음.
  더 돌리려면 사용자가 명시적으로 새 cap 을 지정해 재시작해야 함.
- **Scope creep (스코프 크리프)** — 잠긴 seed 범위를 벗어나는 표류:
  seed 가 약속하지 않은 AC 추가, 작업과 무관한 리팩터링, 미래의 가상
  요구사항 선반영 등. Karpathy 하네스(simplicity · surgical changes) 와
  잠긴 seed 가 두 게이트 — 변경이 현재 AC 로 추적되지 않으면 본 루프에서
  반영하지 않음. 정당하게 범위를 확장하려면 `/ooo-interview` 를 다시 돌려
  seed 를 갱신할 것.

## 메모

- pi extension API 외에 npm 의존성 없음. YAML 은 손으로 직렬화하고, 정본은 JSON
  사이드카에서 읽으므로 YAML 파서 불필요.
- Mechanical 평가기는 다음 순서로 자동 감지:
  `package.json#scripts.test` → `npm test --silent` →
  `pyproject.toml`/`pytest.ini` → `pytest -q` →
  `Makefile` 의 `test:` 타겟 → `make test` →
  `Cargo.toml` → `cargo test --quiet` →
  `go.mod` → `go test ./...` →
  감지 실패 시 skipped 처리. 변경하려면 `index.ts` 의 `detectMechanical` 패치.
- Ralph 는 하드 cap (기본 8턴) 으로 자동 정지. 무한 루프 발생하지 않음.
- 이미 seed 가 잠긴 상태에서 새로 `/ooo-interview` 를 시작하면 새 draft 가
  생성되지만 기존 `seed.yaml` 은 보존됨. 덮어쓰려면 `ooo_seed_finalize` 다시 호출.
