# Sub2API 自定义 Key 用量管理

部署在 NAS Docker 中的内部管理页。它使用一个 Sub2API 普通账号读取 Key 名称和用量，但只展示、刷新和重置你手动加入管理列表的自定义 Key。

## 功能

- 普通管理员密码默认 `111`：查看、刷新、调整单 Key 配额。
- 超级管理员密码默认 `superadmin`（`SUPERADMIN_PASSWORD`）：额外管理 Key 列表和月度总额度。
- 顶部“余额”是独立月度总额度减本月实际消费，首次为“未设置”。设定后立即计入当月已有消费，金额沿用到以后月份。
- 完整 Key 仅在添加时传给后端验证；磁盘只保存 SHA-256 哈希和脱敏值。
- 自动读取 Sub2API 中的真实 Key 名称、状态、累计额度和最后使用时间。
- 展示昨日、今日、本周、本月、上月的实际费用。
- 每周一 06:00（Asia/Shanghai）自动重置所有已配置自定义 Key 的累计额度和 5 小时/1 天/7 天限速窗口用量。
- 页面显示距离下次自动重置的实时倒计时，不提供手动重置按钮。
- 支持单独调整已配置 Key 的额度上限，并展示累计用量进度条。
- 从页面移除 Key 只影响本地管理列表，不会删除 Sub2API 中的 Key。

## 在其他电脑继续开发

```sh
git clone https://github.com/allin75/sub2api-key-manager.git
cd sub2api-key-manager
```

这是私有仓库，需要先登录有权限的 GitHub 账号。项目不包含生产环境的账号密码或 Key 数据。

使用 Node.js 22+（部署镜像使用 Node.js 24），无需安装第三方依赖。复制 `.env.example` 为 `.env` 并填写配置后，可以运行：

```sh
node --test
node --env-file=.env src/server.js
```

本机开发时在 `.env` 添加 `DATA_DIR=./data` 和 `PORT=3100`，然后访问 `http://localhost:3100`。本地数据与 NAS 数据独立。

修改完成后提交、推送代码；GitHub 推送不会自动部署 NAS。更新 NAS 时保留原 `.env` 和 Docker 数据卷，勿使用模板覆盖已有配置。

### 月度限额与调度

月度预算保存在本应用数据卷，使用 `actual_cost` 历史统计；单 Key 配额仍写入 Sub2API 的 `quota`。月度用量不会被周重置清零。金额以 USD 计，月周期固定北京时间，未用余额不结转。

达到月度总额度后，应用把已配置且启用的 Key 改为 `inactive`。每月 1 日 00:00 或提高总额度后余额大于零时，只恢复本应用因月度额度停用的 Key；原本禁用的 Key 不恢复。移除 Key 时保留当月消费快照及自动恢复记录，重加按同一个 Key 哈希计费，不重复累计。

| 北京时间 | 自动消费查询 |
| --- | --- |
| 周一至周五 08:00–18:30 | 每 5 分钟 |
| 其余 08:00–22:00 | 每 2 小时 |
| 白天已用达到 95% | 每 5 分钟 |
| 22:00–08:00 | 暂停 |

月初恢复、配置变更检查、状态变更失败重试和原有周一 06:00 重置不受夜间暂停限制。操作失败最快每 5 分钟重试；重启后继续，错过月初会补做。月度停用时跳过周重置，防止重新激活。

页面读取共享缓存，不直接访问上游；手动刷新全局最多 5 分钟一次，并合并并发刷新。消费查询、状态更新和周重置串行执行。错误保留旧数据并标记过期，不会当作零消费恢复 Key。夜间、低频间隔和上游统计延迟可能造成超额，这不是请求链路上的实时硬限额。

所有状态保存在 `/data/state.json`；首次从旧版本升级会生成 `/data/state.json.v2-backup`，保留 Key 和重置记录。备份/恢复时停止应用，完整保存该卷及 NAS `.env`，避免只恢复其中一部分。

### 接口

- `POST /api/login`、`GET /api/session` 返回 `role: admin | superadmin`。
- `GET /api/keys` 返回缓存的 `keys`、周重置 `schedule` 和月度 `budget`（limit、used、balance、overage、month、status、stale、error、lastSuccessAt、nextCheckAt、nextMonthAt）。
- `POST /api/refresh` 申请受全局节流约束的刷新；复用缓存时返回 `cached: true`。
- `PUT /api/budget`：超级管理员提交 `{ "limit": 1000 }`，必须为正数，最少 $0.01。
- `POST /api/keys` 和 `DELETE /api/keys/:id`：仅超级管理员可用。
- `PUT /api/keys/:id`：调整单 Key 配额；月度停用/恢复尚未完成时返回 409。

所有写接口保留会话与 CSRF 校验。月度设置保存后同步失败时返回已保存设置和过期标记，后端继续按调度重试。

## NAS Docker 部署步骤

1. 将整个 `sub2api-key-manager` 文件夹上传到 NAS。
2. 在该目录复制环境变量模板：

   ```sh
   cp .env.example .env
   ```

3. 编辑 `.env`，至少填写：

   ```env
   ADMIN_PASSWORD=111
   SUPERADMIN_PASSWORD=superadmin
   SUB2API_BASE_URL=https://sub2api.yfyf.fun
   SUB2API_EMAIL=你的普通账号邮箱
   SUB2API_PASSWORD=你的普通账号密码
   ```

4. 构建并启动：

   ```sh
   docker compose up -d --build
   ```

5. 浏览器访问：

   ```text
   http://NAS地址:3100
   ```

6. 查看运行状态：

   ```sh
   docker compose ps
   docker compose logs --tail=100 key-manager
   ```

## HTTPS 反向代理

如果通过群晖、威联通、Nginx Proxy Manager 或 Caddy 提供 HTTPS，请将 `.env` 中的 `COOKIE_SECURE` 改为 `true`，然后执行：

```sh
docker compose up -d
```

反向代理目标为 `http://NAS地址:3100`。不要将 3100 端口直接暴露到公网。

## 数据与安全

- 持久化文件位于 Docker 命名卷 `sub2api-key-manager_key-manager-data` 中，包含自定义 Key 哈希、脱敏值和最后重置时间，不包含完整 Key。
- Sub2API 邮箱和密码位于 `.env`。限制该文件的读取权限，并不要把它提交到 Git。
- 默认密码 `111` 仅用于首次部署。正式使用前应修改 `ADMIN_PASSWORD` 并重启容器。
- 管理会话在容器内存中保存 12 小时；容器重启后需要重新登录。
- 当前自动登录不支持启用了二步验证的 Sub2API 账号。

## “重置”的准确含义

应用会对每个已配置自定义 Key 调用：

```http
PUT /api/v1/keys/{id}

{
  "reset_quota": true,
  "reset_rate_limit_usage": true
}
```

它会重置 Key 的累计已用额度以及限速窗口用量，但不会删除 Sub2API 中已有的历史用量日志，因此昨日、本月等历史统计仍会保留。

## 更新

```sh
docker compose up -d --build
```
