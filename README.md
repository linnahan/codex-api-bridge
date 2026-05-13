# Codex API Bridge

**Bridge OpenAI Responses API (WebSocket) to Chat Completions API (HTTP)**

[English](#english) | [中文](#chinese)

---

## English

### Overview

[OpenAI Codex CLI](https://github.com/openai/codex) v0.116+ uses the **Responses API** (`/v1/responses`) exclusively — it communicates via **WebSocket** and speaks the new Responses protocol. However, most third-party OpenAI-compatible providers only support the older **Chat Completions API** (`/v1/chat/completions`) over **HTTP**.

**Codex API Bridge** translates between these two protocols. It acts as a local proxy that:

- Listens for WebSocket connections from Codex CLI on `/v1/responses`
- Translates Responses API messages into Chat Completions API calls
- Forwards streaming chunks back into the WebSocket event protocol
- Also supports plain HTTP POST to `/v1/responses` (REST fallback)

This allows you to use Codex CLI with **any OpenAI-compatible provider** — including local LLM servers (Ollama, vLLM, llama.cpp), regional cloud providers, or self-hosted endpoints.

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/codex-api-bridge.git
cd codex-api-bridge

# Install dependencies
npm install

# (Optional) Install globally
npm install -g .
```

### Configuration

The proxy is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `TARGET_URL` | `http://localhost:8080/v1/chat/completions` | Upstream Chat Completions endpoint |
| `API_KEY` | `""` | API key for the upstream provider |
| `PROXY_PORT` | `18789` | Local port for the proxy server |
| `MODEL` | `gpt-3.5-turbo` | Default model name sent to upstream |

Create a `.env` file (or export variables in your shell):

```bash
export TARGET_URL=https://api.example.com/v1/chat/completions
export API_KEY=sk-your-api-key-here
export MODEL=gpt-4o
```

### Usage

#### 1. Start the proxy

```bash
node proxy.mjs
# [codex-api-bridge] Listening on http://127.0.0.1:18789/v1/responses
# [codex-api-bridge] Target: https://api.example.com/v1/chat/completions
```

#### 2. Configure Codex CLI

Edit `~/.codex/config.toml`:

```toml
model = "your-model-name"
model_provider = "openai"
openai_base_url = "http://127.0.0.1:18789/v1"

[projects."/path/to/your/project"]
trust_level = "trusted"
```

Set the API key in `~/.codex/.env`:

```bash
OPENAI_API_KEY=sk-any-value-will-work
```

> **Note:** Codex CLI requires `OPENAI_API_KEY` to be set, but since requests go through the local proxy, you can use any value.

#### 3. Run Codex

```bash
codex
```

### How It Works

```
┌─────────────┐     WebSocket      ┌──────────────────┐       HTTP       ┌─────────────────┐
│  Codex CLI  │ ──────────────────►│  Codex API Bridge ├────────────────►│  Your Provider  │
│  (Responses │                    │  (127.0.0.1:18789)│                 │  (Chat Complet.)│
│   API)      │◄───────────────────│                    │◄────────────────│                 │
└─────────────┘     Events         └────────────────────┘     Stream     └─────────────────┘
```

**Protocol translation:**

| Responses API (WebSocket) | Chat Completions API (HTTP) |
|---|---|
| `role: developer` | `role: system` |
| `input: [{role, content: [{type:"text", text:"..."}]}]` | `messages: [{role, content: "..."}]` |
| `response.text.delta` events | `stream: true` + SSE chunks |
| `response.completed` event | Stream end |

### Auto-Start

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
# Codex API Bridge — auto-start on terminal launch
if lsof -i :18789 > /dev/null 2>&1; then
  :
else
  node ~/.codex/proxy.mjs > /tmp/codex-proxy.log 2>&1 &
fi
```

Or create a launchd service (macOS) / systemd service (Linux).

### Troubleshooting

| Problem | Solution |
|---|---|
| `WebSocket closed by server before response.completed` | Ensure `TARGET_URL` is reachable and returns valid Chat Completions responses |
| `Connection refused` on :18789 | The proxy isn't running — start it with `node proxy.mjs` |
| `Model metadata not found` | This is a cosmetic warning from Codex — it does not affect functionality |
| Upstream returns errors | Check the upstream provider dashboard and verify `API_KEY` is correct |

### License

MIT

---

<a name="chinese"></a>

## 中文

### 概述

[OpenAI Codex CLI](https://github.com/openai/codex) v0.116+ 只支持 **Responses API**（`/v1/responses`），使用 **WebSocket** 协议。然而，大多数第三方兼容 OpenAI 的提供商只支持旧的 **Chat Completions API**（`/v1/chat/completions`）走 **HTTP**。

**Codex API Bridge** 在两者之间进行协议转换。它作为一个本地代理：

- 在 `/v1/responses` 上监听来自 Codex CLI 的 WebSocket 连接
- 将 Responses API 消息转换为 Chat Completions API 请求
- 将流式响应块转发回 WebSocket 事件协议
- 同时支持直接 HTTP POST 到 `/v1/responses`（REST 回退）

这使得你可以将 Codex CLI 与**任何兼容 OpenAI 的提供商**一起使用——包括本地 LLM 服务器（Ollama、vLLM、llama.cpp）、区域云服务商或自建端点。

### 安装

```bash
# 克隆仓库
git clone https://github.com/YOUR_USERNAME/codex-api-bridge.git
cd codex-api-bridge

# 安装依赖
npm install

# （可选）全局安装
npm install -g .
```

### 配置

通过环境变量配置代理：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TARGET_URL` | `http://localhost:8080/v1/chat/completions` | 上游 Chat Completions API 地址 |
| `API_KEY` | `""` | 上游 API 密钥 |
| `PROXY_PORT` | `18789` | 代理监听端口 |
| `MODEL` | `gpt-3.5-turbo` | 发送给上游的默认模型名 |

### 使用方法

#### 1. 启动代理

```bash
node proxy.mjs
```

#### 2. 配置 Codex CLI

编辑 `~/.codex/config.toml`：

```toml
model = "your-model-name"
model_provider = "openai"
openai_base_url = "http://127.0.0.1:18789/v1"

[projects."/path/to/your/project"]
trust_level = "trusted"
```

在 `~/.codex/.env` 中设置 API 密钥：

```bash
OPENAI_API_KEY=sk-任意值
```

> **注意：** Codex CLI 要求设置 `OPENAI_API_KEY`，但由于请求经过本地代理，可以使用任意值。

#### 3. 运行 Codex

```bash
codex
```

### 工作原理

```
┌─────────────┐     WebSocket      ┌──────────────────┐       HTTP       ┌─────────────────┐
│  Codex CLI  │ ──────────────────►│  Codex API Bridge ├────────────────►│  第三方 API 提供商 │
│  (Responses │                    │  (127.0.0.1:18789)│                 │  (Chat Complet.)│
│   API)      │◄───────────────────│                    │◄────────────────│                 │
└─────────────┘     Events         └────────────────────┘     Stream     └─────────────────┘
```

**协议转换对照：**

| Responses API (WebSocket) | Chat Completions API (HTTP) |
|---|---|
| `role: developer` | `role: system` |
| `input: [{role, content: [{type:"text", text:"..."}]}]` | `messages: [{role, content: "..."}]` |
| `response.text.delta` 事件 | `stream: true` + SSE 数据流 |
| `response.completed` 事件 | 流结束 |

### 开机自启

添加到 `~/.zshrc` 或 `~/.bashrc`：

```bash
# Codex API Bridge — 终端启动时自动运行
if lsof -i :18789 > /dev/null 2>&1; then
  :
else
  node ~/.codex/proxy.mjs > /tmp/codex-proxy.log 2>&1 &
fi
```

### 常见问题

| 问题 | 解决方法 |
|---|---|
| `WebSocket closed by server before response.completed` | 确认 `TARGET_URL` 可达且返回有效的 Chat Completions 响应 |
| :18789 端口 `Connection refused` | 代理未启动——执行 `node proxy.mjs` |
| `Model metadata not found` | Codex 的提示性警告，不影响功能 |
| 上游报错 | 检查上游服务商控制台，确认 `API_KEY` 正确 |

### 开源协议

MIT
