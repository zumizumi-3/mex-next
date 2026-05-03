## multi-account hosting

> **対象読者**: 複数 customer を持つ operator
> **前提**: 標準の 1 customer = 1 VPS 構成を理解している
> **読了時間**: 約 7 分

推奨は **1 customer = 1 VPS = 1 Discord bot = 1 account repo** です。障害範囲、journal、Doppler token、systemd 操作が分かれ、customer に説明しやすいからです。

## 1. 推奨配置

```text
customer-a VPS
├── mex-bot.service
├── mex-publish-customer-a.timer
├── mex-daily-customer-a.timer
└── /srv/mex-next/customer-a-x-ops

customer-b VPS
├── mex-bot.service
├── mex-publish-customer-b.timer
├── mex-daily-customer-b.timer
└── /srv/mex-next/customer-b-x-ops
```

この構成では `/etc/mex/<account>.env`、Doppler project、GitHub repo、Discord Application がすべて 1:1 になります。

## 2. 1 VPS に複数 account を置く場合

限定的に 1 VPS へ同居させる場合は、account ごとに systemd unit を分けます。1 つの process に複数 customer を載せる multi-tenant 化はしません。

```text
/srv/mex-next/
├── tanaka-x-ops
└── suzuki-x-ops

/etc/mex/
├── tanaka-x.env
└── suzuki-x.env

/etc/systemd/system/
├── mex-bot-tanaka-x.service
├── mex-bot-suzuki-x.service
├── mex-publish-tanaka-x.service
├── mex-publish-tanaka-x.timer
├── mex-daily-tanaka-x.timer
└── mex-daily-suzuki-x.timer
```

同居時の最低条件:

- Discord Application は account ごとに分ける
- Doppler project は `xops-<account>` で分ける
- account repo は customer GitHub に置く
- service / timer 名に account id を必ず入れる
- `journalctl` を unit 単位で見る

timer で起動する one-shot service は `scripts/install-systemd-units.sh <ACCOUNT_ID>` で生成する。unit 名は `mex-{name}-{ACCOUNT_ID}.service` / `.timer` に統一され、suffix なしの legacy unit は disable/remove される。

```bash
cd /opt/mex-next
sudo bash scripts/install-systemd-units.sh tanaka-x
sudo bash scripts/install-systemd-units.sh suzuki-x
```

配置前に見るだけなら:

```bash
bash scripts/install-systemd-units.sh tanaka-x --dry-run
```

## 3. accounts-registry.json

registry は bot 起動や operator tooling が account metadata を引くための索引です。正本は account repo であり、registry は所有権の根拠ではありません。

```json
{
  "accounts": {
    "tanaka-x": {
      "account_id": "tanaka-x",
      "account_repo": "/srv/mex-next/tanaka-x-ops",
      "discord": {
        "application_id": "1234567890",
        "guild_id": "2345678901",
        "channels": {
          "customer_main": "3456789012",
          "customer_attention": "3456789012",
          "customer_passive": "3456789012",
          "operator_alert": "4567890123"
        },
        "operator_user_ids": ["5678901234"]
      }
    }
  }
}
```

場所:

```bash
/var/lib/mex-next/accounts-registry.json
```

権限は `0600` を推奨します。Discord channel id は secret ではありませんが、顧客情報に紐づく metadata なので公開 repo に置きません。

## 4. logs / journal の見方

1 VPS 1 customer:

```bash
sudo journalctl -u mex-bot.service -f
sudo journalctl -u mex-daily-tanaka-x.timer -n 100 --no-pager
sudo journalctl -u mex-proactive-nudge-weekly-tanaka-x.service -n 100 --no-pager
```

1 VPS 複数 customer:

```bash
sudo journalctl -u mex-bot-tanaka-x.service -f
sudo journalctl -u mex-bot-suzuki-x.service -f
sudo journalctl --since "1 hour ago" -u 'mex-*-tanaka-x.*'
```

systemd unit 名に account id を入れておくと、customer 単位の切り分けができます。共通の `mex-bot.service` を複数 account で使い回すと journal が混ざるため避けます。

## 5. symlink / legacy unit 管理

suffix 統一後は `/etc/systemd/system/multi-user.target.wants/` などの symlink も account id 付き timer を指す。手動で symlink を作らず、必ず `systemctl enable --now mex-<name>-<account>.timer` または `install-systemd-units.sh` に任せる。

確認:

```bash
systemctl list-unit-files 'mex-*-tanaka-x.*'
find /etc/systemd/system -lname '*mex-*' -maxdepth 2 -print
```

suffix なしの `mex-daily.timer` / `mex-publish.timer` が残っていたら disable/remove する。`install-systemd-units.sh` は dry-run でも削除予定の legacy unit を表示する。

## 6. 運用判断

customer をホストするなら 1 customer 1 VPS を標準にします。同居は operator 自身の account、検証環境、低リスクな小規模運用に限定します。

同居から分離する時は account repo を新 VPS へ clone し、Doppler service token と Discord bot token を rotation してから旧 unit を停止します。
