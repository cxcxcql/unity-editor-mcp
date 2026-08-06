# GPT / Codex 使用适配器

本目录让你在 **Codex CLI** 和 **ChatGPT 桌面版**中通过 MCP 连接 Unity 编辑器。

[unity-mcp-adapter.mjs](unity-mcp-adapter.mjs) 是一个**零依赖**的 MCP stdio 服务器：它从 Unity 插件的实例注册表（`~/.unity-editor-mcp/instances/<pid>.json`）自动发现端口与 authToken，转发全部工具命令（含批量工具 `batch_create_gameobjects`、`batch_instantiate_prefab`）。

> 与 `claude-code/unity-mcp-adapter.mjs` 内容一致。本目录为 GPT/Codex 单独放一份，方便只拷贝本目录即可使用。

## 前置要求

- Unity 已打开目标项目，且已安装 `com.unity.editor-mcp` 包（订阅方式见主 README）
- Node.js 18+：`node --version`

## 1. Codex CLI

### 添加服务器

**方式 A：命令行**

```bash
codex mcp add unity -- node /abs/path/to/codex/unity-mcp-adapter.mjs
```

**方式 B：手动编辑 `~/.codex/config.toml`**

```toml
[mcp_servers.unity]
command = "node"
args = ["/abs/path/to/codex/unity-mcp-adapter.mjs"]
enabled = true
```

> ⚠️ Codex 使用下划线格式 `[mcp_servers.*]`（不是 `[mcpServers.*]`）。
> 完整可选项（超时、环境变量等）见 [codex.config.example.toml](codex.config.example.toml)。

### 验证

```bash
codex mcp list
codex mcp get unity
```

启动新 Codex 会话后，Unity 的工具即出现在可用工具列表中。

## 2. ChatGPT 桌面版

本地 stdio 服务器**仅桌面版支持**（网页版只支持远程 HTTPS MCP）。

### 方式 A：应用内配置

1. 打开 ChatGPT 桌面版 → **Settings → Connections → MCP servers**
2. 点击 **Add**，名称填 `unity`，传输方式选 **STDIO**
3. **Command** 填 `node`，**Args** 填适配器的绝对路径
4. 保存后**重启 ChatGPT**

### 方式 B：编辑配置文件

- **Windows:** `%APPDATA%\ChatGPT\mcp.json`
- **macOS:** `~/Library/Application Support/ChatGPT/mcp.json`

```json
{
  "servers": {
    "unity": {
      "command": "node",
      "args": ["C:/abs/path/to/codex/unity-mcp-adapter.mjs"]
    }
  }
}
```

保存后重启 ChatGPT，在对话中输入 `/mcp` 可查看已连接的服务器。

## 3. 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `UNITY_MCP_PROJECT_PATH` | Unity 项目根目录，用于匹配实例注册表（默认取工作目录）|
| `UNITY_MCP_PORT` | 强制端口，跳过自动发现 |
| `UNITY_MCP_AUTH_TOKEN` | 强制 authToken，跳过自动发现 |

## 4. 常见问题

- **连接失败 / 找不到实例**：确认 Unity 已打开且插件 TCP 监听已启动，检查 `~/.unity-editor-mcp/instances/` 下是否有对应 json 文件。
- **多个 Unity 实例连错**：设置 `UNITY_MCP_PROJECT_PATH` 精确匹配目标项目。
- **工具调用超时**：Unity 大场景首次连接较慢，在配置里加大 `startup_timeout_sec` / `tool_timeout_sec`。
