# Unity Editor MCP Server

MCP (Model Context Protocol) server for Unity Editor integration. Enables AI assistants like Claude and Cursor to interact directly with Unity Editor for automated game development.

## Features

- **67+ comprehensive tools** for Unity Editor automation
- **GameObject management** - Create, find, modify, delete GameObjects
- **Scene management** - Create, load, save, list scenes  
- **Scene analysis** - Deep inspection and component analysis
- **UI interactions** - Find, click, and interact with UI elements
- **Asset management** - Create and modify prefabs and materials
- **Play mode controls** - Start, pause, stop Unity play mode
- **System tools** - Console logs, asset refresh, connection testing

## Quick Start

### Using npx (Recommended)

```bash
npx unity-editor-mcp
```

### Global Installation

```bash
npm install -g unity-editor-mcp
unity-editor-mcp
```

### Local Installation

```bash
npm install unity-editor-mcp
npx unity-editor-mcp
```

## Unity Setup

1. Install the Unity package from: `https://github.com/ozankasikci/unity-mcp.git?path=unity-editor-mcp`
2. Open Unity Package Manager → Add package from git URL
3. The package will automatically start a TCP server on port 6400 when available, or a free local port when another Unity instance already owns 6400

## MCP Client Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "unity-editor-mcp": {
      "command": "npx",
      "args": ["unity-editor-mcp"]
    }
  }
}
```

### Alternative (if globally installed)

```json
{
  "mcpServers": {
    "unity-editor-mcp": {
      "command": "unity-editor-mcp"
    }
  }
}
```

### Multiple Unity Instances

The Unity package writes live instance metadata automatically to `~/.unity-editor-mcp/instances`. The Node server reads those files to select the correct Unity project/worktree. You do not write this registry manually.

Selection order:

1. `UNITY_PORT` or `--port`
2. `UNITY_MCP_INSTANCE_ID` or `--instance`
3. `UNITY_PROJECT_PATH`, `UNITY_MCP_PROJECT_PATH`, or `--project`
4. `UNITY_MCP_WORKSPACE_ID` or `--workspace-id`
5. Unity project inferred from the current working directory
6. workspace ID inferred from the current working directory
7. the only live Unity MCP instance

For Git worktrees, the workspace ID is stored under Git's private worktree metadata with `git rev-parse --git-path unity-editor-mcp/workspace-id`. For non-Git projects it is stored under `Library/UnityEditorMCP/workspace-id`. If the server infers a local Unity project/workspace from the current working directory, it requires an exact project or workspace match and does not use the single-live-instance fallback. If related worktrees from the same Git repository are open but none match the current worktree, discovery fails closed with `WORKTREE_MISMATCH` and lists candidates instead of connecting to the wrong editor.

To opt back into the old convenience fallback, set `UNITY_MCP_ALLOW_SINGLE_INSTANCE_FALLBACK=true` or pass `--allow-single-instance-fallback`.

```bash
unity-editor-mcp doctor
unity-editor-mcp doctor --project /path/to/UnityProject
unity-editor-mcp doctor --workspace-id <workspace-id>
unity-editor-mcp doctor --instance <instance-id>
unity-editor-mcp doctor --allow-single-instance-fallback
unity-editor-mcp doctor --json
```

### Durable Local Daemon

By default, the stdio MCP entrypoint is a thin shim. It starts or discovers a local Streamable HTTP daemon, and the daemon owns the long-lived Unity TCP connection, auth-token refresh, reconnects, and command queue. This keeps stdio compatibility for MCP clients while avoiding stale wrapper connections after Unity reloads or Codex session transport resets.

Manual commands:

```bash
unity-editor-mcp daemon
unity-editor-mcp doctor --json
unity-editor-mcp cleanup-stale
unity-editor-mcp cleanup-stale --json
```

The daemon registry lives at `~/.unity-editor-mcp/daemon.json` by default and records `pid`, `port`, `packageVersion`, `gitHead`, `entrypoint`, start/heartbeat timestamps, selected Unity instance, and the last daemon error. Startup uses `daemon.lock` to prevent concurrent stdio shims from spawning duplicate ephemeral-port daemons, and detached daemon stdout/stderr goes to `daemon.log`. `cleanup-stale` removes stale locks and only signals processes validated through this registry and a matching Unity MCP daemon command line; it does not run broad `kill node` cleanup.

Daemon and recovery knobs:

```bash
UNITY_MCP_USE_DAEMON=false
UNITY_MCP_DAEMON_PORT=0
UNITY_MCP_DAEMON_REGISTRY_DIR=$HOME/.unity-editor-mcp
UNITY_MCP_DAEMON_AUTOSTART=true
UNITY_MCP_DAEMON_STARTUP_TIMEOUT_MS=10000
UNITY_MCP_DAEMON_STALE_AFTER_MS=30000
UNITY_MCP_DAEMON_MAX_BODY_BYTES=1048576
UNITY_MCP_PLAY_MODE_RECOVERY_TIMEOUT_MS=15000
UNITY_MCP_PLAY_MODE_POLL_INTERVAL_MS=250
UNITY_MCP_PLAY_MODE_STATE_COMMAND_TIMEOUT_MS=1000
UNITY_MCP_ACTIVATE_UNITY_ON_PLAYMODE_FREEZE=false
```

`play_game` waits for usable Play Mode by default, meaning Unity reports `isPlaying=true` and the player loop is advancing. Pass `waitForPlayerLoop:false` only when a caller needs the older transitional behavior.

## Available Tools

### System & Core (3 tools)
- `ping` - Test Unity Editor connection
- `read_logs` - Read Unity console logs 
- `refresh_assets` - Trigger asset recompilation, optionally waiting for completion

### GameObject Management (5 tools)
- `create_gameobject` - Create GameObjects with primitives and transforms
- `find_gameobject` - Find GameObjects by name, tag, layer
- `modify_gameobject` - Modify GameObject properties
- `delete_gameobject` - Delete GameObjects
- `get_hierarchy` - Get scene hierarchy

### Scene Management (5 tools)
- `create_scene` - Create new scenes
- `load_scene` - Load scenes (Single/Additive)
- `save_scene` - Save current scene
- `list_scenes` - List project scenes
- `get_scene_info` - Get scene details

### Scene Analysis (5 tools)  
- `get_gameobject_details` - Deep GameObject inspection
- `analyze_scene_contents` - Scene statistics and analysis
- `get_component_values` - Component property inspection
- `find_by_component` - Find objects by component type
- `get_object_references` - Analyze object relationships

### Play Mode Controls (4 tools)
- `play_game` - Start Unity play mode
- `pause_game` - Pause/resume play mode  
- `stop_game` - Stop play mode
- `get_editor_state` - Get editor state

### Compilation
- `get_compilation_state` - Get current compilation state and errors
- `wait_for_compilation` - Wait for compilation/domain reload to settle and return final messages

### UI Interactions (5 tools)
- `find_ui_elements` - Find UI elements by type, tag, or name
- `click_ui_element` - Click on UI buttons and interactive elements
- `get_ui_element_state` - Get UI element properties and state
- `set_ui_element_value` - Set values for input fields and sliders
- `simulate_ui_input` - Simulate keyboard and mouse input on UI

### Asset Management (5 tools)
- `create_prefab` - Create prefabs from GameObjects
- `modify_prefab` - Modify existing prefab properties
- `instantiate_prefab` - Instantiate prefabs in the scene
- `create_material` - Create new materials with shaders
- `modify_material` - Modify material properties and textures

## Requirements

- **Unity**: 2020.3 LTS or newer
- **Node.js**: 18.0.0 or newer
- **MCP Client**: Claude Desktop, Cursor, or compatible client

## Troubleshooting

### Connection Issues
1. Ensure Unity Editor is running with the Unity package installed
2. Check Unity console for connection messages
3. Run `unity-editor-mcp doctor` to see discovered Unity instances and selected endpoint

### Installation Issues
```bash
# Clear npm cache
npm cache clean --force

# Reinstall
npm uninstall -g unity-editor-mcp
npm install -g unity-editor-mcp
```

## Repository

Full source code and documentation: https://github.com/ozankasikci/unity-mcp

## License

MIT License - see LICENSE file for details.
