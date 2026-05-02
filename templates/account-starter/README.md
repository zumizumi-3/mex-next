# <account.account_id> — MeX 運用データ

このリポジトリは MeX Next が運用する X アカウント運用データです。

この starter は新規アカウント用の空の骨格です。Discord で onboarding を完了すると、mex-next bot が `account.json` から `AGENTS.md` / `CLAUDE.md` / `persona.md` / `brand.md` / `voice-guide.md` / `targets.md` / `README.md` を実データで更新します。

## 構成
- `AGENTS.md` / `CLAUDE.md` — LLM (Codex / Claude Code) が自動読込する指示書
- `persona.md` / `brand.md` / `voice-guide.md` — ペルソナと文体の知識ベース
- `targets.md` — 追跡対象アカウント一覧
- `account.json` / `state.json` — bot の runtime state (人手で編集しない)
- `content/<id>/` — 投稿案のスナップショット
- `exemplars/`, `retros/`, `decisions/` — 学習・振り返り・判断のログ (markdown)

## 使い方
- 顧客側で触る場面はありません。Discord で `/mex` または bot にメンションしてください。
- 何かを変えたい時は markdown を直接編集するのではなく、bot に話しかけて反映を依頼してください。
