# pi-codex

[English](README.md) | 简体中文

在 Codex 桌面界面中使用 Pi coding agent harness。

Pi 仍负责运行 agent，包括模型 Provider、agent loop、上下文与压缩、工具、扩展、skills、MCP server、subagents，以及原生 session 文件。Codex App 提供桌面界面，包括项目、会话历史、流式回复、工具卡片、模型控制和输入框。

```text
Codex 桌面应用
        ↕ app-server JSON-RPC
     pi-codex
        ↕ Pi SDK
 Pi AgentSession
        ↕
模型 · 工具 · 扩展 · skills · MCP · subagents
```

如果你希望保留 Pi 小巧、可修改的 harness 和扩展生态，同时使用完整的桌面 UI，这种拆分方式会比较合适。Bridge 使用普通 JavaScript 编写，因此无需 fork Pi 或 Codex App，也可以自行修改协议映射和 agent 行为。

## 保留的 Pi 能力

- Pi 原生 `AgentSession` 和 JSONL 会话历史
- 现有 Provider 和模型配置
- 内置工具与扩展工具
- 用户级和项目级扩展
- Skills、prompt templates、MCP server 和 subagents
- Pi 的上下文管理与压缩
- 项目级 `.pi` 配置和信任规则

现有 Pi session 会按项目列出，并直接从原文件打开，不会导入到另一套会话格式中。

## Codex UI 提供的能力

- 项目与会话导航
- 文本与 reasoning 流式输出
- 原生命令卡片和通用工具卡片
- 模型与 reasoning effort 控制
- Stop、steer、compact、fork、archive 和历史记录
- 将 Pi 扩展交互映射为桌面对话框
- 通过 Codex host picker 进行可选的 SSH host 路由

## 安装

### 环境要求

- macOS
- Node.js 22.19 或更高版本
- npm 版本的 `@earendil-works/pi-coding-agent`
- 已安装官方 `ChatGPT.app` 或 `Codex.app`

本仓库不包含或分发 Codex 桌面运行时。安装脚本会使用 Mac 上已有的官方应用。

### 安装 release

```bash
curl -fsSL https://raw.githubusercontent.com/OnePerson2020/pi-codex/main/install.sh | sh
open -n "/Applications/pi-codex.app"
```

引导脚本会下载[最新 release](https://github.com/OnePerson2020/pi-codex/releases/latest) 并以 `standalone` 模式安装。改用 `| sh -s -- --mode shared` 可复用已安装的运行时；设置 `PI_CODEX_TAG=v0.1.0` 可固定版本。

### 从 DMG 安装

从同一个 release 下载 `.dmg`，打开后右键 `Install pi-codex.command` → 打开。该镜像未做公证，因此首次打开需要这一步确认。安装器会询问运行时模式，把 `pi-codex.app` 装到 `/Applications`，并清除安装产物的下载隔离标记。可在源码目录用 `./scripts/package-mac-dmg.sh` 重新构建镜像。

### 从源码安装

```bash
git clone https://github.com/OnePerson2020/pi-codex.git
cd pi-codex
npm test
./install-mac-app --mode standalone
open -n "/Applications/pi-codex.app"
```

`standalone` 会把已安装的桌面运行时复制到应用私有目录，并关闭该副本的自动更新。原始应用不会被修改。本地调试时，可以使用 `--mode shared` 直接复用已安装的运行时。

Pi 资源仍从原有 agent 目录加载，通常是 `~/.pi/agent`。无需重新安装扩展或 skills。

## Linux 执行主机

远程项目运行在 Linux 机器上，该机器拥有自己的 Pi 配置、模型凭据和 session。在该机器上部署 headless host 及其 systemd user service：

```bash
curl -fsSL https://raw.githubusercontent.com/OnePerson2020/pi-codex/main/install-linux.sh | sh
```

部署目录为 `~/.local/share/pi-desktop`，其中的 Pi SDK 版本与 macOS bridge 接受的远程版本一致。需要 Node.js 22.19+ 和 `systemd --user` 会话；`sudo loginctl enable-linger "$USER"` 可让 host 在登出后继续运行。

版本固定方式与 macOS 相同：`PI_CODEX_TAG=v0.1.0`。如果该机器无法访问 GitHub，可把 release tarball 复制过去，从 tarball 中取出 `install-linux.sh` 并以 `PI_CODEX_SOURCE=/tmp/pi-codex-0.1.0.tar.gz` 运行。

## 不安装应用，直接运行

可以直接测试 app-server bridge：

```bash
printf '%s\n' \
  '{"id":"init","method":"initialize","params":{"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"id":"models","method":"model/list","params":{}}' |
  ./pi-app-server.mjs
```

## Pi Web session 检测

本地 bridge 可以读取 Pi Web 的 loopback `/api/sessions` 接口。当 Pi Web 在 `runningSessionIds` 中明确报告某个 session 时，pi-codex 会给它添加 `[Pi Web 运行中]` 标记。历史记录仍然可以查看，但并发修改会被拒绝。

这只是占用状态检测，不是分布式锁。如果 Pi Web 不可访问，或者响应无法与同一个 session 文件匹配，pi-codex 不会阻塞该 session。此机制不覆盖 CLI 和任意 SDK 客户端。

配置方式：

```bash
export PI_DESKTOP_PI_WEB_URL=http://127.0.0.1:30141
export PI_DESKTOP_PI_WEB_PASSWORD='your-local-pi-web-password' # 仅在启用密码时设置
```

## 自定义 harness 行为

主要修改入口有：

- `src/pi-host.mjs`：Pi 生命周期和 Codex app-server 方法
- `src/protocol.mjs`：消息、turn、item、模型和工具转换
- `src/pi-sdk.mjs`：发现已安装的 Pi SDK
- `src/desktop-mcp.mjs`：向 Pi 暴露 Codex 桌面工具
- `src/session-guard.mjs`：本地 Desktop writer 保护
- `src/ssh-transport.mjs`：可选的远程 host 路由

未知的 Pi 工具会使用通用桌面工具卡片，因此添加扩展通常不需要修改 bridge。只有需要更贴近 Codex UI 的展示方式时，才需要修改映射。

运行离线测试：

```bash
PI_OFFLINE=1 PI_TELEMETRY=0 npm test
```

## 安全说明与当前限制

- Pi 工具使用 pi-codex 进程的操作系统权限运行。Codex UI 中的 sandbox 选择不会隔离 Pi。
- 未使用同一套 ownership 机制的客户端仍可能发生并发写入冲突。
- 仅适用于 TUI 的 Pi widgets 无法映射到桌面界面。
- SSH backend 需要在远程机器上单独安装匹配的 Pi host 和 SDK。
- 当前版本使用 Pi SDK 0.85.1 和固定的 macOS 桌面运行时验证。上游协议变化后可能需要同步更新。

本项目是独立的兼容 bridge，与 OpenAI 或 Pi 维护者没有隶属或背书关系。
