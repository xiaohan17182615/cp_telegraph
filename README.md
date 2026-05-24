# WeChat Codex Bridge

一个面向个人使用的微信到本地 Codex CLI 桥接项目。它参考了 Chat-Codex 的轻量微信 iLink 接入方式，以及 CodexBridge 的多会话、长轮询和服务化思路，但代码是独立实现，重点放在安全默认值、可维护配置和可公开发布。

## 特性

- 微信扫码登录，保存本地 token，不需要把 token 放进代码仓库。
- 每个微信私聊维护独立 Codex 线程，后续消息会自动 resume；群聊按 iLink 返回的 `group_id` 做 best-effort 支持。
- 默认启用会话配对：第一次使用必须在运行桥接的终端读取验证码，再在微信发送 `/pair <code>`。
- 群聊默认只响应 `@codex` 开头的普通任务，避免群内所有消息都触发本地 Codex。
- 运行任务时会按官方 `getconfig/sendtyping` 流程发送 typing 状态。
- 默认下载并解密入站图片、文件、视频和语音为本地文件路径，再交给 Codex。
- 多张连续图片/文件会在短窗口内与后续文字合并成一次 Codex 任务，适合“几张图加一句要求”的微信操作习惯。
- 支持 `codex exec` 和实验性 `codex app-server` 两种运行面；app-server 模式可使用 Codex 的系统 skill，例如 `imagegen`。
- 支持把 Codex 生成的本地图片、PDF、HTML、docx/xlsx/pptx 等 artifact 发回微信；优先走 iLink CDN，若 CDN 拒绝原始文件，可配置 HTTPS 公开目录用 `media.full_url` 原样投递，不压缩、不重打包。
- 支持 `/new`、`/cwd`、`/retry`、`/stop`、`/status`、`/routes` 等微信内命令。
- 微信消息发送带拆分、排队、限速和重试，降低触发风控的概率。
- 本地状态文件使用单独目录保存，账号 token 和路由状态默认不进入仓库。
- 提供 systemd user service 与 Windows 计划任务脚本模板。

## 快速开始

需要 Node.js 22+，以及本机已安装并登录可用的 Codex CLI。

```bash
npm install
npm run build
npm run doctor
npm run login
npm run serve
```

在微信里第一次向机器人发送消息时，终端会打印一个 6 位配对码。把它发送回微信：

```text
/pair 123456
```

之后直接在私聊发送自然语言即可运行 Codex。群聊默认用：

```text
@codex 帮我检查这个仓库
```

## 微信命令

```text
/help          显示命令
/status        查看当前聊天的桥接状态
/new [cwd]     为当前聊天开启新的 Codex 线程，可选切换工作目录
/cwd <path>    设置当前聊天的工作目录
/retry         重试当前聊天上一条任务
/stop          停止当前聊天正在运行的 Codex
/routes        列出已记录的微信路由
/pair <code>   配对当前微信聊天
```

## 配置

可以复制 `config/wechat-codex.env.example` 到自己的环境文件中。常用变量：

```bash
WECHAT_CODEX_CWD=/path/to/workspace
WECHAT_CODEX_BIN=codex
WECHAT_CODEX_BOT_AGENT=WechatCodexBridge/0.1.0
WECHAT_CODEX_PAIRING_REQUIRED=true
WECHAT_CODEX_GROUP_TRIGGER=@codex
WECHAT_CODEX_DOWNLOAD_MEDIA=true
WECHAT_CODEX_INBOUND_MERGE_WINDOW_MS=15000
WECHAT_CODEX_MEDIA_MAX_BYTES=104857600
WECHAT_CODEX_PUBLIC_ARTIFACT_DIR=/var/www/wechat-codex-artifacts
WECHAT_CODEX_PUBLIC_ARTIFACT_BASE_URL=https://example.com/wechat-codex-artifacts
WECHAT_CODEX_TYPING_ENABLED=true
WECHAT_CODEX_WORKING_NOTICE=false
WECHAT_CODEX_HOME=~/.wechat-codex-bridge
WECHAT_CODEX_RUNNER=exec
WECHAT_CODEX_MODEL=gpt-5.5
WECHAT_CODEX_REASONING_EFFORT=xhigh
```

Codex 参数可以按需调整：

```bash
WECHAT_CODEX_EXEC_ARGS='--json -m gpt-5.5 -c model_reasoning_effort="xhigh" --skip-git-repo-check'
WECHAT_CODEX_RESUME_ARGS='--json -m gpt-5.5 -c model_reasoning_effort="xhigh" --skip-git-repo-check --all'
```

如果希望更接近 Codex App/CodexBridge 的能力面，可以启用 app-server：

```bash
WECHAT_CODEX_RUNNER=app-server
```

app-server 模式会通过 `codex app-server` 调用已登录 Codex runtime，并优先接收 `imageGeneration.savedPath` 这类原生图片产物。该模式依赖当前机器的 Codex CLI、登录态和网络环境；失败时桥接会回退到 `codex exec` 路线。

## 服务化运行

Linux systemd user service:

```bash
cp scripts/service/wechat-codex.service.template ~/.config/systemd/user/wechat-codex.service
systemctl --user daemon-reload
systemctl --user enable --now wechat-codex.service
```

Windows 计划任务:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/service/install-windows-task.ps1 -ProjectDir "$PWD"
```

## 排障

如果 `npm run doctor` 显示 `codex: failed (spawn EPERM)`，通常是当前 `codex` 命令指向了 WindowsApps/AppX 沙盒路径，普通 Node 进程无法直接启动它。请安装一个可从终端直接执行的 Codex CLI，或把 `WECHAT_CODEX_BIN` 配置为可执行文件的绝对路径，再重新运行 `npm run doctor`。

## 安全边界

这个项目会把微信消息转交给本地 Codex CLI 或 Codex app-server，本质上等同于允许已配对微信聊天远程触发本机智能体。建议只在自己的机器和可信微信聊天中使用，保持默认配对开启，不要把账号 token、`.env`、状态目录或 Codex 凭据提交到仓库。

微信 iLink 是腾讯 `@tencent-weixin/openclaw-weixin` 官方插件正在使用的 Bot 通信通道，整体比旧式逆向微信协议更正规、更稳定。本项目是对 iLink HTTP 协议的独立轻量实现，不直接依赖官方插件，因此会跟随官方插件和后端协议变化进行兼容更新；群聊能力也以官方实际返回和能力声明为准。

媒体说明：入站媒体会保存到 `WECHAT_CODEX_HOME/state/uploads/inbound`。默认会等待 15 秒把连续图片/文件和随后文字合并成一次任务。出站 artifact 默认走 `getuploadurl -> AES-128-ECB 加密上传 CDN -> sendmessage` 流程；普通 PNG/JPG/WebP/GIF 会原样上传，不做有损压缩；SVG 或透明图片会先渲染成白底 PNG。若配置了 `WECHAT_CODEX_PUBLIC_ARTIFACT_DIR` 和 `WECHAT_CODEX_PUBLIC_ARTIFACT_BASE_URL`，当 iLink CDN 对原始文件返回 500 或超时时，桥接会把原始字节复制到该 HTTPS 目录，并用 `media.full_url` 发送文件消息，避免为了成功投递而压缩图片或重生成 docx/xlsx/pptx/PDF/HTML。

更多说明见 `docs/security.md` 和 `docs/architecture.md`。
