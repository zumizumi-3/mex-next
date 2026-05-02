## トラブルシューティング

> **対象読者**: 何か起きた時の operator
> **前提**: bot が立ち上がっている (or 立ち上がらない)
> **読了時間**: 必要なところだけ拾い読み

頻出問題と log の読み方をまとめました。

## 1. bot が起動しない

### 1.1 systemctl status で確認

```bash
sudo systemctl status mex-bot
sudo journalctl -u mex-bot -n 100 --no-pager
```

### 1.2 よくある原因

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `code=exited, status=1` | ExecStart の path 誤り | unit ファイル確認 |
| `Doppler: token expired` | service token 期限切れ | Doppler で再発行 |
| `EADDRINUSE :8080` | (該当しないはず、port は使わない) | 別プロセス kill |
| `EACCES /srv/mex/...` | account repo の chown ミス | `chown -R mex:mex /srv/mex/<id>-x-ops` |
| `Doppler not found` | install.sh 失敗 | `which doppler` 確認、再 install |

## 2. Discord に接続しない

```text
[error] WebSocket close code=4004 (Authentication failed)
```

DISCORD_BOT_TOKEN が無効。

```bash
# Doppler の値を確認 (head 5 文字だけ表示)
sudo -u mex doppler secrets get DISCORD_BOT_TOKEN --plain | head -c 5

# Discord Dev Portal で reset → Doppler に書き戻す → restart
```

```text
[error] Disallowed intents
```

Privileged Intents が OFF。Discord Dev Portal → Bot タブ → MESSAGE CONTENT INTENT を ON。

## 3. bot が DM に反応しない

### 3.1 MESSAGE CONTENT INTENT

Discord Dev Portal で ON か再確認。

### 3.2 message-handler のフィルタ

`shouldHandleMessage` で operator allowlist が効いていないか:

```bash
sudo journalctl -u mex-bot --since "10min ago" | grep -E "message_received|filtered"
```

`filtered: not_allowed` が出るなら OPERATOR_DISCORD_USER_IDS 設定漏れ。

### 3.3 thread の中

進行中の thread (onboarding / target setup / posting session) は専用 flow が処理を奪います。「DM に書く」or 「thread を抜ける」で解決。

## 4. 自然文が intent classify で `unknown` 連発

```bash
sudo journalctl -u mex-bot | grep "intent_classify" | tail -20
```

`fallback_reason: invalid_json` が連続:

- LLM が JSON 以外を返している
- prompt regression の可能性 → src/llm/prompts.ts を直近の変更で疑う
- claude-code CLI の subprocess エラーは stderr を確認

`fallback_reason: timeout`:

- Anthropic API の遅延
- intent_classify の timeout を [src/llm/kinds.ts](../../src/llm/kinds.ts) で調整

`fallback_reason: unsupported_intent`:

- LLM が架空の intent を出している
- prompt の許可 intent 列挙を更新

## 5. publish が失敗する

```bash
sudo journalctl -u mex-bot --since "1 hour ago" | grep -E "publish|x_api"
```

### 5.1 X API rate limit

```text
[error] X API 429 Too Many Requests
[info] reset at 2026-05-02T14:00:00Z
```

`mex-publish-<id>.timer` (5min interval) が次の reset 後に自動リトライ。3 回失敗で operator escalate。

### 5.2 tweet が長すぎる (length_fit failed)

5-axis judge で弾かれているはず。`awaiting_decision` に止まる。
顧客に修正してもらうか、operator が手動で短縮 → state を update。

### 5.3 X API access token 無効

```text
[error] X API 401 Unauthorized
```

token revoke / X 側のロックアウトの可能性。X Developer Portal で確認。

## 6. preflight 失敗

```text
[error] preflight gate 4: DISCORD_BOT_TOKEN missing or invalid
```

Doppler 確認 → reset → restart。

```text
[error] preflight gate 8: customer channel resolvable=false
```

account.json の `customer_channel_id` が間違っている。Discord で channel ID をコピー → account.json 更新 → bot restart。

## 7. self-update が失敗する

```bash
sudo journalctl -u mex-self-update.service -n 50
```

| エラー | 対処 |
| --- | --- |
| `dirty working tree` | `git -C /opt/mex-next status` で確認、operator が手で stash |
| `merge conflict` | git pull --ff-only が失敗、手で resolve |
| `npm ci failed` | node_modules 削除 → 再 install、Node version 確認 |
| `npm run build failed` | TypeScript error、git log で直近 commit を確認 |

## 8. account repo の整合がおかしい

```bash
sudo systemctl stop mex-bot
sudo -u mex git -C /srv/mex/zumi-x-x-ops log --oneline -20
sudo -u mex git -C /srv/mex/zumi-x-x-ops diff HEAD
```

state.json に明らかな破損があれば:

```bash
sudo -u mex git -C /srv/mex/zumi-x-x-ops checkout HEAD -- state.json
sudo systemctl start mex-bot
```

## 9. メモリリーク疑い

```bash
ps aux | grep "node.*mex-next"
# RES が日に日に増える場合
```

定期的な restart で対症療法 (週 1 で systemctl restart)。
根本対応は heap dump:

```bash
sudo -u mex node --inspect=0.0.0.0:9229 dist/main.js
# Chrome devtools から heap snapshot
```

## 10. log が肥大化

journalctl のディスク使用:

```bash
sudo journalctl --disk-usage
sudo journalctl --vacuum-size=500M
```

恒久的には `/etc/systemd/journald.conf` で `SystemMaxUse=2G` 等に制限。

## 11. log の読み方 (構造化 JSON)

pino 形式:

```json
{
  "level": "info",
  "time": 1730527200000,
  "kind": "post_v2_generate",
  "account_id": "zumi-x",
  "session_id": "s-7d2f",
  "duration_ms": 4321,
  "msg": "draft generated"
}
```

jq で絞り込み:

```bash
sudo journalctl -u mex-bot -o json | jq 'select(.kind | startswith("post_v2"))'
sudo journalctl -u mex-bot -o json | jq 'select(.level == "error")'
sudo journalctl -u mex-bot -o json | jq 'select(.account_id == "zumi-x" and .session_id == "s-7d2f")'
```

## 12. 顧客にいつ告知するか

| 状況 | 告知 |
| --- | --- |
| 5 分以内の bot restart | 不要 |
| 30 分以上の停止 | 顧客 channel に notice |
| 1 日以上の停止 | 顧客 channel + DM (経緯と再開予定) |
| state 破損 / publish 重複 | DM (謝罪 + 状況) |
| 移行 (Python → mex-next) | 事前 24h 以上 |

## 13. operator escalate しても返事が無い時

- escalate 通知の送信先 channel を確認
- bot の OPERATOR_DISCORD_USER_IDS が現在の operator と一致
- DM 通知が Discord 設定で blocked になっていないか

## 14. 関連 docs

- [20-runbook.md](./20-runbook.md)
- [21-monitoring.md](./21-monitoring.md)
- [../developer/00-architecture.md](../developer/00-architecture.md)
