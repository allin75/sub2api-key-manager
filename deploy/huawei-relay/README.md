# 华为云备用访问入口

当前 IP 访问地址：<https://1.94.7.137:9001/>。原备用域名 <https://key-direct.1501129.xyz/> 的配置保留，用户反馈其需要备案。原入口 <https://misekey.1501129.xyz/> 继续使用；两者连接同一个 NAS 程序和同一份业务数据。各入口使用各自的浏览器会话，登录密钥相同。

## 连接与配置位置

```text
浏览器 → 华为云 Caddy HTTPS :9001 → 127.0.0.1:13100
                              ↑ SSH 反向隧道，经 :22
                         NAS 127.0.0.1:3100
```

| 组件 | 配置位置 |
| --- | --- |
| Cloudflare DNS | `key-direct`，A → `1.94.7.137`，仅 DNS，无 AAAA |
| 华为云入口 | `/etc/caddy/Caddyfile`，`caddy.service` |
| 云端隧道账号 | `key-manager-tunnel`，无交互会话，仅允许反向转发到 `127.0.0.1:13100` |
| 云端 SSH 限制 | `/etc/ssh/sshd_config.d/60-key-manager-tunnel.conf` |
| 云端配置备份 | `/opt/sub2api-key-manager-relay/backup-20261016/` |
| NAS 独立项目 | `/vol1/1000/sub2api-key-manager-relay/`，Compose 项目 `sub2api-key-manager-relay` |
| NAS 容器 | `sub2api-key-manager-ssh-relay`，`unless-stopped` 自动重启 |
| NAS 密钥及基线 | `/home/Sun/.config/sub2api-key-manager-relay/`，目录 0700，私钥 0600，不进 Git |
| NAS 镜像 | `sub2api-key-manager-ssh-relay:20261016`，Alpine 3.22.6 + OpenSSH 客户端 |

云端新增公开网页端口 TCP 9001，已有 TCP 80/443 保留；隧道复用 TCP 22，回源端口 13100 仅监听云端回环地址。NAS 容器以 1000:1001 身份运行、只读文件系统、移除全部 capabilities、禁止提权。云端 SSH 主机公钥经已有可信 SSH 连接读取后固定，客户端禁止自动接受未知主机公钥。私钥只在 NAS 上生成及保存。

## 更新配置

NAS 使用本目录 `nas/` 中的文件；在项目目录执行：

```sh
docker compose -p sub2api-key-manager-relay config --quiet
docker compose -p sub2api-key-manager-relay up -d --no-deps --build tunnel
docker compose -p sub2api-key-manager-relay logs --tail=30 tunnel
```

镜像默认从 `alpine:3.22` 构建。此次 NAS 访问 Docker Hub 超时，因此通过 Alpine 官方 HTTPS 下载 minirootfs、验证官方公布的 SHA-256 后导入本地基础镜像；项目 `.env` 仅指定 `RELAY_BASE_IMAGE=sub2api-key-manager-alpine:3.22.6`。可按以下命令重建该基础镜像：

```sh
curl -fLO https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-minirootfs-3.22.6-x86_64.tar.gz
echo '27694aaa55fd7a9e3ef596e0ad4eb66802308bb20172b17030cd5f4d8ae9bac2  alpine-minirootfs-3.22.6-x86_64.tar.gz' | sha256sum -c -
docker import alpine-minirootfs-3.22.6-x86_64.tar.gz sub2api-key-manager-alpine:3.22.6
```

云端使用 `cloud/` 中的配置文件。修改前备份对应文件；Caddy 使用 Ubuntu 官方软件源安装，配置验证通过后 reload：

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
/usr/sbin/sshd -t
systemctl reload ssh
```

SSH 账号的 `authorized_keys` 使用 `restrict,port-forwarding,permitlisten="127.0.0.1:13100",command="/bin/false"` 限制专用公钥。`sshd` 的 Match 配置禁止本地转发及交互会话，只允许指定回环监听；不要复用 NAS 管理员或云端 root 私钥。

域名证书由 Caddy 自动申请及续期，状态保存在 `/var/lib/caddy/`，不要删除该目录。DNS 必须继续直连云端，已有的 TCP 80/443 入站规则必须保留。服务器位于大陆，后续仍应按供应商要求维护域名接入条件。

## IP HTTPS 入口（2026-10-26 核验）

华为云账号为 `GT-sunjun001229`，Flexus L 实例 `Ubuntu-cn-east-3-G69S` 位于华东-上海一，公网 IP 为 `1.94.7.137`。安全组 `sg-default-smb`（`004166ab-b2b1-4cb9-80cc-9e485933595d`）已于 2026-10-26 09:37:53 新增：优先级 1 / 允许 / IPv4 / TCP 9001 / 源 `0.0.0.0/0` / 描述 `Key Manager IP HTTPS 9001`。其他规则保持原样。

云端 `/etc/caddy/Caddyfile` 已有 IP HTTPS 站点，将 `https://1.94.7.137:9001` 反向代理到 `127.0.0.1:13100`，并向 NAS 传递原始 Host 和 HTTPS 协议。全局 `default_sni 1.94.7.137` 用于 IP TLS。仓库 `cloud/Caddyfile` 仍是早期域名配置示例，不能直接覆盖当前云端配置。

IP 证书由 Let's Encrypt 短期证书配置签发，SAN 包含 `1.94.7.137`，由 `/opt/key-ip-acme/bin/certbot` 管理，续期配置位于 `/etc/letsencrypt/renewal/key-ip-1.94.7.137.conf`。Caddy 使用 `/etc/caddy/key-ip-tls/fullchain.pem` 和 `privkey.pem`，权限 root:caddy 0640。`key-ip-cert-renew.timer` 已启用，每日 00:00/12:00 加最长 1800 秒随机延迟检查续期；部署钩子为 `/etc/letsencrypt/renewal-hooks/deploy/key-ip-caddy`。不要删除证书配置、私钥或定时任务，不要将其提交到 Git。

HTTP 80 的 `/.well-known/acme-challenge/` 由 `/var/www/key-ip-acme` 提供，用于 http-01 续期；其余 IP HTTP 请求跳转至 HTTPS 9001。保留该验证路径和 TCP 80 入站规则。

此次仅放行安全组端口，未重新配置 Caddy、证书或 NAS。公网检查：主页 200（本机一次 0.72 秒）、app.js 200、未登录 `/api/session` 401，均未跳过证书验证；Chrome 正常显示登录页。NAS 程序为 1.5.0、running / healthy，专用隧道容器 running。登录密钥与原入口相同，各入口需分别登录。单次请求耗时不代表整页加载速度或其他网络的表现；IP 加端口不保证免除供应商接入或备案要求。

只读排障命令：

```sh
systemctl status key-ip-cert-renew.timer --no-pager
systemctl status key-ip-cert-renew.service --no-pager
curl --connect-timeout 5 --max-time 10 --resolve 1.94.7.137:9001:127.0.0.1 -fsS -o /dev/null https://1.94.7.137:9001/
```

公网测试时去掉 `--resolve`。停用此 IP 入口时，可先撤销安全组中上述 TCP 9001 规则；原 CF 入口仍可访问。

## 核验与排障

云端：

```sh
systemctl is-enabled caddy
systemctl is-active caddy
ss -lnt
curl -fsS -o /dev/null http://127.0.0.1:13100/
curl -fsS -o /dev/null https://key-direct.1501129.xyz/
journalctl -u caddy --no-pager -n 30
```

NAS 上检查专用容器日志和 `http://127.0.0.1:3100/`。遇到 502 时先检查隧道及 NAS 程序；证书问题检查 DNS、80/443 和 Caddy 日志，不跳过证书验证。不要为了修复访问入口重新初始化业务数据。

2026-10-16 验证：新入口证书可信、HTTP 自动跳转 HTTPS；页面和四个静态资源与 NAS 逐字节一致；未登录接口 401；有效登录、读取会话及退出成功；缺失 CSRF、异站 Origin 和伪造 X-Forwarded-Host 返回 403。受限账号无法转发其他端口或执行命令。让专用 SSH 进程退出后，容器自动重启、隧道及 HTTPS 恢复。Caddy 开机启动及容器重启策略已配置，未重启两台主机。

本机当前网络交替测试首页 5 轮：华为云入口总耗时 0.16–0.26 秒，CF 入口 1.80–1.92 秒；这是 HTML 请求耗时，不是整页加载或所有网络环境的保证。云套餐为 2 Mbit/s、100 GB 流量包。验证过程不修改 Key、额度或公告，不强制同步上游；原有 15 个容器的 ID、启动时间和重启次数保持不变，应用仍运行 `1.3.4` / `5dd98e7`。

## 回退

停止 NAS 专用通道即可停用新入口，不影响原 CF 入口：

```sh
docker compose -p sub2api-key-manager-relay stop tunnel
```

完全撤销时，恢复云端备份的 Caddyfile 并验证后 reload，移除本次新增的 SSH Match 配置及专用公钥，验证 SSH 配置后 reload，再删除新增的 `key-direct` DNS 记录。保留备份、证书及业务数据；不要改现有 CF Tunnel 或对业务项目执行 `down -v`。
