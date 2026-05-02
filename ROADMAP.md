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

## Phase A — GitHub = 知識層 / Agent 指示層 (ユーザ展開ベース)

**核**: Discord は interface (会話)、GitHub は **persistent knowledge + AGENTS.md / CLAUDE.md による per-account 指示**。
顧客は GitHub UI を触らない。bot の LLM subprocess (Claude Code / Codex CLI) が account_repo を cwd として起動 → AGENTS.md / CLAUDE.md / persona.md / brand.md を **自動 load**。

| WO | 内容 | 担当 | Status |
|---|---|---|---|
| **A1** | `state.json` / `account.json` / `content/*` の auto git add+commit+push (best-effort、失敗は escalate) | Codex | done |
| **A2** | onboarding finalize で `AGENTS.md` / `CLAUDE.md` / `persona.md` / `brand.md` / `voice-guide.md` を生成。LLM bridge subprocess を `cwd: account_repo` で起動して自動 load を効かせる | Codex | done |
| **A3** | `templates/account-starter` を整備 (skeleton md 群)。`bootstrap.sh` / `migrate-from-python.sh` に `gh repo create --template` 経路 | Codex | done |
| **A4** | LLM bridge に **Codex CLI provider** 追加 (`LLM_BACKEND=codex` で切替、AGENTS.md auto-load) | Codex | done |

### account_repo 構造 (合意済)

```
/srv/mex/<account>-ops/
├── AGENTS.md         ← Codex 用 (auto-load)
├── CLAUDE.md         ← Claude Code 用 (auto-load)
├── persona.md        ← 「誰」
├── brand.md          ← 「声」「NG」
├── voice-guide.md    ← 文体例
├── targets.md        ← 追跡 target 解説
├── exemplars/        ← 修正前後の学習ログ (md)
├── retros/           ← 月次以上の振り返り結論 (md)
├── decisions/        ← 大きな運用判断ログ (md)
├── content/<id>/{content,draft}.json    ← 既存 (machine state)
├── account.json + state.json            ← 既存 (machine state)
└── README.md         ← 目次 / 顧客向け説明
```

## Phase B — 復旧 + Actions cron + 学習ループ (1 週)

| WO | 内容 |
|---|---|
| **B1** | `scripts/recover.sh <account>` で github clone + systemd 再構築 |
| **B2** | GitHub Actions で weekly retro / monthly retro / phase-questionnaire を cron 化 |
| **B3** | 顧客の Discord 修正コメント / 修正再生成を `exemplars/*.md` に flatten 出力 (人間が読める学習ログ) |
| **B4** | bot 起動時に AGENTS.md / persona.md の整合性 check (preflight に追加) |

Status: done

## Phase C — operator 体験 / ガバナンス (落ち着いてから)

| WO | 内容 |
|---|---|
| **C1** | Operator Org に全 account repo を集約 (`zumizumi-3/<account>-ops` を operator org に fork or transfer) |
| **C2** | データ ownership ドキュメント化 (顧客が repo を移管 / 削除可能) |
| **C3** | multi-account の横断 retro / brand 学習共有 (operator 専用) |

Status: done

## Phase D — 細かい polish (随時)

- ESLint v9 flat config 移行 (現在 husky pre-commit が deprecated 警告)
- bootstrap.sh unattended mode (env 駆動で対話 skip)
- conversation lock の queuedCount の Discord visible 化
- target button: 確認 modal (誤クリック防御)
- thread name の grapheme-safe truncate を test fixture に追加

Status: done

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

### Phase A (GitHub knowledge layer, completed)
account_repo 構造、knowledge files、LLM subprocess cwd、starter template、Codex CLI provider 経路。

### Phase B (recovery + Actions cron + learning loop, completed)
recover.sh、Actions cron、exemplars flatten、起動時 preflight 整合性 check。

### Phase C (operator governance, completed)
operator org 集約方針、data ownership docs、cross-account report。

### Phase D (UX polish, completed)
ESLint flat config、bootstrap unattended、queuedCount visible、target confirm、grapheme-safe thread-name fixtures。

## Phase E (将来)

- operator dashboard CLI: registry 横断 status / journal shortcut / report history viewer
- Slack 連携: operator alert の optional sink
- 複数 LLM A/B: account 単位で backend と prompt variant を比較
- report の HTML/dashboard 化: cross-account report の時系列比較
- GitHub repo health monitor: stale Actions / sync failure / permission drift の定期検出
