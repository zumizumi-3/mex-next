## 日常運用 Runbook

> **対象読者**: 立ち上げ済みの bot を回す operator
> **前提**: bootstrap 完了、bot が緑のステータス
> **読了時間**: 約 8 分

毎日触るのは status / journalctl / restart の 3 つだけです。

## 1. 朝の確認 (5 分)

```bash
# 1. service 群の状態
sudo systemctl status mex-bot mex-self-update.timer \
  mex-daily-zumi-x.timer mex-publish-zumi-x.timer \
  mex-reactions-poll-zumi-x.timer mex-weekly-retro-zumi-x.timer

# 2. bot のログ末尾
sudo journalctl -u mex-bot -n 100 --no-pager

# 3. 直近の publish が成功しているか
sudo journalctl -u mex-bot --since "06:00 today" | grep -E "publish|failed"
```

正常時の状態:

```text
mex-bot.service: active (running)
mex-self-update.timer: active (waiting), Trigger: 30min
mex-daily-zumi-x.timer: active (waiting), Trigger: tomorrow 07:00
mex-publish-zumi-x.timer: active (waiting), Trigger: 5min
mex-reactions-poll-zumi-x.timer: active (waiting), Trigger: 30min
mex-weekly-retro-zumi-x.timer: active (waiting), Trigger: next Monday 07:00
```

## 2. status コマンド (内蔵)

```bash
sudo -u mex node /opt/mex-next/dist/scripts/status.js \
  --account-repo /srv/mex/zumi-x-x-ops
```

出力例:

```text
=== mex-next status ===
account: zumi-x
repo:    /srv/mex/zumi-x-x-ops
state:   2026-05-02T07:30:00+09:00 (last_update)

cadence:        light
skip_today:     false
hot_zones:      06:00-09:00

posting_sessions:
  active: 1 (s-7d2f, awaiting_decision)
  scheduled: 1 (s-3a91, publish at 12:18)
  published_today: 0

publish_queue:    1 item
interaction_queue: 0 items
inbound_reactions: 3 unread

x_api_rate_limit:
  POST: 12/3000 month
  GET:  234/10000 month

last_retrospective:
  daily:   2026-05-01
  weekly:  2026-04-28
  monthly: 2026-05-01
```

## 3. ログ tail

```bash
# bot 全体
sudo journalctl -u mex-bot -f

# 特定 timer
sudo journalctl -u mex-daily-zumi-x.timer -n 50

# 特定 kind だけ (jq で構造化 log を絞る)
sudo journalctl -u mex-bot -o json | jq 'select(.kind == "post_v2_generate")'

# error 以上
sudo journalctl -u mex-bot -p err
```

log は pino の構造化 JSON。`level` / `kind` / `account_id` / `session_id` で grep / jq できます。

## 4. bot の手動 restart

設定変更後 / token rotation 後など:

```bash
sudo systemctl restart mex-bot
sudo journalctl -u mex-bot -n 50 --no-pager
```

restart で失われるもの:

- conversation locks (in-memory) → 顧客が次に話しかけた時に自然に解消
- pending turn store (in-memory) → 顧客が next message 送れば再構築
- progress indicator (in-memory) → 進行中の draft は state.json から再読込

state.json / account.json のデータは保たれるので問題ありません。

## 5. self-update を強制実行

`mex-self-update.timer` を待たずに今すぐ pull:

```bash
sudo systemctl start mex-self-update.service
sudo journalctl -u mex-self-update.service -n 30
```

期待 log:

```text
[self-update] git fetch origin
[self-update] HEAD: abc1234
[self-update] origin/main: def5678
[self-update] git pull --ff-only
[self-update] npm ci
[self-update] npm run build
[self-update] systemctl restart mex-bot
```

`HEAD == origin/main` の場合は no-op で終わります。

## 6. ref pin 切替

特定 account だけ別 ref で動かしたい (canary deploy):

```bash
sudo -u mex jq '.accounts["zumi-x"] = "feature-branch"' \
  /opt/mex-next/deploy/mex-core-desired.json > /tmp/desired.json
sudo mv /tmp/desired.json /opt/mex-next/deploy/mex-core-desired.json
sudo systemctl restart mex-self-update.service
```

`mex-core-desired.json` の例:

```json
{
  "accounts": {
    "zumi-x": "main",
    "tanaka-x": "main"
  },
  "default": "main"
}
```

## 7. 顧客 channel への手動メッセージ

緊急通知を operator から顧客に流したい時。bot 経由ではなく Discord 上で直接 operator アカウントから書く方が普通だが、bot 名義で出したい場合:

```bash
sudo -u mex node /opt/mex-next/dist/scripts/notify.js \
  --account-repo /srv/mex/zumi-x-x-ops \
  --channel customer \
  --text "メンテナンスのため 15 分ほど bot を停止します"
```

## 8. account repo の手動操作

operator が account repo に直接 commit するのは緊急時のみ。

```bash
sudo -u mex git -C /srv/mex/zumi-x-x-ops status
sudo -u mex git -C /srv/mex/zumi-x-x-ops log --oneline -20

# state.json を直に直す場合
sudo systemctl stop mex-bot
sudo -u mex vim /srv/mex/zumi-x-x-ops/state.json
sudo -u mex git -C /srv/mex/zumi-x-x-ops add state.json
sudo -u mex git -C /srv/mex/zumi-x-x-ops commit -m "ops: manual state fix (reason: xxx)"
sudo -u mex git -C /srv/mex/zumi-x-x-ops push
sudo systemctl start mex-bot
```

> **注意**: bot 起動中の手動 state 編集は flock 競合で書き戻される可能性が高い。必ず stop → edit → start。

## 9. weekly チェック

週 1 で見るもの:

```bash
# disk
df -h /srv/mex
du -sh /srv/mex/zumi-x-x-ops

# memory
free -h
ps aux | grep node | grep mex-next

# X API quota
sudo journalctl -u mex-bot --since "1 week ago" | grep "x_api_rate_limit"
```

数値の閾値は [21-monitoring.md](./21-monitoring.md) を参照。

## 10. 月次の整備

月 1 で:

- account repo の `content/` フォルダ size 確認 (古い content の archive)
- Doppler service token の expire 日確認
- X API tier 使用率の振り返り
- self-update timer が正常に走っているか journalctl で確認

## 11. VPS 復旧

bot が乗っていた VPS が飛んだ / 引っ越し時:

```bash
ssh root@<NEW_VPS>
curl -fsSL https://raw.githubusercontent.com/zumizumi-3/mex-next/main/scripts/install.sh | bash
bash /opt/mex-next/scripts/recover.sh <account-id> <github-owner>/<repo-name>
```

入力するもの:

- Doppler service token
- Discord channel ID
- operator user IDs

GitHub 上の account_repo に auto push された `state.json` / `account.json` から復旧します。

## 12. GitHub Actions cron (B2)

retro / アンケート系は VPS の systemd timer **と並列で** GitHub Actions からも trigger されます。VPS 側 timer が落ちても、account repo 側の Actions から bot webhook を叩きます。

設定 (一度だけ):

1. account_repo の Settings > Secrets and variables > Actions
2. Secrets:
   - `MEX_BOT_URL`: `https://your-bot.example.com` (or `http://<vps_ip>:8787`)
   - `MEX_BOT_WEBHOOK_TOKEN`: 32 文字以上のランダム秘密 (operator が決める)
3. Variables:
   - `MEX_ACCOUNT_ID`: account-id (例: `zumi-x`)
4. `/etc/mex/<account>.env` にも `CRON_WEBHOOK_SECRET=<同じ token>` を追記
5. `mex-bot.service` を restart して webhook server を起動

確認:

```bash
curl http://<vps>:8787/health
```

`200 OK` が返れば server は起動済みです。Actions タブから `weekly-retro` / `monthly-retro` / `phase-questionnaire` を手動 dispatch して動作確認します。

webhook に失敗した場合、Actions は warning を出し、`retros/` に `*-webhook-failed.md` を commit します。bot 側の `CRON_WEBHOOK_SECRET` と GitHub 側 `MEX_BOT_WEBHOOK_TOKEN` が一致しているか、`MEX_BOT_URL` が runner から到達可能かを確認してください。

## 13. 関連 docs

- [21-monitoring.md](./21-monitoring.md)
- [50-troubleshooting.md](./50-troubleshooting.md)
- [30-migration-from-python.md](./30-migration-from-python.md)
