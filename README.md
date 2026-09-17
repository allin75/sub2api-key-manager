# Sub2API 自定义 Key 用量管理

部署在 NAS Docker 中的内部管理页。它使用一个 Sub2API 普通账号读取 Key 名称和用量，但只展示、刷新和重置你手动加入管理列表的自定义 Key。

## 功能

- 管理密码登录，默认密码为 `111`。
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

### 待继续确认的需求

用户反馈额度应该由自己设置。目前“调整配额”会写入 Sub2API 的 `quota`，进度使用 `quota_used / quota`。是否改为本应用独立保存额度上限，尚未确认和实现。

## NAS Docker 部署步骤

1. 将整个 `sub2api-key-manager` 文件夹上传到 NAS。
2. 在该目录复制环境变量模板：

   ```sh
   cp .env.example .env
   ```

3. 编辑 `.env`，至少填写：

   ```env
   ADMIN_PASSWORD=111
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
docker compose down
docker compose up -d --build
```
