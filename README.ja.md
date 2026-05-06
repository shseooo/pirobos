# pirobos

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md)

[Ouroboros](https://github.com/Q00/ouroboros) ワークフローを
[pi](https://github.com/badlogic/pi-mono) の拡張としてネイティブ移植。

`ouroboros` Python CLI のラッパーでは**ありません**。spec-first ループ
(interview → seed → evaluate → drift → unstuck → ralph) を pi 内部で
TypeScript 拡張として直接実装しています。状態はプロジェクトルートの
`.ouroboros/` に保存され、[Karpathy コーディングハーネス](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)
は `index.ts` にインラインバンドルされ、**seed がロックされている時のみ**
system prompt に注入されます (スペック確定前のセッションは augment されません)。

`.ouroboros/` は [clauroboros](https://github.com/shseooo/clauroboros)
(Claude Code 移植版) とバイト単位で互換 — 同じプロジェクトを 2 つの
エージェントで切り替えてもインタビューをやり直す必要なし。

## インストール

```sh
# clone
git clone https://github.com/shseooo/pirobos.git
cd pirobos && npm install

# プロジェクトローカルインストール
mkdir -p .pi/extensions
ln -s "$(pwd)" .pi/extensions/pirobos

# またはグローバルインストール
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pirobos
```

その後 pi で `/reload`。

## 移植した概念

| 概念        | 本拡張での実装                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Seed       | `.ouroboros/seed.json` (正本) + `seed.yaml` (ミラー)。finalize 後にロック。                              |
| Interview  | `before_agent_start` が Socratic 指示を system prompt に注入。LLM が `ooo_seed_set` / `ooo_seed_finalize` で記録。 |
| Evaluate   | Mechanical (自動検出: `npm test` / `pytest` / `make test` / `cargo test` / `go test`) + Semantic (LLM が `ooo_grade_ac` で各 AC 採点)。 |
| Drift      | LLM が goal / constraint / ontology を [0,1] で自己報告 → 重み付け 0.5 / 0.3 / 0.2、閾値 ≤ 0.30。           |
| Unstuck    | 5 種類の lateral persona (inverter, first-principles, naive-newcomer, adversary, architect) を 3 ターンの間 system prompt に注入。 |
| Ralph      | `agent_end` → `pi.sendUserMessage({deliverAs:"followUp"})` で次の evaluate-and-fix を自動注入。全 AC 通過または cap 到達で自動停止。 |
| ハーネス    | `index.ts` の `KARPATHY_HARNESS` 定数 — `before_agent_start` が seed ロック時のみ system prompt の先頭に追加。 |

## 用語集

- **Seed (シード)** — 不変の仕様: goal + acceptance criteria + constraints
  + ontology + exposed assumptions。一度ロックされると全コマンドが権威
  データとして扱う。`seed.json` (正本) + `seed.yaml` (ミラー) として保存。
- **Acceptance Criterion (AC)** — 「完了」の一部を定義する検証可能な
  単一ステートメント。各 AC は mechanical テストまたはコードベース検査で
  `pass` / `fail` / `n/a` に採点される。seed ロック条件: AC ≥ 5。
- **Ambiguity score (曖昧度スコア)** — インタビュー中の仕様の曖昧さを
  表す 0–1 のスコア。ambiguity ≤ 0.2 のときだけ seed をロック可能。
- **Constraint (制約)** — 解が守るべき非機能要件 (性能、セキュリティ、
  互換性、依存性ポリシー等)。
- **Ontology (オントロジー)** — プロジェクト固有の語彙を固定する 用語 →
  定義 マップ。全コマンドと AC が同一概念を参照することを保証。
- **Persona (ペルソナ)** — 詰まり状態を打開する lateral-thinking レンズ
  5 種: `inverter`, `first-principles`, `naive-newcomer`, `adversary`,
  `architect`。`state.json` に記録され、`agent_end` フックが 3 ターンで
  自動デクリメント。
- **Drift (ドリフト)** — 現在の作業とロック済み seed の乖離。重み付け
  `0.5*goal + 0.3*constraint + 0.2*ontology`。≤ 0.30 で OK、超えると
  DRIFTED。
- **Ralph (ラルフ)** — 自律 evaluate-and-fix ループ。各 `agent_end` の後、
  pirobos が `/ooo-evaluate` の follow-up を自動注入 → 全 AC pass
  (CONVERGED) または cap 到達で停止。
- **Hard cap (ハード cap)** — `/ooo-ralph` が強制停止されるまでの最大
  反復回数 (デフォルト 8、`/ooo-ralph on <N>` で変更可能)。暴走ループを
  防ぐためのもの。cap に到達しても AC が収束していなければ、AC を弱めて
  偽の成功を作るのではなく、正直に停止して報告。「ハード」の理由: 進行中に
  エージェントが cap を上げたり迂回したりできない。
- **Scope creep (スコープクリープ)** — ロック済み seed からの漸進的
  乖離: 機能の追加、ゴールの拡大、用語の再定義、制約の暗黙的緩和など。
  `/ooo-drift` で検出。seed は推奨ではなく境界線 — 本当にゴールが変わった
  なら、黙って広げずに止めて `/ooo-interview` をやり直す。
- **Karpathy ハーネス** — コーディング行動ガイドライン (まず考える、
  外科的変更、成功基準を定義、仮定を明示)。`index.ts` の
  `KARPATHY_HARNESS` 定数にインラインバンドル。seed ロック時のみ
  `before_agent_start` が system prompt に注入。
- **Hard evaluate gate (ハード評価ゲート)** — pi 専用: `tool_call` フック
  が `edit` / `write` / `notebook_edit` 呼び出しに対して seed 未ロック時
  に `{block: true}` を返す。全プロジェクトで「インタビュー先行コーディング」
  を強制。
- **Session lock (セッションロック)** — `session_start` で
  `fs.openSync(.lock, "wx")` により atomic 作成。同じプロジェクトでの
  並行 pi セッションは、state.json を破壊する代わりに明示的エラーで失敗。

## スラッシュコマンド

| コマンド                  | 動作                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `/ooo-interview <ゴール>`     | ゴールを seed に結晶化する Socratic インタビューを開始              |
| `/ooo-seed`                   | ロック済み seed (または現在の draft) を出力                         |
| `/ooo-evaluate`               | mechanical テスト実行 + 各 AC をファイルレベルの証拠で採点          |
| `/ooo-drift`                  | ロック済み seed に対する drift を自己評価                            |
| `/ooo-unstuck [id]`           | 3 ターンの間 lateral persona に切り替え。引数なしで選択ダイアログ    |
| `/ooo-ralph [on\|off\|N]`     | 自動 follow-up ループ切替。`N` でターン cap 指定                    |
| `/ooo-status`                 | interview / seed / persona / ralph / drift の状態                  |
| `/ooo-reset`                  | セッション状態をクリア (ロック済み seed は保持)                     |

## LLM 呼び出し可能なツール

| ツール              | 用途                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `ooo_seed_set`      | インタビュー中の seed draft を累積更新 (フィールドマージ)              |
| `ooo_seed_finalize` | draft を `seed.yaml` にロック。条件: ambiguity ≤ 0.2、AC ≥ 5            |
| `ooo_grade_ac`      | 評価段階で単一 AC の verdict (pass / fail / n/a) を記録                |
| `ooo_record_drift`  | drift コンポーネントと重み付けスコアを記録                             |

## いつどのコマンドを使うか

| 状況                                                       | コマンド                  |
| ---------------------------------------------------------- | ------------------------- |
| 曖昧なゴールで新機能/タスクを開始                          | `/ooo-interview <ゴール>` |
| 現在の仕様 (ロック済み seed または draft) を確認            | `/ooo-seed`               |
| 意味のある作業ステップ完了 — AC に対して検証               | `/ooo-evaluate`           |
| 何度か編集後 scope creep を疑う                            | `/ooo-drift`              |
| 詰まる、ループする、低品質な解しか出ない                    | `/ooo-unstuck [persona]`  |
| ハード cap 内で自律的に全 AC 通過させたい                   | `/ooo-ralph [N]`          |
| ループ上どこにいるか忘れた                                  | `/ooo-status`             |
| 進行中状態をクリアし seed は保持                            | `/ooo-reset`              |

### `/ooo-unstuck` の persona 選択ガイド

| 詰まっている理由                                     | Persona            |
| ---------------------------------------------------- | ------------------ |
| 設計が過剰に複雑に感じる                             | `inverter`         |
| 悪い土台の上にパッチを重ねている                     | `first-principles` |
| コードベースが見知らぬもので仮定が隠れている          | `naive-newcomer`   |
| 解が正しいか判断できない                             | `adversary`        |
| モジュール境界が間違っているように感じる             | `architect`        |

### ループ運用ガイド

- 些末でない作業なら **コードを書く前に** `/ooo-interview` を実行。ハード
  評価ゲートがこれを強制 — seed ロック前は `Edit`/`Write` が遮断され、
  スペックなしでコーディング開始は不可能。
- 「完了」を宣言する前のゲートとして `/ooo-evaluate` を使う — AC 採点
  なしの自己宣言は禁止。
- `/ooo-drift` は定期的に (数回の編集後、リファクタ後) 実行 — 安価で
  scope creep の早期検出に効く。
- `/ooo-ralph` は残作業が mechanical (失敗 AC + 明確な修正経路) のときに
  使用。**AC が間違っているときは使わない**。AC が間違いなら止めて
  `/ooo-interview` で seed を改訂。収束させるために AC を弱めるのは絶対
  に禁止。

## pirobos が活用する pi 拡張機能

Claude Code と異なり、pi はターン単位のライフサイクルフックを公開して
います。pirobos はこれらを活用して `clauroboros` よりも厳格な強制力を
実現:

- **ターン単位 system prompt 注入** — `before_agent_start` が毎ターン、
  Karpathy ハーネス、現在の seed、interview 状態、persona、ralph 状態を
  system prompt に追加 (seed ロック時のみ)。
- **ターン間自動 follow-up** — `agent_end` +
  `pi.sendUserMessage(..., {deliverAs:"followUp"})` の組み合わせで、
  Ralph が単一の拡張コマンドではなく自然なマルチターンループとして動作。
- **Hard evaluate gate** — `tool_call` が `{block:true}` を返す → seed
  未ロック時は `Edit` / `Write` / `NotebookEdit` を理由付きで拒否。
  スペック迂回を遮断。
- **Session lock** — `fs.openSync(.lock, "wx")` の atomic 作成。同じ
  プロジェクトでの並行 pi セッションが state.json を競合する代わりに
  明示的エラーで失敗。
- **ローカル専用テレメトリ** — `.ouroboros/telemetry.jsonl` に ambiguity
  サンプル + ralph 収束/cap イベントを append。マシン外への送信は一切なし。

## 状態ファイル

```
.ouroboros/
├── seed.json        # 正本 seed (拡張が権威データとして読み込み)
├── seed.yaml        # 人間 / Ouroboros 互換ミラー
├── state.json       # interview / persona / ralph / acGrades / drift
├── interview.jsonl  # seed_set / finalize イベントの append-only ログ
├── telemetry.jsonl  # ローカル専用 ambiguity & ralph イベント
└── .lock            # atomic 書込ロック; session_shutdown で自動削除
```

## 本拡張のファイル構成

```
pirobos/
├── index.ts         # 拡張エントリ — イベント、コマンド、ツール、ハーネス
├── package.json     # pi-ai + pi-coding-agent 依存、MIT ライセンス
├── tsconfig.json    # ローカルタイプチェック専用 (pi が独自 TS ランタイム)
├── LICENSE          # MIT
└── README{.md,.ko.md,.ja.md}
```

## ワークフロー例

```
1. /ooo-interview "TODO 管理 CLI を作る"
   → エージェントが一度に一つずつ Socratic インタビューを実施
   → 回答ごとに ooo_seed_set を呼び出して state.json の draft を更新
   → ambiguity ≤ 0.2 + AC ≥ 5 に到達したら ooo_seed_finalize で seed.json + seed.yaml をロック

2. (コードを書く — seed がロックされたので Edit/Write が許可される)

3. /ooo-evaluate
   → npm test / pytest / make test / cargo test / go test を自動検出 + 実行
   → ooo_grade_ac で各 AC をファイルレベルの証拠で採点
   → pass / fail の集計を出力

4. /ooo-drift
   → goal / constraint / ontology の divergence を自己評価
   → weighted ≤ 0.30 なら OK、超えると DRIFTED

5. (詰まったとき) /ooo-unstuck adversary
   → 3 ターンの間「現在の解を壊そうとする」persona を有効化

6. /ooo-ralph on 8
   → 各 agent_end の後、/ooo-evaluate を follow-up として自動注入
   → 失敗 AC を外科的に修正 → CONVERGED または cap=8 到達で終了
```

## メモ

- `@mariozechner/pi-ai` と `@mariozechner/pi-coding-agent` 以外の npm 依存
  なし。YAML は手で直列化し、正本は JSON サイドカーから読み込むので
  YAML パーサ不要。
- Mechanical 評価器は次の順で自動検出:
  `package.json#scripts.test` → `npm test --silent` →
  `pyproject.toml`/`pytest.ini` → `pytest -q` →
  `Makefile` の `test:` ターゲット → `make test` →
  `Cargo.toml` → `cargo test --quiet` →
  `go.mod` → `go test ./...` →
  検出失敗時は skipped。変更するには `index.ts` の `detectMechanical`
  をパッチ。
- Ralph はユーザ指定の N (デフォルト 8) でハード cap。AC を弱めて
  「収束」させることは絶対に無し — 正直に通せなければ止めて報告する。
- すでに seed がロックされている状態で新たに `/ooo-interview` を開始
  すると新しい draft が作成されるが、既存の `seed.yaml` は保持される。
  上書きするには `ooo_seed_finalize` を再呼出。
