## Glossary

> **対象読者**: 用語に迷った developer / operator
> **前提**: なし
> **読了時間**: 必要なところだけ拾い読み

mex-next と Python 版 MeX の用語を統一的に定義します。

## A

**account-id**
1 顧客 1 X account に対する識別子。kebab-case (`zumi-x`, `tanaka-x`)。systemd unit / Doppler project / account repo の名前に使う。

**account.json**
顧客の永続設定。persona / brand / cadence / targets / approval_policy / goal_stack / brand / active_window / half_focus を持つ。account repo に配置。

**account repo**
`<account-id>-x-ops` という名前の GitHub private repo。account.json + state.json + content/ を持つ正本。

**active_window**
今月の主軸 topic / 役割 / 配分。monthly retrospective の writeback で更新される。

**approval store**
in-memory の confirmation 保留所。approvalId に対する `{intent, args, expiresAt}` を保持。120 秒 TTL。

**automation enable_all**
顧客の全自動運用フラグを一括 ON にする destructive intent。

## B

**brand**
voice (語尾 / 一人称 / 丁寧度) + tone (硬軟 / 静動) を持つ顧客のブランド設定。account.json#brand に保存。quarterly retrospective の writeback 対象。

**bridge (LLM Bridge)**
LLM 呼出の単一窓口。`src/llm/bridge.ts`。kind ごとに provider / timeout / max_tokens / cache を切替。

## C

**cadence**
投稿頻度 profile。`light` / `standard` / `aggressive`。各 profile に hot_zones が紐づく。

**candidate**
draft の本体。topic + text + meta を持つ。`src/posting/candidate.ts`。

**claude-code provider**
claude CLI を execa subprocess で起動して LLM 呼出する provider。長い思考タスク向け。

**confirmation_needed**
intent classify の出力フィールド。destructive intent なら強制 true、display intent なら強制 false。

**conversation lock**
1 顧客 = 1 turn の serialize lock。`Map<userId, Promise<void>>` で実装。

**content/<content-id>/**
publish 済みの投稿本体 + draft 履歴を保存する dir。content.json + draft.json を持つ。

## D

**dedup**
重複防止。同 topic は過去 7 日 + 未来 7 日でチェック、本文先頭 80 文字 prefix 一致を block。

**destructive intent**
`schedule.cancel` / `schedule.publish_now` / `target.remove` / `automation.enable_all` / `cadence.skip_today` / `cadence.set_*`。confirmation 強制。

**display intent**
`schedule.list` / `schedule.detail` / `target.list` / `automation.status` / `status.show` / `help.show`。confirmation 強制 OFF。

**Doppler**
secrets 管理サービス。X API key / Anthropic key / Discord bot token / GitHub token を集約。VPS には service token のみ置く。

**draft.json**
content/<id>/draft.json。draft の rev 履歴 (rev 1, 2, 3, ..., final) を保持。edit-diff 学習の元データ。

**draft card**
朝の Posting v2 card。1 通の Discord message を更新して進行を見せる。

## E

**edit-diff**
顧客の修正前後 (`original` → `final`) の差分。compute_edit_diff で記録、以降の draft 生成に hint として注入する学習ループ。

**execa**
Node.js subprocess library。claude-code CLI の起動に使う。

**expired**
posting session の終端状態の 1 つ。24h TTL elapsed。

## F

**failed_terminal**
posting session の終端状態の 1 つ。回復不能な error。

**flock**
file lock。proper-lockfile package で実装。同 host の複数 process の race 回避。

## G

**goal_stack**
3 ヶ月の方向性を表す 3-5 項目のリスト。account.json#goal_stack。quarterly retrospective の writeback 対象。

**guild**
Discord の server。1 顧客 1 guild が原則。

## H

**half_focus**
半期の柱。account.json#half_focus。half retrospective の writeback 対象。

**handle**
X (Twitter) の username。`@` なし、英数 + `_`。agent loop tool input / legacy intent-router で正規化。

**horizon**
retrospective の単位。`daily` / `weekly` / `monthly` / `quarterly` / `half`。

**hot zone**
cadence profile に紐づく投稿可能な時間帯。`{ start: "06:00", end: "09:00" }`。

## I

**agent_turn**
LLM kind の 1 つ。agent loop の primary call。state snapshot + tool catalog を渡し、JSON schema 付きで reply / tool_call / needs_confirmation を返す。

**intent**
legacy fallback の自然文分類名 (例: `schedule.list`)。primary path は `src/llm/agent-loop.ts` の tool catalog を使う。

**intent_classify**
LLM kind の 1 つ。legacy intent-router fallback 用。anthropic provider 直接、prompt cache ON、timeout 8s。

**inbound reaction**
受信した reply / quote / mention / 影響大 retweet。state.inbound_reaction_sessions に保存。

**install.sh**
共通基盤 (Node 20 + Doppler + gh + Claude Code) を入れる script。

## J

**JST**
Japan Standard Time (UTC+9)。`src/utils/jst.ts` に helper。timer の発火時刻はすべて JST 基準。

## K

**kind (LlmKind)**
LLM 呼出の分類タグ。`agent_turn` を含む全 kind は `src/llm/kinds.ts` 参照。

## L

**light cadence**
1 日 1 本、朝 06:00-09:00 JST のみ。default profile。

**LlmProvider**
LLM 呼出の interface。anthropic-provider / claude-code-provider / codex-cli-provider の 3 実装。

## M

**mex-bot.service**
systemd unit。Long-running bot プロセス。

**mex-daily-<id>.timer**
朝 07:00 JST 発火の daily auto post timer。

**mex-publish-<id>.timer**
5min interval、publish_queue を drain。

**mex-reactions-poll-<id>.timer**
15min interval、X API poll。

**mex-self-update.timer**
30min interval、git pull + build + restart。

**mex-weekly-retro-<id>.timer**
月曜 07:00 JST 発火の weekly retrospective timer。

**mex-phase-questionnaire-weekly-<id>.timer**
月曜 09:00 JST 発火の weekly phase questionnaire timer。

**mex-phase-questionnaire-monthly-<id>.timer**
月初 09:00 JST 発火の monthly phase questionnaire timer。

**mex-proactive-nudge-<kind>-<id>.timer**
weekly / monthly / stale-target / unanswered-phase の proactive nudge timer。

## O

**operator**
運用者。VPS / Doppler / Discord Dev Portal / X API key を全部用意する人。

**operator allowlist**
DM 以外の channel で自然文応答を許可する Discord user ID リスト。`OPERATOR_DISCORD_USER_IDS`。

**operator escalate**
preflight fail / publish 失敗 (3 回) / channel resolve 失敗時に operator channel + DM に流す pipeline。

## P

**pending turn store**
in-memory の進行中 turn 状態。restart で消えるが、次 message で再構築。

**persona**
顧客の文体ガイド。voice の核。account.json#persona。

**Posting v2**
朝の draft → 5-axis judge → repair → 顧客承認 → schedule → publish の状態機械。`src/posting/state-machine.ts`。

**plan_writeback_history**
state.json の writeback 履歴 (max 10 件)。rollback 用。

**preflight**
bot 起動時 / daily 前に 10 hard gate を check。

**proper-lockfile**
flock 実装の npm package。retry 戦略付き。

**publish_queue**
state.json の field。scheduled な投稿の待機列。

## Q

**quote-v2**
自分のポストが引用された時の応答 flow。元投稿 + 引用元 + 引用主の発言 + 下書き response が 1 thread にまとまる。

## R

**rate limit**
X API の月間 quota。`state.x_api_rate_limit` で endpoint 別に追跡。

**repairing**
posting session の状態。5-axis fail 時に auto-repair 中。最大 2 回試行。

**retrospective**
horizon ごとの振り返り。daily / weekly / monthly / quarterly / half。

**revising**
posting session の状態。顧客の指示で regenerate 中。

**risk_classify**
inbound reply / quote の risk level (low/medium/high) を LLM で分類。

**rollback**
plan_writeback の取り消し。state.plan_writeback_history から restore。

## S

**5-axis judge**
hard gate quality 判定。stop_power / specificity / progression / voice_match / length_fit、各 0-5 点、3 軸 pass で gate 通過。

**scheduled**
posting session の状態。publish_queue に投入済み。

**self-update**
30min 間隔で git pull + npm install + npm run build + restart する仕組み。

**session**
posting session = 1 投稿の生成から publish までの状態を持つ object。`state.posting_sessions[]`。

**skip_today**
今日の draft + 既存予約をすべてキャンセルする機能。state.skip_dates に YYYY-MM-DD を追加。翌日 00:00 で自動失効。

**slash command**
`/mex post` 等の Discord slash command。power user / operator 用に並行で残してある。

**state.json**
runtime state。posting_sessions / publish_queue / interaction_queue / inbound_reaction_sessions / skip_dates / x_api_rate_limit / plan_writeback_history / last_retrospective_at を持つ。

## T

**target**
追跡対象 X account。account.json#targets[]。target discovery で投稿の hint に使う。

**target discovery**
target の最近投稿を集計し、hot な topic を draft 生成 prompt に注入する機能。

**TERMINAL_STATES**
`{ published, failed_terminal, expired }`。これに到達したら状態遷移しない。

**too_similar_recent**
dedup の block reason。本文先頭 80 文字 prefix 完全一致。

**too_similar_topic**
dedup の block reason。同 topic が過去 7d / 未来 7d 以内。

**TTL**
session の time-to-live。default 24h。

**turn**
顧客の 1 メッセージ → bot の 1 応答 = 1 turn。

**turn-cancellation**
進行中 turn を新メッセージで cancel して新 turn に切替える機能。

**turn-orchestrator**
turn lock + cancel + recovery を担当する core。

**twitter-api-v2**
X API client npm package。bot で使用。

## U

**unknown intent**
legacy intent classify が失敗した時の fallback。顧客向け固定メッセージで吸収。

## V

**voice_match**
5-axis judge の 1 軸。draft が persona / brand に合っているか。

## W

**wah-office-v2**
姉妹プロジェクト。Discord 対話エンジンの patterns はここから移植。

**writeback**
retrospective の結果を account.json に書き戻す動作。`src/account-state/plan-writeback.ts`。

## X

**X API**
X (Twitter) v2 API。Basic tier ($100/month) を推奨。

**x-api/poll-state.ts**
endpoint 別の rate limit 残数 + reset 時刻を追跡。

## Z

**zod**
schema validation library。account.json / state.json の型保証に使用。

## 関連 docs

- [00-architecture.md](./00-architecture.md)
- [60-contributing.md](./60-contributing.md)
