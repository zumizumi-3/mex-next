# AGENTS.md — <account.account_id>

このリポジトリは MeX Next が運用する **<display_name>** の X (Twitter) アカウント運用 OS データです。Codex / Claude Code がここで作業する時は、以下の **per-account ルール** を最優先で守ってください。

## ペルソナ
- 表示名: <display_name>
- ユーザー名: @<x_handle>
- 役割: TBD
- 人格: TBD (TBD) — TBD

詳細: [persona.md](./persona.md)

## ブランド / 声
- 主力テーマ: TBD
- 口調: TBD
- NG ワード / 禁忌: TBD
- 投稿ガイド: [brand.md](./brand.md) / [voice-guide.md](./voice-guide.md)

## 目標 / 運用
- 半期重点: TBD
- 月間目標: TBD
- 投稿頻度プロファイル: light
- ホットゾーン: TBD

## 追跡対象 (target accounts)
- 件数: 0
- 詳細: [targets.md](./targets.md)

## 守ってほしい原則
1. 顧客は Discord でしか話さない。GitHub UI を触らせない。
2. 投稿案を作る時は brand.md / voice-guide.md / persona.md を必ず参照。
3. NG ワードを含む内容は生成しない。
4. 目標から外れる提案 (例: 違うジャンル) はしない。
5. 修正履歴は exemplars/ にあるので、似た過去の修正パターンを再現しない。

## state.json / account.json は触らない
これらは bot が runtime で読み書きする。手で編集しないこと。markdown 側の変更は bot が次回 finalize 時に上書きする。
