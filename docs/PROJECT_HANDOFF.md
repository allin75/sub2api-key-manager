# 项目交接记录

最后核对：2026-09-29。给另一台电脑和接手的 AI 快速了解当前状态；具体代码变更以 Git 历史为准，发布内容见 `CHANGELOG.md`。

## 当前状态

| 项目 | 状态 |
| --- | --- |
| 源码 | 私有仓库 `allin75/sub2api-key-manager`，以 `origin/main` 为同步源。两台电脑应各自克隆或拉取，不复制工作目录。 |
| 最近功能版本 | `v1.1.0`，提交 `7f13ec7`。包含七天用量预览、10% 月度余额自动提醒、可关闭且三天过期的额度规则公告。 |
| NAS | 2026-09-29 已通过 SSH 部署 `7f13ec7`；`/home/Sun/sub2api-key-manager/.release-commit` 为部署版本标记，容器 `sub2api-key-manager` 当时为 `healthy`。 |
| 回退资料 | 部署前备份在 `/home/Sun/sub2api-key-manager-backups/20260929-120453`；上传归档与部署日志在 `/home/Sun/sub2api-key-manager-releases/7f13ec7`。 |
| 验证 | `node --test` 55 项通过；桌面与手机宽度已检查。 |
| 待办 | 当前没有已确认但未完成的开发任务。收到新需求后先检查 Git 和 NAS 实际状态，再更新本表。 |

这份文档是时间点记录。文档提交推送后，`main` 的提交会比 NAS 部署标记更新，但这次文档修改不需要重建容器。

## 已完成记录

- 2026-09-17 至 09-20：建立 NAS 上的 Sub2API Key 管理服务；完成月度预算、独立登录密钥、体验额度、奖励、刷新开关与排序。对应提交从 `8171d41` 到 `f967c28`。
- 2026-09-28：加入最近七天用量预览，提交 `db12e63`。
- 2026-09-29：修复预览定位、连接和快速切换动画；加入手机端每日金额、月度余额 10% 自动提醒、可关闭的额度规则公告。发布 `v1.1.0`，并部署到 NAS。详见 `CHANGELOG.md`。
- 2026-09-29：建立本交接记录与跨电脑接手流程。此项仅改文档，不改变 NAS 运行代码。

## 两台电脑接手流程

1. 开始前阅读本文件、`AGENTS.md` 和 `README.md`；执行 `git fetch origin`、`git status -sb`。工作区干净时用 `git pull --ff-only` 对齐 `origin/main`。如有本地改动，先保留并查明归属，不覆盖或强推。
2. 以 GitHub 的 `main` 作为源码同步点。两台电脑不要同时直接改同一处；需要并行时各开分支，合并后另一台再拉取。
3. 完成工作后运行相关测试，更新本文件的当前状态、已完成记录和明确的下一步；用户可见的版本变化再更新 `CHANGELOG.md`。将代码与记录一起提交并推送，确认远端提交与本地一致。
4. GitHub 推送不会自动更新 NAS。只有完成实际部署并验证容器健康后，才更新上表中的 NAS 提交与备份路径。

## NAS 与本机配置

- 只通过 SSH 更新 NAS：优先尝试 `Sun@192.168.6.20:22`，本地不可达时尝试 `Sun@fn1501.1501129.xyz:22`。2026-09-29 本机局域网地址直接断开；域名 SSH 可用，强制 IPv6 解析未成功。另一台电脑需自行配置 SSH 密钥和可信主机记录，私钥不进仓库。
- NAS 项目目录为 `/home/Sun/sub2api-key-manager`，Compose 文件为 `compose.yaml`，数据卷为 `sub2api-key-manager_key-manager-data`。发布归档和备份分别在同级的 `sub2api-key-manager-releases`、`sub2api-key-manager-backups` 目录。
- 更新前确认 `.env` 和数据卷存在并备份；更新后核对 `.release-commit`、`docker compose ps`、健康状态和页面响应。不要运行 `docker compose down -v`。仓库里的通用 Android `release` 技能不适用于本项目的 NAS 部署。
- `.env`、`/data`、NAS 备份及 SSH 私钥不随 GitHub 同步。业务状态保存在 NAS Docker 数据卷中；额度规则公告的浏览器查看状态和低余额提醒去重使用各浏览器的 `localStorage`，因此两台电脑的这两项显示状态可能不同。
