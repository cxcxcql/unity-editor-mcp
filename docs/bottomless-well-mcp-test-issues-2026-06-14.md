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

## Retest During Gameplay Sprite Fix

Retested: 2026-06-14
Unity MCP server checkout: `1849369`
Unity MCP server package version: `1.4.0`
Unity project package version: `0.15.5`

Status summary:

1. Hosted Codex MCP transport: not fixed.
   - `list_unity_instances` and `ping` through the hosted `mcp__unity_editor_mcp` tool both failed immediately with `Transport closed`.
   - Workaround was to import and run handlers directly from `/Users/ozan/Projects/unity-mcp/mcp-server/src`.

2. `wait_for_compilation` domain-reload reconnect: not fixed.
   - `refresh_assets` triggered compilation successfully.
   - During compile wait, Unity disconnected on domain reload.
   - Reconnect failed with `LOCAL_WORKSPACE_MISMATCH` and empty candidates even though the same editor re-registered shortly after.
   - A fresh `list_unity_instances` call then selected the correct endpoint, and raw `get_compilation_state` showed zero errors/warnings.

3. Focused EditMode test run: improved / usable in this run.
   - `run_tests` started a single EditMode test and `get_test_results` eventually returned `total: 1`, `passed: 1`, `failed: 0`.
   - The result payload still reported `isRunning: true` even after the passed summary was available.

4. Play Mode transition: improved but still noisy.
   - Direct `PlayToolHandler` recovered from the expected Play Mode connection close and returned `Entered play mode after reconnect`.
   - Recovery needed 6 attempts and included one `LOCAL_WORKSPACE_MISMATCH` plus one 1-second `get_editor_state` timeout before succeeding.

5. `stop_game` final-state polling: fixed in this direct-handler run.
   - `StopToolHandler` returned `polledUntilFinalState: true`.
   - Final state correctly reported `isPlaying: false`.

6. Camera screenshot capture: fixed / usable.
   - `capture_screenshot` with `captureMode: "camera"` and `cameraName: "Main Camera"` saved a 1280x720 PNG successfully.

7. Runtime log reads: usable in this run.
   - `read_logs` for `Error` and `Exception` returned zero logs after the Play Mode screenshot check.

## Retest After Main Update 2

Retested: 2026-06-14
Unity project package lock: `09b229294c4055d2d4f08c96f59246d3410f76d4`
Resolved package cache: `Library/PackageCache/com.unity.editor-mcp@70b92bcf78fa`
Reported package version: `0.15.5`

Setup:
- Local MCP repo `/Users/ozan/Projects/unity-mcp` was already at `09b229294c4055d2d4f08c96f59246d3410f76d4`; `git pull --ff-only` returned `Already up to date`.
- Unity package lock in `/Users/ozan/UnityProjects/Github/bottomless-well/Packages/packages-lock.json` was updated from `8b624273f40b51c90c5e84f3be0102841cd15976` to `09b229294c4055d2d4f08c96f59246d3410f76d4`.
- Unity refreshed cleanly and `wait_for_compilation` returned zero errors/warnings with `lastCompilationTime: null`.

Status summary:

1. `play_game` connection-close error: still not fixed.
   - `play_game` returned `TOOL_ERROR` / `Connection closed`.
   - The Unity Editor log shows MCP internally processed command `play_game` and sent a success response with message `Entered play mode`, but the tool client still received a connection-closed error.

2. Command path after Play Mode entry: regressed / blocking.
   - After reconnecting to the new endpoint, `get_editor_state`, `ping`, and `stop_game` all timed out.
   - Registry discovery continued to show the instance as alive and `lastSeen` continued updating.
   - Unity menu inspection showed the editor was back in Edit Mode after using `Edit > Play Mode > Play`, but MCP commands still timed out.
   - Triggering `Assets > Refresh` through Unity UI did not recover the MCP command path.

3. Registry/discovery output: still noisy.
   - `list_unity_instances` still returned stale/duplicate current-project asset-worker entries and old project records.

4. Further checks blocked.
   - Could not retest Game View screenshot, parallel component calls, log filtering, or `stop_game` final-state behavior after the latest update because the MCP command path remained wedged after Play Mode entry.

Immediate suspected problem:
- The latest package can accept TCP clients and update the registry heartbeat, but after the Play Mode transition it does not process/respond to normal commands.
- The Editor log shows accepted client connections after the transition without corresponding `Received command` / `Processing command` / `Sending response` entries for timed-out client calls.


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

## Fix Iteration 3 Notes

Root cause found after Retest After Main Update 2:
- During Play Mode reload, Unity asset import worker processes registered as MCP instances with `isBatchMode: true`, `packageVersion: "unknown"`, and fresh heartbeats.
- Discovery could select or promote those batch-mode worker endpoints during reconnect. They accepted TCP connections but did not process normal MCP commands, which matched the observed post-play command timeouts.
- Recovery also treated explicit project-path discovery gaps during reload as fatal instead of retryable.

Implementation target:
- Exclude batch-mode registry entries from default discovery selection and stale exact-match promotion.
- Keep `includeStale: true` / `compact: false` available for diagnostics, but hide batch-mode entries from default compact output and summarize them in `hiddenCounts`.
- Mark explicit selector misses as `NO_UNITY_INSTANCE` so Play Mode recovery keeps polling through the transient registry gap.
- Clear cached endpoint metadata when an established socket closes so reconnects rediscover the current editor endpoint.

Verification completed locally:
- `node --test tests/unit/core/unityDiscovery.test.js tests/unit/handlers/PlayToolHandler.test.js tests/unit/core/unityConnection.test.js tests/unit/handlers/ListUnityInstancesToolHandler.test.js`
- `npm run test:unit`
- `npm run test:ci`
- `git diff --check`
- Live Bottomless Well play/stop script:
  - selected `isBatchMode: false`, `packageVersion: "0.15.5"` endpoint.
  - `play_game` recovered through a transient `NO_UNITY_INSTANCE` reconnect gap and returned verified `state.isPlaying: true`.
  - `stop_game` returned verified `state.isPlaying: false`.
  - default compact `list_unity_instances` showed only the interactive Bottomless Well editor and summarized hidden batch/stale records.

Manual retest checklist after restarting the MCP client:
1. Call `ping` and confirm `structuredContent.server.gitHead` matches the next commit.
2. Call default `list_unity_instances`; confirm it lists one live interactive Bottomless Well instance, no full stale old-project records, and `hiddenCounts.batchMode > 0` if asset workers are present.
3. Call `play_game`; confirm it returns success with verified `state.isPlaying: true`, even if Unity reloads the MCP package and closes the first socket.
4. Call `get_editor_state` immediately after `play_game`; confirm it responds and reports the live Play Mode state.
5. Call `stop_game`; confirm the returned state has `isPlaying: false`.
6. Re-run the parallel component read scenario to confirm the single connection queue still serializes commands without choosing an asset-worker endpoint.

## Retest After Main Update 3

Retested: 2026-06-14
MCP repo commit: `cd062eb72e811704140ce2c8624b6c0da327da02`
Unity project package lock: `cd062eb72e811704140ce2c8624b6c0da327da02`
Resolved package cache: `Library/PackageCache/com.unity.editor-mcp@19643bb097dd`
Reported Unity package version: `0.15.5`
Reported MCP server: `unity-editor-mcp` `1.4.0`, `gitHead: cd062eb`, pid `54993`

Setup:
- Local MCP repo `/Users/ozan/Projects/unity-mcp` was clean and matched `origin/main` at `cd062eb72e811704140ce2c8624b6c0da327da02`.
- Unity package lock in `/Users/ozan/UnityProjects/Github/bottomless-well/Packages/packages-lock.json` was updated from `09b229294c4055d2d4f08c96f59246d3410f76d4` to `cd062eb72e811704140ce2c8624b6c0da327da02`.
- Unity resolved the package to `Library/PackageCache/com.unity.editor-mcp@19643bb097dd`.
- `ping`, `wait_for_compilation`, and `get_editor_state` worked before the Play Mode regression checks. Compilation reported zero errors/warnings and `lastCompilationTime: null`.

Status summary:

1. Server/source metadata: fixed.
   - `ping` and `list_unity_instances` both reported server metadata with package `unity-editor-mcp`, version `1.4.0`, and `gitHead: cd062eb`.

2. Discovery compactness and batch-worker filtering: improved.
   - Default compact `list_unity_instances` selected the live non-batch Bottomless Well editor.
   - Batch/stale records were summarized in `staleCounts` / `hiddenCounts` instead of dominating the output.
   - After a Play Mode reload, discovery selected the new interactive editor endpoint on port `63509`, not the stale batch-mode port `6400`.

3. `play_game` command result: still not fixed.
   - From Edit Mode, `play_game` reproducibly returned `LOCAL_WORKSPACE_MISMATCH`.
   - Despite the error response, Unity did enter Play Mode and registered a fresh listener on a new port.
   - Immediate `get_editor_state` sometimes returned `Unity connection not available` during the listener handoff, but recovered after a short delay/serial retry.
   - This is an improvement over raw `Connection closed`, but the command still reports failure while causing the state transition.

4. Command path after Play Mode entry: improved.
   - After the transient listener handoff, `ping` connected to the new endpoint and `get_editor_state` reported `isPlaying: true` with `isPlayerLoopAdvancing: true`.
   - `capture_screenshot` with `captureMode: "game"` succeeded and saved `Assets/_Project/Screenshots/mcp-game-tool-regression-cd062.png`.

5. Parallel component calls: fixed in this retest.
   - Parallel `list_components` on `/GameRoot/WellRoot` and `get_component_values` for `WellController` both returned successfully.
   - `get_component_values` returned the expected `State: Idle` and `IsBusy: false` values.

6. `stop_game` final-state polling: fixed in this retest.
   - `stop_game` returned success with `isPlaying: false`, `isPlayerLoopAdvancing: false`, `polledUntilFinalState: true`, and `attempts: 1`.
   - A follow-up `get_editor_state` also reported Edit Mode.

7. Menu failure diagnostics: improved but still noisy.
   - `execute_menu_item` for `Edit/Play` returned structured fields: `validationStatus: "not_executed"`, `reasonCode: "EXECUTE_MENU_ITEM_FALSE"`, `editorState`, and `recommendedTool: "stop_game"`.
   - The Unity console still logged this failed menu execution as error entries, including `ExecuteMenuItem failed because there is no menu named 'Edit/Play'`.

8. Log filtering / classification: still has issues.
   - After clearing the console before a clean Play/Stop cycle, `enhanced_read_logs` still reported MCP internal command-processing logs when `excludeMcpInternal: false`; this is expected for diagnostics but very noisy.
   - The port fallback warning (`Port 6400 is already in use. Falling back to an available loopback port.`) was still returned with `logType: "Error"` even though it is logged through `Debug.LogWarning`.
   - Stack traces for current MCP logs referenced the old package cache path `com.unity.editor-mcp@70b92bcf78fa`, even though the lock and current `Library/PackageCache` resolved to `com.unity.editor-mcp@19643bb097dd`. This may be stale compiled debug metadata or a Unity domain/package reload issue, but it complicates verification.

Current remaining blockers from this retest:
- `play_game` returns `LOCAL_WORKSPACE_MISMATCH` while still entering Play Mode.
- Immediate state calls can transiently report `Unity connection not available` during the Play Mode listener handoff.
- Warning/error log classification still mislabels at least the port fallback warning as an error.
- Runtime MCP stack traces still point at the old package-cache path after the package lock resolves to the new commit.

## Fix Iteration 4 Notes

Root causes found after Retest After Main Update 3:
- `play_game` entered Play Mode, then the Node recovery loop failed during the reload handoff because `LOCAL_WORKSPACE_MISMATCH` was treated as fatal. During domain/package reload this can be a transient discovery artifact, like `NO_UNITY_INSTANCE`.
- `get_editor_state` still threw `Unity connection not available` before trying to reconnect, unlike most non-playmode handlers.
- `execute_menu_item` for `Edit/Play` was a known recommended-tool alias, but Unity still invoked `EditorApplication.ExecuteMenuItem("Edit/Play")`, which caused Unity to emit an internal menu error.
- Enhanced console log severity classification checked error/exception mode bits before warning bits. Unity warning entries can carry extra scripting bits, so expected warnings such as port fallback could be surfaced as errors.

Implementation target:
- Treat `LOCAL_WORKSPACE_MISMATCH` as recoverable only inside the Play Mode recovery polling path.
- Make `get_editor_state` use the existing reconnect/poll helper so immediate state calls can survive listener handoff.
- Short-circuit `Edit/Play` menu execution with `USE_RECOMMENDED_TOOL` diagnostics and avoid calling Unity's menu API for that alias.
- Prefer warning mode bits in enhanced log classification and emit the expected port-fallback warning without a stack trace.

Verification completed locally:
- Added failing Node regression tests for Play Mode recovery through `LOCAL_WORKSPACE_MISMATCH` and `get_editor_state` reconnecting through transient handoff failures.
- `node --test tests/unit/handlers/PlayToolHandler.test.js tests/unit/handlers/GetEditorStateToolHandler.test.js tests/unit/handlers/StopToolHandler.test.js tests/unit/handlers/PauseToolHandler.test.js`
- `npm run test:unit`
- `npm run test:ci`
- `git diff --check`
- Live Bottomless Well check using the local Node handlers:
  - `play_game` recovered after Unity closed the first socket and returned verified `state.isPlaying: true`.
  - immediate `get_editor_state` after `play_game` returned Play Mode state with `isPlayerLoopAdvancing: true`.
  - `stop_game` returned verified `state.isPlaying: false`.

Unity-side verification status:
- Added focused Unity EditMode regression tests for `Edit/Play` recommended-tool diagnostics and enhanced log warning classification.
- These Unity-side changes require the Bottomless Well project to refresh to the next package commit before live MCP retesting; the currently open project is still using the previous package cache while this fix is uncommitted.

Manual retest checklist after committing, pushing, and refreshing the Unity package lock:
1. Restart the MCP client and confirm `ping.structuredContent.server.gitHead` matches the next commit.
2. Call `play_game`; confirm it returns success, not `LOCAL_WORKSPACE_MISMATCH`, with verified `state.isPlaying: true`.
3. Immediately call `get_editor_state`; confirm it reconnects if needed and returns the live Play Mode state.
4. Call `execute_menu_item` for `Edit/Play`; confirm it returns `reasonCode: "USE_RECOMMENDED_TOOL"` and does not add Unity console errors about a missing `Edit/Play` menu.
5. Trigger or inspect the port fallback warning; confirm enhanced logs classify it as `Warning`, not `Error`.

## Retest After Main Update 4

Retested: 2026-06-14
MCP repo commit: `666ef0eaa8459e55ca38b16471af0deceb6e8f5b`
Unity project package lock: `666ef0eaa8459e55ca38b16471af0deceb6e8f5b`
Resolved package cache after final Unity refresh: `Library/PackageCache/com.unity.editor-mcp@6ea1473eaf78`
Reported Unity package version: `0.15.5`
Reported MCP server from direct handler run: `unity-editor-mcp` `1.4.0`, `gitHead: 666ef0e`

Setup:
- Local MCP repo `/Users/ozan/Projects/unity-mcp` matched `origin/main` at `666ef0eaa8459e55ca38b16471af0deceb6e8f5b`.
- The Bottomless Well lock file was updated from `cd062eb72e811704140ce2c8624b6c0da327da02` to `666ef0eaa8459e55ca38b16471af0deceb6e8f5b`.
- Unity initially kept the old package cache `com.unity.editor-mcp@19643bb097dd`; after another package refresh it resolved to `com.unity.editor-mcp@2de6ad95343f`, which contains the new `USE_RECOMMENDED_TOOL` menu diagnostics code.
- The Codex-hosted MCP tool process still reported old server metadata (`gitHead: cd062eb`, pid `54993`) after the repo pull. Terminating that process closed the Codex MCP transport; `tool_search` re-exposed the tool definitions, but calls still failed with `Transport closed`.
- Because the Codex MCP transport did not recover in-session, live retests were run through the pulled repo's Node handler modules directly against the Unity TCP bridge from the Unity project cwd. This still exercised the updated Node code and the updated Unity package, but not the Codex MCP stdio host lifecycle.

Automated checks:
- Focused Node regression tests passed:
  - `node --test tests/unit/handlers/PlayToolHandler.test.js tests/unit/handlers/GetEditorStateToolHandler.test.js tests/unit/handlers/StopToolHandler.test.js tests/unit/handlers/PauseToolHandler.test.js tests/unit/handlers/menu/ExecuteMenuItemToolHandler.test.js tests/unit/handlers/console/EnhancedReadLogsToolHandler.test.js`
- Broad `npm test -- --runInBand` failed with 2 unit failures in `tests/unit/core/unityConnection.test.js`:
  - `should share one in-flight connection attempt between concurrent callers` failed with `Connection timeout`.
  - `should reject if the socket closes before connect completes` failed with `Missing expected rejection`.

Status summary:

1. Server/source metadata: fixed in direct handler run, but not in Codex MCP host after pull.
   - Direct `list_unity_instances` and `ping` reported `gitHead: 666ef0e`.
   - Codex MCP tools stayed bound to old pid `54993` and old `gitHead: cd062eb` until that process was killed; after that, this Codex session's MCP transport remained closed.

2. Unity package refresh: fixed after cache turnover.
   - The open Unity project eventually resolved `com.unity.editor-mcp@2de6ad95343f`.
   - That cache contains `MenuHandler` support for `reasonCode: "USE_RECOMMENDED_TOOL"`.

3. `play_game` command result: still not fixed.
   - Focused live run from Edit Mode returned `PLAY_MODE_RECOVERY_TIMEOUT`: `Timed out waiting for Unity to enter play mode after reconnect`.
   - Unity did enter Play Mode anyway.
   - Follow-up `get_editor_state` succeeded and reported `isPlaying: true`.
   - In both live runs, the first reconnect attempt during Play Mode reload saw transient `LOCAL_WORKSPACE_MISMATCH`, then a later reconnect found the new listener.
   - The handler appears to miss the successful post-reconnect state before its recovery timeout expires.

4. Immediate `get_editor_state`: improved.
   - After `play_game` returned the timeout, `get_editor_state` successfully reconnected and returned Play Mode state.
   - The first Play Mode state often reported `frameCount: 1`, `time: 0`, and `isPlayerLoopAdvancing: false`, even though the editor was in Play Mode.

5. `stop_game` final-state polling: still returns the correct final state, but can be slow.
   - Focused live run returned success with `isPlaying: false`, `polledUntilFinalState: true`, and `attempts: 1`.
   - It took about 10 seconds in the focused run.

6. `execute_menu_item` diagnostics: fixed.
   - `execute_menu_item` for `Edit/Play` returned `reasonCode: "USE_RECOMMENDED_TOOL"`, `recommendedTool: "play_game"`, `executed: false`, and `executionTime: 0`.
   - Follow-up `enhanced_read_logs` with warning/error/exception filters returned zero logs, so the previous missing-menu console error was not reproduced.

7. Screenshot / late-response framing: new or still-open issue.
   - `capture_screenshot` in Play Mode timed out after 30 seconds, but Unity later sent a success response and saved `Assets/_Project/Screenshots/mcp-game-tool-regression-666ef0e.png`.
   - Because the pending command had already been rejected, the late response was logged as an unsolicited message.
   - Subsequent queued component/log commands then timed out and the client logged invalid frame recovery errors such as `Invalid message length` and `Unable to recover from invalid frame, clearing buffer`.
   - This suggests late responses after command timeout can desynchronize the framing buffer and poison later commands on the same socket.

8. Parallel component reads: inconclusive in full live run due to screenshot-induced framing issue.
   - `list_components` and `get_component_values` timed out after the screenshot timeout/late response sequence.
   - This should be retested separately once the late-response/framing issue is fixed or with screenshot omitted.

Cleanup:
- The broad integration test created `/IntegrationTestCube`; it was deleted after the live retest and a follow-up find returned zero objects.
- Unity was left in Edit Mode with `isPlaying: false`.

Current remaining blockers from this retest:
- Codex MCP host does not automatically reload/rebind after the old MCP server process is terminated; this blocked in-session tool use after refreshing the repo.
- `play_game` still returns a failure (`PLAY_MODE_RECOVERY_TIMEOUT`) even though Unity enters Play Mode and subsequent state calls can see it.
- Late responses after a command timeout can corrupt or desynchronize subsequent command framing.
- Broad test suite has two failing `unityConnection` unit tests around concurrent connection lifecycle behavior.

## Fix Iteration 5 Notes

Root causes found after Retest After Main Update 4:
- `play_game` recovery could spend the full recovery window inside a stuck `get_editor_state` command because the state-poll command inherited the normal Unity command timeout.
- `capture_screenshot` can legitimately take longer than the default command timeout in Play Mode, so the Node server timed out first, kept using the same socket, and then treated Unity's late success response as unsolicited data.
- After a command timeout, queued commands were still allowed to run on a socket whose pending response stream was no longer trustworthy.
- `UnityConnection` tests disabled auto-reconnect through a process-wide environment variable, which leaked across parallel test files and broke retry tests.
- The unit mock socket closed whatever object was in the shared `mockSocket` variable when its delayed `destroy()` callback fired, so a previous test could close the next test's fresh connection.

Implementation target:
- Add per-command timeout options to `UnityConnection.sendCommand`.
- Bound Play Mode recovery `get_editor_state` polls to a short per-command timeout and retry `COMMAND_TIMEOUT` as a recoverable Play Mode handoff error.
- Give `capture_screenshot` a longer command timeout (`90000ms`) so slow Unity screenshot capture does not trip the default command timeout.
- Treat command timeout as a poisoned bridge state: reject the active command with `COMMAND_TIMEOUT`, close/destroy the socket, clear framing state, reject queued commands, and require a fresh connection for later work.
- Replace the process-wide unit-test reconnect toggle with per-instance `autoReconnect: false` test config.
- Fix the mock socket so delayed `destroy()` closes its own captured socket instance.

Verification completed locally:
- `node --test tests/unit/core/compilationWait.test.js tests/unit/core/unityConnection.retry.test.js tests/unit/core/unityConnection.test.js tests/unit/handlers/GetEditorStateToolHandler.test.js`
- `node --test tests/unit/core/unityConnection.test.js tests/unit/handlers/CaptureScreenshotToolHandler.test.js tests/unit/handlers/PlayToolHandler.test.js`
- `npm run test:unit`
- `npm run test:ci`
- `npm test -- --runInBand`
- `git diff --check`

Manual retest checklist after committing, pushing, refreshing the Unity package lock, and restarting the MCP client:
1. Confirm `ping.structuredContent.server.gitHead` matches the next commit.
2. Call `play_game` from Edit Mode and confirm it returns success with verified `state.isPlaying: true`.
3. Immediately call `get_editor_state` and confirm it survives any listener handoff and returns Play Mode state.
4. Call `capture_screenshot` in Play Mode and confirm it returns success without poisoning the socket.
5. Immediately after the screenshot, run parallel component/log reads and confirm they execute sequentially on a healthy fresh or existing connection.
6. Run `npm test -- --runInBand` from `mcp-server` and confirm the previous two `unityConnection` failures remain fixed.

Known remaining non-code retest constraint:
- Existing Codex MCP stdio processes still need a client/session restart to load the newly pushed server commit; this iteration adds source metadata and fixes server behavior, but it does not change Codex host process lifecycle.

## Retest After Main Update 5

Retested: 2026-06-14
MCP repo commit: `5b638e1ab10050b30e54014225068da4b0795617`
Unity project package lock: `5b638e1ab10050b30e54014225068da4b0795617`
Resolved package cache after final Unity refresh: `Library/PackageCache/com.unity.editor-mcp@6ea1473eaf78`
Reported Unity package version: `0.15.5`
Reported MCP server from direct handler run: `unity-editor-mcp` `1.4.0`, `gitHead: 5b638e1`

Setup:
- Local MCP repo `/Users/ozan/Projects/unity-mcp` matched `origin/main` at `5b638e1ab10050b30e54014225068da4b0795617`.
- The Bottomless Well lock file was updated from `666ef0eaa8459e55ca38b16471af0deceb6e8f5b` to `5b638e1ab10050b30e54014225068da4b0795617`.
- Unity refreshed cleanly and reported zero compile errors/warnings.
- Unity ultimately resolved the package to `com.unity.editor-mcp@6ea1473eaf78`. The relevant fixes in this iteration are Node server-side.
- The Codex-hosted MCP tool transport was still closed (`Transport closed`) after the previous retest killed the stale stdio server process, so live retests were again run through the pulled repo's Node handler modules directly against the Unity TCP bridge.

Automated checks run in this pass:
- `node --test tests/unit/core/unityConnection.test.js tests/unit/handlers/CaptureScreenshotToolHandler.test.js tests/unit/handlers/PlayToolHandler.test.js tests/unit/handlers/GetEditorStateToolHandler.test.js`
- Result: 61 passed, 0 failed, 1 skipped.
- This includes the two previously failing `unityConnection` tests:
  - `should share one in-flight connection attempt between concurrent callers`
  - `should reject if the socket closes before connect completes`
- The full `npm test -- --runInBand` suite was not rerun in this pass to avoid further loading the already overloaded desktop; the targeted failure and live regression paths were covered.

Status summary:

1. Server/source metadata: fixed in direct handler run.
   - `list_unity_instances` and `ping` both reported `gitHead: 5b638e1`.
   - Discovery selected the non-batch Bottomless Well editor endpoint and continued summarizing stale/batch entries through `hiddenCounts`.

2. `play_game` command result: fixed in this retest.
   - `play_game` returned success: `Entered play mode after reconnect`.
   - Recovery survived the initial socket close, a transient `LOCAL_WORKSPACE_MISMATCH`, and two short `get_editor_state` command timeouts.
   - Final verified state had `isPlaying: true`.
   - Immediate follow-up `get_editor_state` returned `isPlaying: true` and `isPlayerLoopAdvancing: true`.

3. Screenshot timeout / late-response poisoning: fixed in this retest.
   - `capture_screenshot` in Play Mode used the extended `90000ms` timeout and returned success in about 9.5 seconds.
   - Screenshot saved: `Assets/_Project/Screenshots/mcp-game-tool-regression-5b638e1.png`.
   - No late-response/invalid-frame poisoning occurred after the screenshot command.

4. Parallel component/log reads after screenshot: fixed in this retest.
   - Parallel `list_components`, `get_component_values`, and `enhanced_read_logs` all returned successfully after screenshot capture.
   - `list_components` found `Transform`, `SpriteRenderer`, `BoxCollider2D`, and `WellController`.
   - `get_component_values` returned `State: Idle` and `IsBusy: false`.

5. `stop_game` final-state polling: fixed in this retest.
   - `stop_game` returned success with `isPlaying: false`, `isPlayerLoopAdvancing: false`, `polledUntilFinalState: true`, `attempts: 1`.
   - Follow-up `get_editor_state` also reported Edit Mode.

6. New Unity-side log findings during the run.
   - `enhanced_read_logs` returned 6 warning/error/exception entries after screenshot and component reads:
     - `Ignoring depth surface store action as it is memoryless`
     - `Ignoring depth surface load action as it is memoryless`
     - Immutable package warning/exception: `Packages/com.unity.editor-mcp/package.json` and `Packages/com.unity.editor-mcp` were reported as unexpectedly altered.
     - Missing package folder metadata warning/error: `Packages/com.unity.editor-mcp/Editor/Tools/Scene` was recreated from a `.meta`.
     - `AssetImportWorker0` crashed.
     - `AssetImportWorker4` crashed.
   - These did not break the MCP command stream in this run, but they should be investigated separately because they indicate Unity package/cache/import-worker instability.

Current remaining blockers from this retest:
- Codex MCP stdio transport still does not recover/rebind inside the current Codex session after the stale server process is terminated.
- Unity logged immutable package/cache mutation and missing-folder metadata errors for `com.unity.editor-mcp`.
- Unity asset import workers crashed during the retest.
- Full `npm test -- --runInBand` was not rerun in this pass due machine load; targeted unit tests and live regression checks passed.

## Fix Iteration 6 Notes

Root causes found after Retest After Main Update 5:
- The package contained a tracked empty-folder metadata file: `unity-editor-mcp/Editor/Tools/Scene.meta`.
- The corresponding `Editor/Tools/Scene` folder had no tracked content. Git package resolution can include the `.meta` without a real folder payload, so Unity recreates the missing folder under `PackageCache` and then reports immutable package/package metadata mutation.
- The asset import worker crashes happened in the same run as the package-cache mutation. This iteration removes the package-layout trigger and adds a regression test; the crashes still need one more Unity refresh retest to confirm they disappear.
- The full `npm test -- --runInBand` gap was verification debt, not a separate product bug.
- The Codex MCP stdio transport lifecycle is still outside this repo's runtime control: once the hosting client keeps or kills an already-started stdio server, the MCP server cannot force the client to reinitialize it from new source code. The supported mitigation remains restarting the MCP client/session and using `ping.structuredContent.server.gitHead` to confirm the loaded commit.

Implementation target:
- Remove the orphan tracked `unity-editor-mcp/Editor/Tools/Scene.meta`.
- Add a Node package-layout regression test that fails when the Unity package tracks folder `.meta` files for empty package directories.
- Re-run the full `npm test -- --runInBand` verification that was skipped in the previous retest.

Verification completed locally:
- `node --test tests/unit/core/packageLayout.test.js` failed before the fix with `unity-editor-mcp/Editor/Tools/Scene.meta`.
- `node --test tests/unit/core/packageLayout.test.js`
- `npm run test:unit`
- `npm test -- --runInBand`
- `npm run test:ci`

Manual retest checklist after committing, pushing, refreshing the Unity package lock, and restarting the MCP client:
1. Confirm `ping.structuredContent.server.gitHead` matches the next commit.
2. Refresh the Bottomless Well package lock to the next commit and force Unity package resolution.
3. Confirm Unity no longer logs immutable package mutations for `Packages/com.unity.editor-mcp/package.json` or `Packages/com.unity.editor-mcp`.
4. Confirm Unity no longer logs recreation of `Packages/com.unity.editor-mcp/Editor/Tools/Scene` from a `.meta`.
5. Confirm `AssetImportWorker` crashes do not recur during package refresh plus the Play/Screenshot/component-read flow.
6. Run `npm test -- --runInBand` from `mcp-server` and confirm it stays green.

Known remaining non-code retest constraint:
- Restart the MCP client/session after pulling the next commit; a running stale stdio MCP process cannot be re-bound by repository changes alone.

## Retest After Main Update 6

Retested: 2026-06-14
MCP repo commit: `18493695354370df0b4c77e4507b01ac307e163b`
Unity project package lock: `18493695354370df0b4c77e4507b01ac307e163b`
Resolved package cache after forced package refresh: `Library/PackageCache/com.unity.editor-mcp@f80e542956e4`
Reported Unity package version: `0.15.5`
Reported MCP server from direct handler run: `unity-editor-mcp` `1.4.0`, `gitHead: 1849369`

Setup:
- Local MCP repo `/Users/ozan/Projects/unity-mcp` matched `origin/main` at `18493695354370df0b4c77e4507b01ac307e163b`; `git pull --ff-only` returned already up to date.
- The Bottomless Well lock file was updated from `5b638e1ab10050b30e54014225068da4b0795617` to `18493695354370df0b4c77e4507b01ac307e163b`.
- The package cache was deleted and Unity re-resolved the package to `com.unity.editor-mcp@f80e542956e4`.
- The Codex-hosted MCP stdio transport still failed with `Transport closed`, including `ping` and `list_unity_instances`, so live retests were run through the pulled repo's Node handler modules directly against the Unity TCP bridge.

Automated checks:
- `node --test tests/unit/core/packageLayout.test.js` failed.
  - Expected no empty-folder metadata files.
  - Actual: `unity-editor-mcp/Editor/Tools.meta`.
- `npm test -- --runInBand` failed with the same single failure.
  - Summary: 579 tests, 577 passed, 1 failed, 1 skipped.
  - The previous `Editor/Tools/Scene.meta` failure is gone; the remaining package-layout failure is now `Editor/Tools.meta`.

Live MCP checks:
- Initial forced package refresh caused a temporary discovery failure:
  - Direct `list_unity_instances` saw only stale/dead or batch-mode Bottomless Well records and returned `LOCAL_WORKSPACE_MISMATCH`.
  - Direct `get_editor_state` returned `EDITOR_STATE_RECOVERY_TIMEOUT`.
  - `Editor.log` showed the old package shutting down and the new package registered, but no fresh non-batch listener immediately after domain reload.
- A manual Unity `Assets > Refresh` restored the listener.
  - Direct discovery then selected the live non-batch Bottomless Well editor, pid `47089`, port `6400`, package `0.15.5`.
  - `ping` succeeded and reported `gitHead: 1849369`.
  - `wait_for_compilation` completed with `errorCount: 0`, `warningCount: 0`, and no messages.
  - `play_game` succeeded after reconnect recovery and verified `state.isPlaying: true`.
  - Immediate `get_editor_state` returned `isPlaying: true` and `isPlayerLoopAdvancing: true`.
  - `capture_screenshot` in Play Mode succeeded in about 0.7s via Camera fallback at 1280x720.
  - `read_logs` for `Error` returned zero entries.
  - `stop_game` returned verified Edit Mode with `state.isPlaying: false`.
  - Final `read_logs` for `Warning`, `Error`, and `Exception` returned zero entries.

Package/cache findings:
- `Library/PackageCache/com.unity.editor-mcp@f80e542956e4` no longer contains `Editor/Tools/Scene.meta`.
- The same cache still contains `Editor/Tools.meta`.
- `git ls-files 'unity-editor-mcp/**/*.meta'` in the MCP repo also identifies `unity-editor-mcp/Editor/Tools.meta` as a tracked empty-folder metadata file.
- During package refresh, `Editor.log` reported immutable package mutation warnings and listed `Packages/com.unity.editor-mcp/Editor/Tools`; this lines up with the remaining `Editor/Tools.meta` package-layout failure.

Cleanup:
- The full integration test created `/IntegrationTestCube`; cleanup through direct MCP `find_gameobject` / `delete_gameobject` removed it and a final find returned zero objects.
- Screenshot capture wrote `Assets/Screenshots/screenshot_game_2026-06-14_18-24-26.png` despite `encodeAsBase64: true`; the generated PNG, `.meta`, and empty `Assets/Screenshots.meta` were removed.
- Unity was left in Edit Mode with `isPlaying: false`.

Current remaining blockers from this retest:
- The package-layout fix is incomplete: `unity-editor-mcp/Editor/Tools.meta` is still tracked for an empty package directory and fails the new regression test.
- Unity's listener did not immediately re-advertise after forced package cache resolution/domain reload; manual `Assets > Refresh` restored it. This should be treated as a package reload lifecycle issue unless it is expected Unity behavior.
- The Codex MCP stdio transport still cannot recover inside this existing Codex session after the stale server process was killed; direct Node handlers work, but hosted MCP tool calls still fail with `Transport closed`.

## Fix Iteration 7 Notes

Root causes found after Retest After Main Update 6:
- The previous package-layout fix removed `unity-editor-mcp/Editor/Tools/Scene.meta`, but the parent empty folder metadata `unity-editor-mcp/Editor/Tools.meta` remained tracked.
- Because `Editor/Tools` has no tracked package content, Unity recreated that folder in the immutable Git package cache and continued reporting package/cache mutation warnings.
- The existing `packageLayout.test.js` correctly caught this remaining metadata file, so no new production behavior was needed for the package-layout issue.
- The listener re-advertise failure occurred during the same forced package-cache mutation/reimport cycle. The Unity startup code already writes the registry immediately when the listener starts and heartbeats afterward, so this remains a retest item after removing all empty package folder metadata rather than a speculative startup-code change.
- While verifying this iteration, `npm run test:unit` exposed a parallel-test isolation problem in `unityConnection.test.js`: it used the global `node:test` mock registry for socket spies, and other concurrently running test files can call `mock.restoreAll()`, restoring those spies while a connect test is still pending.
- The Codex MCP stdio transport issue remains a client/session lifecycle constraint outside the repo.

Implementation target:
- Remove `unity-editor-mcp/Editor/Tools.meta`.
- Remove the local empty `unity-editor-mcp/Editor/Tools/` directory from the checkout.
- Verify the package-layout regression now reports no tracked empty or missing folder `.meta` files.
- Replace `unityConnection.test.js` socket mocks with local spies so global `mock.restoreAll()` in other files cannot affect pending socket lifecycle assertions.

Verification completed locally:
- `node --test tests/unit/core/packageLayout.test.js` failed before the fix with `unity-editor-mcp/Editor/Tools.meta`.
- `node --test tests/unit/core/packageLayout.test.js`
- Repository scan reported `no tracked empty/missing folder metas`.
- `npm run test:unit` initially failed in `unityConnection.test.js` with the known concurrent connect/close tests; after local spy isolation it passed.

Manual retest checklist after committing, pushing, refreshing the Unity package lock, and restarting the MCP client:
1. Confirm `ping.structuredContent.server.gitHead` matches the next commit.
2. Refresh the Bottomless Well package lock to the next commit and force Unity package resolution.
3. Confirm Unity no longer logs immutable package mutations for `Packages/com.unity.editor-mcp`, `Packages/com.unity.editor-mcp/package.json`, or `Packages/com.unity.editor-mcp/Editor/Tools`.
4. Confirm Unity listener discovery recovers without requiring a manual `Assets > Refresh`; if it still does not, capture `Editor.log` timestamps around package resolution, assembly reload, `TCP listener started`, and registry writes.
5. Confirm `AssetImportWorker` crashes do not recur during package refresh plus the Play/Screenshot/component-read flow.
6. Run `npm test -- --runInBand` from `mcp-server` and confirm it stays green.
