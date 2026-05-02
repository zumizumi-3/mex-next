## データ ownership / export / delete

> **対象読者**: customer account を預かる operator
> **前提**: account repo / Doppler / VPS の役割を理解している
> **読了時間**: 約 6 分

MeX Next の正本は customer ごとの GitHub private repo です。operator は運用のために collaborator として参加しますが、repo の所有権は customer 側に置きます。

## 1. 所有境界

```text
customer GitHub org/user
└── <account>-x-ops        # account.json / state.json / content/*

operator
├── VPS                    # 実行環境
├── Doppler project        # secrets
└── GitHub collaborator    # 運用権限
```

account repo に残るもの:

| path                             | 内容                                                 |
| -------------------------------- | ---------------------------------------------------- |
| `account.json`                   | persona / brand / cadence / target / channel mapping |
| `state.json`                     | 予約、投稿状態、skip、学習状態                       |
| `content/`                       | draft / publish 済み本文 / engagement snapshot       |
| `AGENTS.md`, `CLAUDE.md`, `*.md` | bot が読む knowledge files                           |

operator 側に恒久保存するものは原則ありません。例外は Doppler secret と、VPS の systemd journal に残る短期ログです。

## 2. 削除権

customer はいつでも account repo を削除できます。operator は削除を止めません。

```bash
gh repo delete <customer>/<account>-x-ops
```

削除依頼を受けたら operator は次を実施します。

1. 対象 bot / timers を停止する
2. `/srv/mex-next/<account>-x-ops` など VPS 上の clone を削除する
3. `/etc/mex/<account>.env` を削除する
4. Doppler project `xops-<account>` を削除または secret を全消去する
5. `/var/lib/mex-next/accounts-registry.json` から account entry を外す

repo が消えた後、bot は復元できません。復元が必要な場合は customer が削除前に clone/export しておきます。

## 3. export / 移植権

export は account repo を clone するだけです。

```bash
gh repo clone <customer>/<account>-x-ops
```

別 operator / 別 VPS に移す時は次を渡します。

| 渡すもの        | 渡し方                                                |
| --------------- | ----------------------------------------------------- |
| account repo    | customer が collaborator を付与、または repo transfer |
| Discord bot     | token rotation 後に新 operator の Doppler へ投入      |
| X API token     | customer 同席で再発行するのが推奨                     |
| Doppler secrets | export せず、新 operator 側で再入力                   |

secrets は repo に入れません。Doppler から平文 export して受け渡す運用は避け、必要な token は rotation してから移管します。

## 4. bot 外にデータを持ち出す手順

customer が分析、監査、別ツール移行をしたい場合:

```bash
gh repo clone <customer>/<account>-x-ops
cd <account>-x-ops
tar czf account-export.tgz account.json state.json content AGENTS.md CLAUDE.md *.md
```

operator が代理で作る場合は、作成した archive を customer の指定先へ渡した後、operator の作業機と VPS から削除します。

## 5. operator 側に残るもの

残してよいもの:

- Doppler service token (`/etc/mex/<account>.env`)
- systemd unit / timer
- `/var/lib/mex-next/accounts-registry.json` の account metadata
- troubleshooting のための短期 journal

残してはいけないもの:

- `account.json` / `state.json` の別コピー
- 投稿本文の手元バックアップ
- X / Discord / GitHub token の平文メモ
- 顧客 repo の zip を operator 個人 Drive 等に保管すること

障害調査で一時コピーが必要な場合は、期限と削除担当を issue / runbook に記録します。
