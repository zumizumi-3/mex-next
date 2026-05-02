# MeX Next

X (Twitter) アカウント運用 OS の Node.js + TypeScript 完全リライト版。

`zumizumi-3/mex` (Python 実装、50K 行) の **設計と方向性のみ継承** し、Discord 体験は `wah-office-v2` のパターンを移植して再構築。

## Status

![CI](https://github.com/zumizumi-3/mex-next/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue)

(badge URL は repo 公開後の実 URL に差し替え予定)

## Quick start

```bash
npm install   # 依存 install + husky hook 登録
npm run dev   # tsx で hot reload 起動
npm test      # vitest run
```

## なぜリライトしたか

Python 実装で 1 ヶ月運用したところ、本質的な詰まりが Discord 対話レイヤーに集中していた:

- discord.py が複雑な対話 UX (turn cancellation, conversation lock, pending recovery, progress indicator) に向かない
- 自然言語インターフェース (intent → 確認 → 実行) を本格的に作るなら TypeScript が圧倒的に楽
- LLM SDK / MCP は Anthropic の TS SDK が最先端
- `wah-office-v2` (姉妹プロジェクト) で既に対話エンジンが完成しており、流用できる

業務ロジック (Posting v2 state machine, 5-axis 品質 judge, 振り返り horizon, plan writeback) は **言語に依存しない** ので、設計を保ったまま TS に移植する。

## 1 アカウント = 1 VPS = 1 Discord bot

- 顧客は **Discord しか触らない**
- operator (運用者) が VPS / Doppler / Discord Dev Portal / X API key を全部用意
- 顧客は bot に **自然文で話しかけて** 運用 (「予約見せて」「今日は投稿いらない」)
- /mex slash command は power user 用に並行で残す

## アーキテクチャ概要

詳細: [DESIGN.md](./DESIGN.md)

```
Discord Gateway (discord.js v14)
    ↓
discord/message-handler.ts ─ 自然言語 + slash command の振り分け
    ↓
conversation/turn-orchestrator.ts ─ turn lock / cancel / progress / pending recovery
    ↓
conversation/intent-router.ts ─ Claude で intent + args 抽出 → handler 呼出
    ↓
posting/* / settings/* / x-api/* (domain modules)
    ↓
account-state/state-json.ts ─ atomic write + flock
    ↓
state.json (account repo)
```

## 開発

```bash
npm install
cp .env.example .env  # 編集
npm run dev           # tsx で hot reload
npm test              # vitest
npm run typecheck
```

## 本番起動

```bash
npm run build
node dist/main.js --account-repo /srv/mex/<account>-x-ops
```

systemd unit は [deploy/](./deploy/) を参照。

## install (新規 VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/zumizumi-3/mex-next/main/scripts/install.sh | bash
curl -fsSL https://raw.githubusercontent.com/zumizumi-3/mex-next/main/scripts/bootstrap.sh | bash
```

詳細: [docs/operator/install.md](./docs/operator/install.md)

## 顧客が見る一日

詳細: [docs/customer/daily-guide.md](./docs/customer/daily-guide.md)

```
朝 7:00 JST  bot:「📝 今日の投稿案を作りました [承認] [修正] [見送り]」
        顧客:「承認」(または自然文「いい感じ」)

昼以降    リプ / 引用が来たら bot がスレッドで判断ボタンを出す
        顧客:「下のやつでお願い」

夜 19:00   bot:「🗒️ 今日の振り返り」(放置可、24h で自動確定)
```

## 移行 (Python MeX → mex-next)

`scripts/migrate-from-python.ts` で既存 account.json / state.json をそのまま読める (schema は互換)。
詳細: [docs/operator/migration.md](./docs/operator/migration.md)

## ライセンス

private
