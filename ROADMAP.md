# MeX Next Roadmap

> Living goal sheet. Claude (project lead) maintains; Codex executes.
> Update Status as WOs land. Don't archive completed phases — keep the
> trail visible.

## Pillars (4 must-haves)

| Pillar | Use | Status |
|---|---|---|
| ① **Xserver / VPS** | bot 常駐 + systemd timer | done (zumi-x 移行済) |
| ② **Claude / Codex** | LLM bridge (intent / draft / 5-axis judge) | claude_code default、Codex provider 未実装 |
| ③ **Discord** | 顧客唯一の接点 | done (auto-thread / mention 不要 / pending confirm) |
| ④ **GitHub** | code repo + state of truth + ワークフロー | repo only。Tier 1+ 未実装 |

## Currently shipping (deployed on zumi-x main)

- 自然言語 + slash 並行 (intent classify via Claude Code CLI)
- auto-thread / mention 不要
- pending-confirmation store (はい / いいえ)
- 33 問オンボーディング → bootstrap で最初の draft (background)
- Posting v2 state machine + 5-axis quality judge + repair retry cap
- Scheduler + 30min gap + dedup + cadence light default + skip_today
- Periodic retro (5 horizon) + plan writeback (atomic state+account)
- Inbound reply / quote / target collectors (dict schema + retry stage + LLM-error deferred)
- 10-gate preflight + operator escalation
- self-update 経路 (`/mex update` Discord triggered + cron timer)
- judgment events (secret redaction)
- migrate-from-python.sh (一発入れ替え、Python lock cleanup 済)

## Phase A — GitHub Tier 1 (即効、各 1-2 日)

**目的**: state を git に乗せて全変更を可視化、復旧をクリーンに、新 account 立ち上げを 1 コマンド化する。

| WO | 内容 | 担当 | Status |
|---|---|---|---|
| **A1** | `state.json` / `account.json` / `content/*` の auto commit + push | Codex | TODO |
| **A2** | Draft post → GitHub PR フロー (PR merge = schedule、comment = revise hint) | Codex | TODO |
| **A3** | `gh repo create --template` で starter から新 account 立ち上げ | Codex | TODO |
| **A4** | LLM bridge に **Codex CLI provider** 追加 (`LLM_BACKEND=codex` で切替) | Codex | TODO |

## Phase B — GitHub Tier 2 (1 週)

| WO | 内容 |
|---|---|
| **B1** | VPS 障害復旧フロー: `scripts/recover.sh <account>` で github clone + systemd 再構築 |
| **B2** | GitHub Actions で daily / weekly retro cron 化 (VPS down でも動く) |
| **B3** | gh-pages で顧客ダッシュボード (post 履歴 / retro 結果 / cadence) |
| **B4** | 顧客の修正 PR comment を edit-diff exemplar に学習 |

## Phase C — GitHub Tier 3 (運用 / ガバナンス)

| WO | 内容 |
|---|---|
| **C1** | Codespaces で account.json を schema validation 付き編集 |
| **C2** | GitHub App ベース OAuth (PAT 廃止) |
| **C3** | Operator Org に全 account repo 集約 + 横断ダッシュボード |
| **C4** | データ ownership 明文化 (顧客の repo = 顧客所有、export / 削除権) |

## Phase D — 細かい polish (随時)

- ESLint v9 flat config 移行 (現在 husky pre-commit が deprecated 警告)
- bootstrap.sh unattended mode (env 駆動で対話 skip)
- conversation lock の queuedCount の Discord visible 化
- target button: 確認 modal (誤クリック防御)
- thread name の grapheme-safe truncate を test fixture に追加

## Workflow

1. **Claude (project lead)**:
   - ROADMAP の維持、WO を 1 つずつ起こして Codex に渡す
   - 完了報告を verify (test 結果 / commit / push 確認)
   - 次の WO を取りに行く

2. **Codex**:
   - 渡された WO を実装 → typecheck → vitest → commit → 報告
   - 失敗時は原因 + 部分結果を返す

3. **User**:
   - 方針判断 (どの Phase / どの順序)
   - VPS 側での `systemctl start mex-self-update.service` 実行

## 完了済み Phase (見える化)

### Phase 0 (foundation, completed)
WO-FRESH-1 〜 13、WO-MVP-CRON、WO-PARITY-{ONBOARD,CONTENT,DISCORD}、WO-QUALITY-{INFRA,RUNTIME}、WO-AUDIT-1〜6、pending-confirmation、Q4 lenient resolve。
