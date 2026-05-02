## Discord Application 作成手順

> **対象読者**: bootstrap 前に Discord bot を作る operator
> **前提**: Discord アカウントを持っている
> **読了時間**: 約 8 分

1 account = 1 Discord Application = 1 bot user = 1 server (guild)。混線回避のため厳守してください。

## 1. Discord Developer Portal

https://discord.com/developers/applications にアクセス。

```mermaid
flowchart LR
    A[New Application] --> B[Name: mex-<account-id>]
    B --> C[Bot tab]
    C --> D[Reset Token]
    D --> E[Privileged Intents ON]
    E --> F[OAuth2 URL Generator]
    F --> G[invite to guild]
```

### 1.1 Application 作成

- **New Application** を押下
- Name: `mex-<account-id>` (例: `mex-zumi-x`)
- Description は「X account ops bot for &lt;account-id&gt;」程度

### 1.2 Application ID を控える

General Information タブの **Application ID** をコピー。
これは slash command 登録時の `--application-id` に使います。

```text
DISCORD_APPLICATION_ID=12345678901234567
```

## 2. Bot 作成

Bot タブ → **Reset Token** で token を生成 → コピーして Doppler に保管。

```text
DISCORD_BOT_TOKEN=MTAxOTU3MzcyNz...
```

> token は **画面遷移すると 2 度と見られない**。Doppler に投入してから次に進んでください。

### 2.1 Privileged Gateway Intents (必須)

Bot タブで以下を **必ず ON**:

- [x] **PRESENCE INTENT** (任意 — 顧客のプレゼンス検出が必要なら)
- [x] **SERVER MEMBERS INTENT** (member 列挙、operator allowlist 確認に必要)
- [x] **MESSAGE CONTENT INTENT** (自然文 intent classify に必須)

> MESSAGE CONTENT INTENT が OFF だと bot が DM の内容を読めず、自然言語ルートが完全に死にます。systemd で起動したのに DM に反応しない時は **真っ先にここを疑う**。

### 2.2 Public Bot を OFF にする

`Public Bot` チェックを **OFF**。1 顧客 1 bot なので他者を招待できないようにします。

## 3. OAuth2 設定

OAuth2 → **URL Generator**:

### scopes

- [x] `bot`
- [x] `applications.commands`

### Bot Permissions

| permission | 用途 |
| --- | --- |
| Send Messages | 通知 / 返信 |
| Embed Links | rich card |
| Attach Files | 画像投稿 (将来) |
| Read Message History | thread context |
| Use External Emojis | reaction emoji |
| Add Reactions | confirmation reaction |
| Manage Threads | thread lifecycle (auto-archive 復活) |
| Create Public Threads | [POST] / [RPLY] thread |
| Create Private Threads | escalation |
| Send Messages in Threads | thread 内発言 |
| Mention Everyone | (基本不要、顧客が要求した時のみ) |

権限 integer は 397821671232 が目安 (上記の組み合わせ)。

### invite URL

URL Generator が出した URL で **顧客の guild に招待**。

```text
https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=...&scope=bot+applications.commands
```

## 4. Guild ID を取得

顧客の Discord server で右クリック → **Copy Server ID** (Developer Mode が ON 必要)。

```text
DISCORD_GUILD_ID=98765432109876543
```

## 5. Channel 構成

bot を招待した後、guild 内に **顧客専用 channel** と **operator 通知用 channel** を作ります。

| channel 役割 | 名前 例 | 用途 |
| --- | --- | --- |
| customer | `#general` または `#mex-<id>` | 顧客への通知 / draft card |
| operator | `#mex-ops` | escalation / alert |
| onboarding | `#onboard` | 初回設定 thread |

各 channel ID を取得して account.json に登録します (bootstrap 内で誘導)。

## 6. operator user ID

operator (escalate 先 / allowlist) の Discord user ID を取得。

- 自分のアバターを右クリック → Copy User ID
- カンマ区切りで複数指定可: `123,456,789`

```text
OPERATOR_DISCORD_USER_IDS=123456789012345678,234567890123456789
```

## 7. token reset 手順

token が漏れた / リセットしたい時:

1. Discord Developer Portal → Application → Bot
2. **Reset Token** ボタン
3. 出てきた新 token を Doppler に投入 (旧 token は即時失効)
4. VPS で `sudo systemctl restart mex-bot` (Doppler から再 fetch)

> Doppler の token を更新したら **Doppler service token** ではなく **DISCORD_BOT_TOKEN secret value** を更新する点に注意。Doppler の service token を変える時は別手順 ([12-doppler-setup.md](./12-doppler-setup.md))。

## 8. 確認

```bash
# bot 起動後、Discord で
@mex-<id> 状態確認
# → bot が返事すれば成功
```

bot が反応しない時:

- MESSAGE CONTENT INTENT が ON か
- bot が guild に invite されているか
- DISCORD_BOT_TOKEN が Doppler の値と一致しているか
- `journalctl -u mex-bot` で error が出ていないか

詳細は [50-troubleshooting.md](./50-troubleshooting.md) 参照。

## 9. 関連 docs

- [10-install.md](./10-install.md)
- [12-doppler-setup.md](./12-doppler-setup.md)
- [50-troubleshooting.md](./50-troubleshooting.md)
