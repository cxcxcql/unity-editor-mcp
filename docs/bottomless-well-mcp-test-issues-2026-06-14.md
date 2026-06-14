# Bottomless Well MCP Test Issues

Date: 2026-06-14
Test project: `/Users/ozan/UnityProjects/Github/bottomless-well`
Unity: 6000.3.11f1
Unity Editor MCP package: 0.15.5

This is a repair backlog captured from a real MCP-driven gameplay test. It excludes game-specific bugs unless they exposed MCP behavior.

## 1. `play_game` returns `TOOL_ERROR` even when Play Mode starts

Observed:
- Calling `play_game` from Edit Mode often returned `{"code":"TOOL_ERROR","message":"Connection closed","details":{"tool":"play_game","params":"Empty parameters"}}`.
- Re-running discovery immediately afterward showed a new MCP endpoint and `get_editor_state` reported `isPlaying: true`.
- Likely trigger: Unity domain reload / MCP listener restart during Play Mode entry.

Expected:
- `play_game` should return a transitional success response when the Play Mode request was accepted, or reconnect and return the post-reload Play Mode state.

Impact:
- Agents interpret the tool call as a failed Play Mode start even though Unity successfully entered Play Mode.

Suggested fix:
- Treat connection close during a Play Mode transition as recoverable.
- After reconnecting, verify `EditorApplication.isPlaying` and return the actual state.

## 2. `stop_game` immediate response reports stale `isPlaying: true`

Observed:
- Calling `stop_game` returned `status: success` and `message: "Exited play mode"`, but the included state still had `isPlaying: true`.
- A follow-up `get_editor_state` a moment later returned `isPlaying: false`.

Expected:
- `stop_game` should wait until Unity has actually left Play Mode before returning the final state, or mark the response as transitional.

Impact:
- The response contradicts itself and makes automated test flows add extra polling.

Suggested fix:
- After issuing stop, poll until `EditorApplication.isPlaying == false` or timeout.

## 3. PlayerLoop can appear stuck after MCP Play Mode entry until pause/resume

Observed:
- After Play Mode entry through MCP, `get_editor_state` reported `isPlaying: true`, `isPaused: false`, `isCompiling: false`, and `isUpdating: false`.
- Runtime snapshots taken through an MCP menu hook showed `Time.time == 0`, `Time.frameCount == 1`, `Time.timeScale == 1`, while `Time.realtimeSinceStartup` kept increasing.
- Focusing the Game View, activating the Unity app, enabling `runInBackground`, and setting `Application.runInBackground = true` did not fix it.
- Calling `pause_game` once, then `pause_game` again to resume, unstuck the PlayerLoop. After that, `Time.time` and `Time.frameCount` advanced normally.

Expected:
- If Play Mode reports unpaused, PlayerLoop should be advancing.
- If Unity is internally paused/stalled, MCP state should expose that or `play_game` should normalize it.

Impact:
- Coroutines appeared stuck even though runtime state looked unpaused.
- MCP tests can falsely report gameplay bugs unless they verify frame/time advancement or perform pause/resume.

Suggested fix:
- After `play_game`, validate that `Time.frameCount` advances over a short interval.
- If not, perform or expose a documented recovery action.
- Consider returning PlayerLoop health fields from `get_editor_state`.

## 4. `capture_screenshot` fails for Game View

Observed:
- `capture_screenshot` with `captureMode: "game"` failed repeatedly with `Failed to capture screenshot - file not created`.
- This happened with explicit output paths, default paths, and base64 mode.
- `captureMode: "scene"` could save a file, but it did not represent the Game View.
- Workaround used: a custom Editor menu hook rendered `Camera.main` to a `RenderTexture` and wrote the PNG.

Expected:
- Game View capture should either produce an image or return a more specific failure reason.

Impact:
- Visual validation through MCP was blocked until custom project-side capture code was added.

Suggested fix:
- Make Game View screenshot capture robust in Play Mode and Edit Mode.
- Return diagnostic details: GameView availability, target path, current resolution, exception message, and whether the capture API returned pixels.

## 5. Scene screenshot can be misleading for gameplay validation

Observed:
- `capture_screenshot` with `captureMode: "scene"` succeeded, but the saved image was a flat blue/green view and did not match the game camera render.

Expected:
- This may be valid behavior if Scene View is pointed elsewhere, but the tool result should make it clear that this is the current Scene View, not the gameplay camera.

Impact:
- Agents can incorrectly treat a Scene View capture as a failed game render.

Suggested fix:
- Label scene captures explicitly as Scene View captures.
- Consider adding a `camera` capture mode or a Game View fallback that renders `Camera.main`.

## 6. Parallel MCP component calls timed out while Unity logged responses

Observed:
- Parallel calls to component-inspection tools such as `list_components` and `get_component_values` timed out.
- The Unity console indicated that responses were sent.
- Running similar component-inspection calls sequentially worked.

Expected:
- Either parallel calls should be supported reliably, or MCP should reject/queue concurrent commands explicitly.

Impact:
- Agents may use parallel tool calls for read-only inspection and get false timeouts.

Suggested fix:
- Add request serialization on the server/client side, or document/return a clear `BUSY` / queued state.
- Investigate response routing under concurrent connections.

## 7. Registry/discovery output is noisy with stale or duplicate endpoints

Observed:
- `list_unity_instances` returned many stale entries from older Unity projects and multiple entries for the current project.
- Some current-project entries had `packageVersion: "unknown"`, empty `activeScene`, and separate ports/PIDs.
- Explicit `projectPath` selection chose the correct endpoint, but the output is large and easy to misread.

Expected:
- Discovery should prioritize the live, package-backed endpoint and make stale/unknown endpoints less prominent.

Impact:
- Agents need to always pass explicit `projectPath` to avoid wrong-instance risk.
- Large discovery responses add noise and make debugging harder.

Suggested fix:
- Provide a compact mode that shows only selected endpoint plus conflicts.
- Improve stale cleanup for dead/unknown-package records.
- Group instances by project and mark recommended endpoint clearly.

## 8. Port fallback is logged as an error even though it succeeds

Observed:
- When port 6400 was occupied, MCP logged `[Unity Editor MCP] Port 6400 is already in use. Falling back to an available loopback port.`
- `enhanced_read_logs` classified this as `Error`, even though the fallback succeeded and MCP continued normally on another port.

Expected:
- Successful fallback should be `Warning` or `Info`, not `Error`.

Impact:
- Final error scans report an MCP error even when the game has no runtime errors.

Suggested fix:
- Lower log severity for successful port fallback.
- Include the selected fallback port in the same log message.

## 9. MCP internal command logging pollutes Unity warning logs

Observed:
- Console/log reads included many MCP internal messages as warnings: received command, processing command, sending response, client connected/disconnected.
- These dominated `enhanced_read_logs` output.

Expected:
- Tool-internal tracing should be opt-in, lower severity, or filterable by default.

Impact:
- Runtime warnings are hard to separate from MCP transport noise.
- Error/warning summaries overstate project health issues.

Suggested fix:
- Move command tracing to verbose mode or a dedicated MCP diagnostics sink.
- Add `excludeMcpInternal: true` to log-reading tools, defaulting to true for user/game logs.

## 10. `wait_for_compilation` reports placeholder compilation timestamp

Observed:
- `wait_for_compilation` returned success and correctly reported zero errors/warnings, but `lastCompilationTime` was `0001-01-01T00:00:00.0000000`.

Expected:
- If no timestamp is known, return `null` or omit the field.
- If compilation occurred, return the real last compile timestamp.

Impact:
- The timestamp looks like bad data and is not useful for determining freshness.

Suggested fix:
- Use nullable timestamp semantics for unknown values.

## 11. Menu execution can report "found but could not be executed" without enough detail

Observed:
- `execute_menu_item` for `Edit/Play` returned `Menu item found but could not be executed (may be disabled or context-dependent)`.
- This is probably correct in context, but the response did not expose why Unity rejected it.

Expected:
- When Unity can identify enabled/disabled state, include it.

Impact:
- Agents cannot distinguish unsupported menu items, disabled state, or wrong editor context.

Suggested fix:
- Add menu enabled/validation status when available.

## Reliable test workaround used

Until these are fixed, this sequence worked:

1. `list_unity_instances` with explicit `projectPath`.
2. `ping`.
3. `wait_for_compilation`.
4. `play_game`.
5. If the connection closes, rerun `list_unity_instances` with explicit `projectPath`.
6. `get_editor_state`.
7. If `Time.frameCount` does not advance, call `pause_game` and then `pause_game` again.
8. Use project-side menu hooks for runtime snapshots and camera capture.
9. Use `stop_game`, then poll `get_editor_state` until `isPlaying: false`.

## Retest After Main Update

Retested: 2026-06-14
Unity project package lock: `8b624273f40b51c90c5e84f3be0102841cd15976`
Resolved package cache: `Library/PackageCache/com.unity.editor-mcp@16418925059f`
Reported package version: `0.15.5`

Status summary:

1. `play_game` connection-close error: not fixed.
   - `play_game` still returned `TOOL_ERROR` / `Connection closed`.
   - Re-running discovery showed Play Mode had started on a new endpoint.

2. `stop_game` stale state: not fixed.
   - `stop_game` returned `message: "Exited play mode"` while the returned state still had `isPlaying: true`.
   - A follow-up `get_editor_state` returned `isPlaying: false`.

3. PlayerLoop stuck after Play Mode entry: fixed in this run / improved.
   - After reconnecting from the `play_game` connection close, `get_editor_state` reported `isPlayerLoopAdvancing: true`.
   - `frameCount` and `time` were advancing without the old pause/resume workaround.
   - `get_editor_state` now exposes `frameCount`, `time`, `realtimeSinceStartup`, `timeScale`, and `isPlayerLoopAdvancing`.

4. Game View screenshot failure: fixed.
   - `capture_screenshot` with `captureMode: "game"` succeeded.
   - Response: `Game View screenshot captured via Camera fallback`.

5. Scene screenshot ambiguity: improved.
   - `capture_screenshot` with `captureMode: "scene"` still captures Scene View, but now returns explicit `captureMode: "scene"`, a Scene View message, and camera position/rotation.

6. Parallel component calls timeout: not fixed.
   - Parallel `list_components` and `get_component_values` both timed out after 30 seconds.
   - The same calls worked immediately when run sequentially.

7. Noisy registry/discovery output: not fixed.
   - `list_unity_instances` still returned stale/duplicate current-project records and old project records.
   - Explicit `projectPath` selection still chose the correct endpoint.

8. Port fallback logged as error: not reproduced after update.
   - Clean log scan after retest did not show the previous MCP port-fallback error.

9. MCP internal command logging noise: fixed in this run.
   - `enhanced_read_logs` no longer returned MCP internal command processing logs as warnings after a clean run.

10. Placeholder compilation timestamp: fixed.
   - `wait_for_compilation` now returned `lastCompilationTime: null`, not `0001-01-01T00:00:00.0000000`.

11. Generic menu execution failure detail: not fixed.
   - `execute_menu_item` for `Edit/Play` still returned `Menu item found but could not be executed (may be disabled or context-dependent)` without more detail.

Current remaining blockers from this retest:
- Play Mode transition response/reconnect semantics.
- Stop Play Mode final-state polling.
- Concurrent command handling.
- Discovery result cleanup/compactness.
- Menu failure diagnostics.

## Fix Iteration 2 Checklist

Implementation target:
- Add retrying Play Mode verification after reload-related disconnects.
- Verify Stop Play Mode final state before returning success.
- Coalesce concurrent Node-side Unity connection attempts and reject queued commands on connection close.
- Make `list_unity_instances` compact by default while preserving `compact: false` verbose output.
- Add server metadata to `ping` and `list_unity_instances` for retest source verification.
- Add structured menu failure diagnostics and recommended MCP tool hints.

Manual retest checklist after this iteration:
1. Restart the MCP server/client session so the Node process loads this commit.
2. Call `ping` and confirm `structuredContent.server.gitHead` matches the new commit.
3. Call `play_game` from Edit Mode and confirm it returns success with verified `state.isPlaying: true`.
4. Call `stop_game` and confirm the returned state has `isPlaying: false`.
5. Run parallel `list_components` and `get_component_values` and confirm both return or fail independently without hanging until the client timeout.
6. Call default `list_unity_instances` and confirm it is compact, selected-endpoint focused, and shows stale counts instead of full stale records.
7. Call `execute_menu_item` for `Edit/Play` and confirm diagnostics include `validationStatus`, `reasonCode`, `editorState`, and `recommendedTool`.
