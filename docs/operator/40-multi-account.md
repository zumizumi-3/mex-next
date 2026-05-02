## 1 VPS で複数 account を動かす

> **対象読者**: operator 自身など、限定的に複数 account を 1 VPS に同居させたい場合
> **前提**: 1 VPS = 1 account の標準を理解
> **読了時間**: 約 6 分

**標準は 1 VPS = 1 account = 1 Discord bot** です。multi-tenant にしないことで混線を避けるのが基本方針 (DESIGN.md §1.2)。

このページは「standard を理解した上であえて同居させたい」場合の手順です。

## 1. 同居が許される条件

operator (運用者) 自身の account は同居 OK:

- operator が技術判断できる
- 障害時の影響範囲を理解
- 顧客に影響しない

それ以外の組み合わせは原則 NG:

- 顧客 A と顧客 B を同居 → 片方の crash がもう片方に波及
- 顧客 と operator → 同上

## 2. 構成

```mermaid
flowchart TB
    V[VPS]
    V --> S1[mex-bot@zumi-x.service]
    V --> S2[mex-bot@operator.service]
    V --> T1[mex-daily-zumi-x.timer]
    V --> T2[mex-daily-operator.timer]
    S1 --> R1[/srv/mex/zumi-x-x-ops]
    S2 --> R2[/srv/mex/operator-x-ops]
    S1 --> D1[Doppler: mex-zumi-x]
    S2 --> D2[Doppler: mex-operator]
```

各 account に対して:

- 別の Discord Application (= 別 bot user)
- 別の Doppler project
- 別の X Developer App
- 別の account repo
- 別の systemd unit (template `mex-bot@<account>.service`)

## 3. systemd template unit

`/etc/systemd/system/mex-bot@.service`:

```ini
[Unit]
Description=MeX Next bot (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mex
Group=mex
WorkingDirectory=/opt/mex-next
EnvironmentFile=/etc/mex/%i.env
ExecStart=/usr/bin/doppler run --token-file /etc/mex/%i-token -- /usr/bin/node /opt/mex-next/dist/main.js --account-repo /srv/mex/%i-x-ops
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

`%i` が account-id に展開されます。

```bash
sudo systemctl enable mex-bot@zumi-x.service
sudo systemctl enable mex-bot@operator.service
sudo systemctl start mex-bot@zumi-x.service
sudo systemctl start mex-bot@operator.service
```

timer も同じパターン:

```bash
sudo systemctl enable mex-daily@zumi-x.timer
sudo systemctl enable mex-daily@operator.timer
```

## 4. 環境ファイルの分離

```bash
/etc/mex/zumi-x.env
  ACCOUNT_ID=zumi-x
  ACCOUNT_REPO=/srv/mex/zumi-x-x-ops

/etc/mex/zumi-x-token
  dp.st.prd.zumix...

/etc/mex/operator.env
  ACCOUNT_ID=operator
  ACCOUNT_REPO=/srv/mex/operator-x-ops

/etc/mex/operator-token
  dp.st.prd.operator...
```

権限:

```bash
sudo chown root:mex /etc/mex/*-token
sudo chmod 640 /etc/mex/*-token
```

## 5. resource 競合

CPU / RAM:

| 項目 | 1 account | 2 accounts | 5 accounts |
| --- | --- | --- | --- |
| RAM 平均 | 300MB | 600MB | 1.5GB |
| CPU 平均 | 1-3% | 2-6% | 5-15% |

VPS スペック目安:

- 2 accounts: 2 vCPU / 2GB RAM
- 5 accounts: 4 vCPU / 4GB RAM

X API tier:

- 各 account ごとに別の X Developer App + Basic tier
- 1 つの App に複数 account を載せるのは規約上 NG (各 account 別の OAuth)

## 6. log の分離

journalctl は unit 別:

```bash
sudo journalctl -u mex-bot@zumi-x.service -f
sudo journalctl -u mex-bot@operator.service -f
```

混じったログを見たい時:

```bash
sudo journalctl -u 'mex-bot@*' -f
```

## 7. self-update

`mex-self-update.timer` は VPS 全体で 1 つ走り、すべての account を一度に restart します。

```bash
[self-update] git pull
[self-update] npm ci
[self-update] npm run build
[self-update] systemctl restart 'mex-bot@*'
```

順次 restart にしたい場合は self-update の script を加工 (account-by-account loop)。

## 8. 同居の落とし穴

避けるべきパターン:

- 同じ Discord guild に複数 bot を入れる → 顧客が混乱
- 同じ Doppler service token を複数 account で共有 → 混線リスク
- 同じ /srv/mex/<id>-x-ops を 2 つの bot が見る → flock 競合
- 同じ X access token を 2 つの bot が使う → publish 重複

origin 1 つ・宛先 1 つを厳守。

## 9. 緊急時の停止

特定の 1 account だけ止めたい時:

```bash
sudo systemctl stop 'mex-bot@operator.service'
sudo systemctl stop 'mex-daily@operator.timer'
sudo systemctl stop 'mex-publish@operator.timer'
sudo systemctl stop 'mex-reactions-poll@operator.timer'
sudo systemctl stop 'mex-weekly-retro@operator.timer'
```

VPS 全停止:

```bash
sudo systemctl stop 'mex-bot@*'
sudo systemctl stop 'mex-*@*'
```

## 10. 推奨

迷ったら **顧客は VPS 別、operator 自分用は VPS 同居 (任意)** が無難。
顧客間の影響波及を防ぐ「物理 VM 単位の隔離」が結局一番楽です。

## 11. 関連 docs

- [00-overview.md](./00-overview.md)
- [10-install.md](./10-install.md)
- [20-runbook.md](./20-runbook.md)
