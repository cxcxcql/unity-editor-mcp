# Unity Editor MCP

[![CI](https://github.com/ozankasikci/unity-editor-mcp/actions/workflows/test-coverage.yml/badge.svg)](https://github.com/ozankasikci/unity-editor-mcp/actions/workflows/test-coverage.yml)
[![codecov](https://codecov.io/gh/ozankasikci/unity-editor-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/ozankasikci/unity-mcp)
[![npm version](https://img.shields.io/npm/v/unity-editor-mcp)](https://www.npmjs.com/package/unity-editor-mcp)

> ⚠️ **本项目处于 Beta 阶段，正在快速开发中。** 功能和 API 可能随时变化，请自行评估风险后使用。

> 🔧 **本 fork 面向 Unity 2020.3 LTS** — 改编自 [ozankasikci/unity-editor-mcp](https://github.com/ozankasikci/unity-editor-mcp)，适配 Unity 2020.3，并附带 Claude Code/Codex MCP stdio 适配器（`claude-code/unity-mcp-adapter.mjs`）与批量工具（`batch_create_gameobjects`、`batch_instantiate_prefab`）。

Unity Editor MCP（Model Context Protocol）让 Claude、Cursor 等 AI 助手能够直接与 Unity 编辑器交互，实现 AI 辅助游戏开发与自动化。

## 🚀 核心特性

- **🎮 GameObject 管理**：创建 primitive、修改 transform、管理层级、删除对象
- **🔧 组件系统**：为 GameObject 添加、移除、修改、列出组件，支持完整属性控制
- **🎭 Prefab 工作流**：完整的 prefab 模式编辑——打开、修改、保存、退出，支持覆盖管理
- **🔍 智能搜索**：按名称、tag、layer 或组件类型查找 GameObject，支持精确/模糊匹配
- **📊 场景分析**：分析场景组成、组件统计、prefab 连接
- **🎯 组件检查**：获取组件值、按组件查找对象、追踪对象间引用
- **🎬 场景控制**：创建、加载、保存场景，管理 Build Settings，支持多场景
- **🏃 播放模式测试**：启动、暂停、停止播放模式，检查编辑器状态与编译状态
- **🖼️ 截图捕获**：捕获 Game View 或 Scene View 截图并支持分析
- **🎨 资源管理**：创建和修改 prefab、材质、脚本，提供全面的属性控制
- **🖱️ UI 自动化**：通过编程方式与 Unity UI 元素交互，用于测试和自动化
- **📝 控制台集成**：读取按类型过滤的 Unity 控制台日志，支持增强调试功能
- **🔄 编辑器操作**：刷新资源、执行菜单项、触发重新编译


## 🚀 快速开始

### 前置要求

- ✅ Unity 2020.3 LTS 或更高
- ✅ Node.js 18.0.0 或更高
- ✅ Claude Desktop 或 Cursor

### 安装

#### 📦 第一步：安装 Unity 包

在 Unity 中：

1. 打开 **Window → Package Manager**
2. 点击 **"+"** → **"Add package from git URL..."**
3. 粘贴：`https://github.com/cxcxcql/unity-editor-mcp.git?path=unity-editor-mcp#main`
4. 点击 **Add**

> ✨ Unity 会自动启动 MCP 桥接。它优先使用端口 6400，当有多个 Unity 实例打开时会自动回退到可用的本地端口。

#### ⚙️ 第二步：配置 MCP 客户端

**Claude Desktop:**

在配置文件中添加：
- **macOS：** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows：** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "unity-editor-mcp": {
      "command": "npx",
      "args": ["unity-editor-mcp@latest"]
    }
  }
}
```

**Cursor：**

将同样的配置添加到 Cursor 的 MCP 设置中。

#### ✅ 第三步：验证连接

1. **重启 MCP 客户端**（Claude Desktop 或 Cursor）
2. 在 Unity Console 中查看：`[Unity Editor MCP] Client connected`
3. 大功告成！🎮

### 多个 Unity 实例

Unity Editor MCP 现在会自动发现正在运行的 Unity 项目。每个 Unity 编辑器实例都会在 `~/.unity-editor-mcp/instances` 下写入一个内部运行时注册表条目，包含项目路径、进程 ID、端口、Unity 版本、包版本、工作区 ID、Git worktree 元数据以及心跳时间戳。你无需编辑此文件。

当 Node MCP 服务器启动时，按以下顺序选择 Unity 实例：

1. `UNITY_PORT` 或 `--port`（如果显式提供）
2. `UNITY_MCP_INSTANCE_ID` 或 `--instance`
3. `UNITY_PROJECT_PATH`、`UNITY_MCP_PROJECT_PATH` 或 `--project`
4. `UNITY_MCP_WORKSPACE_ID` 或 `--workspace-id`
5. 从当前工作目录推断出的 Unity 项目
6. 从当前工作目录推断出的稳定工作区 ID
7. 唯一活动的 Unity MCP 实例（如果恰好只有一个）

对于 Git worktree，工作区 ID 存储在 Git 私有 worktree 元数据中，通过 `git rev-parse --git-path unity-editor-mcp/workspace-id` 访问。对于非 Git 项目，存储于 `Library/UnityEditorMCP/workspace-id`。不会写入被 Git 跟踪的 Unity 项目文件。

如果服务器从当前工作目录推断出本地 Unity 项目/工作区，则要求项目或工作区精确匹配，并且不使用单实例回退。如果同一 Git 仓库的相关 worktree 已打开但没有一个与当前 worktree 匹配，它会以 `WORKTREE_MISMATCH` 候选列表方式安全失败，而不是静默连接。要显式恢复旧的便捷回退行为，请设置 `UNITY_MCP_ALLOW_SINGLE_INSTANCE_FALLBACK=true` 或传入 `--allow-single-instance-fallback`。

不启动 MCP 会话即可查看发现结果：

```bash
unity-editor-mcp doctor
unity-editor-mcp doctor --project /path/to/UnityProject
unity-editor-mcp doctor --workspace-id <workspace-id>
unity-editor-mcp doctor --instance <instance-id>
unity-editor-mcp doctor --allow-single-instance-fallback
unity-editor-mcp doctor --json
```

## GPT / Codex 使用适配器

[claude-code/unity-mcp-adapter.mjs](claude-code/unity-mcp-adapter.mjs) 是一个零依赖的 MCP stdio 适配器，除了 Claude Code，也可用于 **Codex CLI** 和 **ChatGPT 桌面版**：

- **Codex CLI**：`codex mcp add unity -- node <适配器绝对路径>`，或编辑 `~/.codex/config.toml` 添加 `[mcp_servers.unity]`（下划线格式）
- **ChatGPT 桌面版**：Settings → Connections → MCP servers → Add → 传输方式 STDIO → Command `node`，Args 填适配器路径（本地 stdio 仅桌面版支持）

完整的配置示例（Codex TOML、ChatGPT `mcp.json`、环境变量与常见问题）见 [codex/](codex/) 目录。

## 可用工具

Unity Editor MCP 提供 **63 个工具**，覆盖 **11 个类别**，实现完整的 Unity 编辑器自动化：

### 系统与核心工具（3 个）
- **`ping`** - 测试与 Unity 编辑器的连接并验证服务器状态
- **`read_logs`** - 读取 Unity 控制台日志，支持按类型过滤（Log、Warning、Error 等）
- **`refresh_assets`** - 刷新 Unity 资源，可选等待编译稳定

### GameObject 管理（5 个）
- **`create_gameobject`** - 创建带 primitive、transform、tag、layer 的 GameObject
- **`find_gameobject`** - 按名称、tag、layer 查找 GameObject，支持模式匹配
- **`modify_gameobject`** - 修改 GameObject 属性（transform、名称、激活状态、父节点等）
- **`delete_gameobject`** - 删除单个或多个 GameObject，可选处理子对象
- **`get_hierarchy`** - 获取完整场景层级，支持组件信息与深度控制

### 组件系统（5 个）
- **`add_component`** - 为 GameObject 添加组件并设置初始属性
- **`remove_component`** - 移除组件（带安全检查，防止移除 Transform）
- **`modify_component`** - 修改组件属性，支持点号表示法的嵌套属性
- **`list_components`** - 列出 GameObject 上的所有组件，包含类型信息和可移除状态
- **`get_component_types`** - 发现可用组件类型，支持按类别过滤和可添加性判断

### 场景管理（5 个）
- **`create_scene`** - 创建新场景，集成 Build Settings 并支持自动加载
- **`load_scene`** - 以 Single 或 Additive 模式加载现有场景
- **`save_scene`** - 保存当前场景，支持另存为
- **`list_scenes`** - 列出项目中的所有场景，包含过滤和 Build Settings 信息
- **`get_scene_info`** - 获取详细场景信息，包括 GameObject 数量

### 场景分析（5 个）
- **`get_gameobject_details`** - 深度检查 GameObject，包含组件详情和层级
- **`analyze_scene_contents`** - 全面的场景统计、组成分析和性能指标
- **`get_component_values`** - 获取指定组件的所有属性和值，带元数据
- **`find_by_component`** - 按组件类型查找 GameObject，支持范围过滤（scene/prefabs/all）
- **`get_object_references`** - 分析对象间引用，包括层级和资源连接

### 资源管理（11 个）
- **`create_prefab`** - 从 GameObject 或空模板创建 prefab，支持覆盖选项
- **`modify_prefab`** - 修改现有 prefab，支持属性变更和实例更新
- **`instantiate_prefab`** - 在场景中实例化 prefab，支持变换与父子设置
- **`open_prefab`** - 在 Unity prefab 模式中打开 prefab 进行精细编辑，支持聚焦与隔离
- **`exit_prefab_mode`** - 退出 prefab 模式，可选保存/放弃更改
- **`save_prefab`** - 在 prefab 模式保存更改，或将实例覆盖应用到 prefab 资源
- **`create_material`** - 创建新材质，支持着色器分配和属性配置
- **`modify_material`** - 修改现有材质，支持着色器更换和属性更新
- **`manage_asset_import_settings`** - 管理 Unity 资源导入设置（获取、修改、应用预设、重新导入）
- **`manage_asset_database`** - 管理 Unity Asset Database 操作（查找、信息、建文件夹、移动、复制、删除、刷新）
- **`analyze_asset_dependencies`** - 分析 Unity 资源依赖（依赖项、被依赖、循环依赖、未使用资源、体积影响）

### 脚本管理（6 个）
- **`create_script`** - 创建新 C# 脚本，支持模板和命名空间管理
- **`read_script`** - 读取脚本文件内容，带语法高亮信息
- **`update_script`** - 修改现有脚本，支持内容替换和校验
- **`delete_script`** - 删除脚本文件，带依赖检查和确认
- **`list_scripts`** - 列出项目中的所有脚本，支持过滤和元数据
- **`validate_script`** - 校验脚本语法并检查编译错误

### 播放模式控制（4 个）
- **`play_game`** - 启动 Unity 播放模式，用于测试和交互
- **`pause_game`** - 暂停或恢复 Unity 播放模式
- **`stop_game`** - 停止 Unity 播放模式并返回编辑模式
- **`get_editor_state`** - 获取当前 Unity 编辑器状态（播放模式、暂停、编译状态）

### UI 自动化（5 个）
- **`find_ui_elements`** - 在场景层级中定位 UI 元素，支持过滤
- **`click_ui_element`** - 模拟点击 UI 元素（按钮、开关等）
- **`get_ui_element_state`** - 获取详细的 UI 元素状态和交互能力
- **`set_ui_element_value`** - 为 UI 输入元素设置值（滑块、输入框等）
- **`simulate_ui_input`** - 执行复杂的 UI 交互序列

### 编辑器操作（5 个）
- **`execute_menu_item`** - 以编程方式执行 Unity 菜单项，带安全检查
- **`clear_console`** - 清除 Unity 控制台日志，可选过滤
- **`enhanced_read_logs`** - 高级日志读取，支持搜索、过滤和导出
- **`capture_screenshot`** - 捕获 Game View 或 Scene View 截图，支持自定义分辨率和编码
- **`analyze_screenshot`** - 分析截图内容，提供基础图像分析能力

### 编辑器控制与自动化（9 个）
- **`manage_tags`** - 管理 Unity 项目标签（添加、移除、列出）
- **`manage_layers`** - 管理 Unity 项目层级（添加、移除、列出、索引/名称转换）
- **`manage_selection`** - 管理 Unity 编辑器选中项（获取、设置、清除、获取详情）
- **`manage_windows`** - 管理 Unity 编辑器窗口（列出、聚焦、获取状态）
- **`manage_tools`** - 管理 Unity 编辑器工具和插件（列出、启用、禁用、刷新）
- **`start_compilation_monitoring`** - 开始监控 Unity 编译，实时错误检测
- **`stop_compilation_monitoring`** - 停止编译监控并获取最终状态
- **`get_compilation_state`** - 获取当前 Unity 编译状态和错误
- **`wait_for_compilation`** - 等待 Unity 编译/域重载完成并返回最终信息


## 故障排查

### Unity TCP 监听问题

如果你看到 "Port 6400 is already in use"：
1. 这是正常现象——另一个 Unity 实例已占用默认端口
2. 包会自动回退到可用的本地端口
3. 运行 `unity-editor-mcp doctor` 查看将选择哪个项目和端口

### 连接失败

1. 确保 Unity 编辑器正在运行且已安装该包
2. 检查 Unity 控制台中的错误信息
3. 确认 Node.js 服务器正在运行
4. 确认 MCP 客户端配置路径为绝对路径

### Node.js 服务器无法启动

1. 确认已安装 Node.js 18+：`node --version`
2. 在 mcp-server 目录运行 `npm install`
3. 检查控制台中的错误信息

## 贡献

开发指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。
