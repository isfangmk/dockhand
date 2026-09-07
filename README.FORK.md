# 本仓库相对上游的改动

本 fork 在上游 [Dockhand](https://dockhand.pro) 开源版本之上增加了以下能力（对应近期提交）。上游说明见 [`README.md`](./README.md)。

## SSH Docker 主机环境

- 支持通过 **SSH（密码 / 私钥）** 连接远程 Docker 主机
- 将远端 `docker.sock` 隧道转发到本地，复用现有 Docker API 调用路径
- 远程 Compose 通过 **SFTP + 远端执行** 完成
- 环境配置、连通性测试、凭证脱敏与相关数据库迁移一并补齐

## Workspace（容器工作区）

- 新增侧边栏入口 **Workspace**（`/workspace`），按容器集中管理日常操作
- 标签页：**Overview**（指标 / 启停重启）、**Files**、**Terminal**、**Logs**
- **Files**：在线浏览与编辑；右侧 **Changes & History**（修改与历史）支持 zip 归档上传覆盖、变更文件列表、修订历史（变更前快照）、与容器 Latest 的侧栏 diff，以及删除单条或某文件全部修订
- **Terminal**：首次打开后保持会话；切换标签仅隐藏，再次显示时 `fit` / `focus`
- 修订时间按设置中的默认时区与日期时间格式展示

## 下载与非 ASCII 文件名

- 修复中文等非 ASCII 文件名下载失败：`Content-Disposition` 的 `filename=` 仅保留 ASCII，真实文件名放在 `filename*=UTF-8''...`
