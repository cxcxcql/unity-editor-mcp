using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEditorMCP.Models;
using UnityEditorMCP.Helpers;
using UnityEditorMCP.Logging;
using UnityEditorMCP.Handlers;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Core
{
    /// <summary>
    /// 管理 Unity MCP 的 TCP 连接和编辑器主线程命令执行。
    /// </summary>
    [InitializeOnLoad]
    public static class UnityEditorMCP
    {
        private static TcpListener tcpListener;
        /// <summary>尚未由主线程接管的请求，按接收顺序排列。</summary>
        private static readonly LinkedList<PendingCommand> m_listCommandQueue = new LinkedList<PendingCommand>();

        /// <summary>同步队列及连接内的取消索引。</summary>
        private static readonly object m_pQueueLock = new object();

        /// <summary>编辑器重入更新时，当前批命令是否仍在执行。</summary>
        private static bool m_bProcessingQueue;

        private static CancellationTokenSource cancellationTokenSource;
        private static Task listenerTask;
        private const double RegistryHeartbeatIntervalSeconds = 5.0;
        private static double lastRegistryWriteTime;
        private static int mainThreadId;
        private static volatile bool registryWritePending;
        private delegate object CommandHandlerDelegate(Command command);

        // 写类命令：执行成功后自动保存场景/prefab，避免脏状态累积导致后续切换阻塞
        private static readonly HashSet<string> WriteCommands =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "create_gameobject",
                "modify_gameobject",
                "delete_gameobject",
                "add_component",
                "remove_component",
                "modify_component",
                "instantiate_prefab",
                "batch_create_gameobjects",
                "batch_instantiate_prefab",
                "ares.scene.apply_transaction"
            };

        // 上下文切换类命令：执行前先保存当前场景/prefab，避免 Unity 弹未保存确认框阻塞
        private static readonly HashSet<string> ContextSwitchCommands =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "load_scene",
                "open_prefab",
                "exit_prefab_mode",
                "create_scene"
            };

        private static readonly Dictionary<string, CommandHandlerDelegate> CommandHandlers =
            new Dictionary<string, CommandHandlerDelegate>(StringComparer.OrdinalIgnoreCase)
            {
                { "ping", HandlePing },
                { "get_project_info", command => UnityInstanceRegistry.GetProjectInfo(currentPort, Status) },
                { "read_logs", command => HandleReadLogs(command.Parameters) },
                { "clear_logs", command => HandleClearLogs() },
                { "refresh_assets", command => HandleRefreshAssets() },
                { "create_gameobject", command => GameObjectHandler.CreateGameObject(command.Parameters) },
                { "find_gameobject", command => GameObjectHandler.FindGameObjects(command.Parameters, command.Id) },
                { "modify_gameobject", command => GameObjectHandler.ModifyGameObject(command.Parameters) },
                { "delete_gameobject", command => GameObjectHandler.DeleteGameObject(command.Parameters) },
                { "get_hierarchy", command => GameObjectHandler.GetHierarchy(command.Parameters) },
                { "create_scene", command => SceneHandler.CreateScene(command.Parameters) },
                { "load_scene", command => SceneHandler.LoadScene(command.Parameters) },
                { "save_scene", command => SceneHandler.SaveScene(command.Parameters) },
                { "list_scenes", command => SceneHandler.ListScenes(command.Parameters) },
                { "get_scene_info", command => SceneHandler.GetSceneInfo(command.Parameters) },
                { "get_gameobject_details", command => SceneAnalysisHandler.GetGameObjectDetails(command.Parameters) },
                { "analyze_scene_contents", command => SceneAnalysisHandler.AnalyzeSceneContents(command.Parameters) },
                { "get_component_values", command => SceneAnalysisHandler.GetComponentValues(command.Parameters) },
                { "find_by_component", command => SceneAnalysisHandler.FindByComponent(command.Parameters, command.Id) },
                { "get_object_references", command => SceneAnalysisHandler.GetObjectReferences(command.Parameters) },
                { "play_game", command => PlayModeHandler.HandleCommand("play_game", command.Parameters) },
                { "pause_game", command => PlayModeHandler.HandleCommand("pause_game", command.Parameters) },
                { "stop_game", command => PlayModeHandler.HandleCommand("stop_game", command.Parameters) },
                { "get_editor_state", command => PlayModeHandler.HandleCommand("get_editor_state", command.Parameters) },
                { "find_ui_elements", command => UIInteractionHandler.FindUIElements(command.Parameters) },
                { "click_ui_element", command => UIInteractionHandler.ClickUIElement(command.Parameters) },
                { "get_ui_element_state", command => UIInteractionHandler.GetUIElementState(command.Parameters) },
                { "set_ui_element_value", command => UIInteractionHandler.SetUIElementValue(command.Parameters) },
                { "simulate_ui_input", command => UIInteractionHandler.SimulateUIInput(command.Parameters) },
                { "create_prefab", command => AssetManagementHandler.CreatePrefab(command.Parameters) },
                { "modify_prefab", command => AssetManagementHandler.ModifyPrefab(command.Parameters) },
                { "instantiate_prefab", command => AssetManagementHandler.InstantiatePrefab(command.Parameters) },
                { "create_material", command => AssetManagementHandler.CreateMaterial(command.Parameters) },
                { "modify_material", command => AssetManagementHandler.ModifyMaterial(command.Parameters) },
                { "open_prefab", command => AssetManagementHandler.OpenPrefab(command.Parameters) },
                { "exit_prefab_mode", command => AssetManagementHandler.ExitPrefabMode(command.Parameters) },
                { "save_prefab", command => AssetManagementHandler.SavePrefab(command.Parameters) },
                { "create_script", command => ScriptHandler.CreateScript(command.Parameters) },
                { "read_script", command => ScriptHandler.ReadScript(command.Parameters) },
                { "update_script", command => ScriptHandler.UpdateScript(command.Parameters) },
                { "delete_script", command => ScriptHandler.DeleteScript(command.Parameters) },
                { "list_scripts", command => ScriptHandler.ListScripts(command.Parameters) },
                { "validate_script", command => ScriptHandler.ValidateScript(command.Parameters) },
                { "execute_menu_item", command => MenuHandler.ExecuteMenuItem(command.Parameters) },
                { "clear_console", command => ConsoleHandler.ClearConsole(command.Parameters) },
                { "enhanced_read_logs", command => ConsoleHandler.EnhancedReadLogs(command.Parameters) },
                { "capture_screenshot", command => ScreenshotHandler.CaptureScreenshot(command.Parameters) },
                { "analyze_screenshot", command => ScreenshotHandler.AnalyzeScreenshot(command.Parameters) },
                { "add_component", command => ComponentHandler.AddComponent(command.Parameters) },
                { "remove_component", command => ComponentHandler.RemoveComponent(command.Parameters) },
                { "modify_component", command => ComponentHandler.ModifyComponent(command.Parameters) },
                { "list_components", command => ComponentHandler.ListComponents(command.Parameters) },
                { "start_compilation_monitoring", command => CompilationHandler.StartCompilationMonitoring(command.Parameters) },
                { "stop_compilation_monitoring", command => CompilationHandler.StopCompilationMonitoring(command.Parameters) },
                { "get_compilation_state", command => CompilationHandler.GetCompilationState(command.Parameters) },
                { "manage_tags", command => TagManagementHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "manage_layers", command => LayerManagementHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "manage_selection", command => SelectionHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "manage_windows", command => WindowManagementHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "manage_tools", command => ToolManagementHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "manage_asset_import_settings", command => AssetImportSettingsHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "manage_asset_database", command => AssetDatabaseHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "analyze_asset_dependencies", command => AssetDependencyHandler.HandleCommand(GetAction(command), command.Parameters) },
                { "list_tests", command => TestRunnerHandler.ListTests(command.Parameters) },
                { "run_tests", command => TestRunnerHandler.RunTests(command.Parameters) },
                { "get_test_results", command => TestRunnerHandler.GetTestResults(command.Parameters) },
                { "cancel_tests", command => TestRunnerHandler.CancelTests(command.Parameters) },
                // === Ares MCP 高层工具 ===
                { "ares.context.snapshot", command => AresMcpSnapshot.Execute(command.Parameters) },
                { "ares.scene.dry_run", command => AresMcpDryRun.Execute(command.Parameters) },
                { "ares.scene.apply_transaction", command => AresMcpTransaction.Execute(command.Parameters) },
                { "ares.scene.validate", command => AresMcpValidate.Execute(command.Parameters) },
                { "ares.scene.capture_review", command => AresMcpCaptureReview.Execute(command.Parameters) },
                { "ares.scene.create_draft", command => AresMcpCreateDraft.Execute(command.Parameters) },
                { "ares.assets.search", command => AresMcpAssetSearch.Execute(command.Parameters) },
                { "ares.assets.inspect_prefab", command => AresMcpInspectPrefab.Execute(command.Parameters) }
            };
        
        private static McpStatus _status = McpStatus.NotConfigured;
        public static McpStatus Status
        {
            get => _status;
            private set
            {
                if (_status != value)
                {
                    _status = value;
                    Debug.Log($"[Unity Editor MCP] Status changed to: {value}");
                    RequestInstanceRegistryWrite();
                }
            }
        }
        
        public const int DEFAULT_PORT = 6400;
        private static int currentPort = DEFAULT_PORT;
        
        /// <summary>
        /// 在编辑器加载脚本域时订阅事件并启动监听。
        /// </summary>
        static UnityEditorMCP()
        {
            mainThreadId = Thread.CurrentThread.ManagedThreadId;
            Debug.Log("[Unity Editor MCP] Initializing...");
            UnityEditorActivity.Initialize();
            EditorApplication.update += ProcessCommandQueue;
            EditorApplication.quitting += OnEditorQuitting;
            AssemblyReloadEvents.beforeAssemblyReload += BeforeAssemblyReload;
            
            // Start the TCP listener
            StartTcpListener();
        }
        
        /// <summary>
        /// 绑定本地 TCP 端口并异步接受客户端连接。
        /// </summary>
        private static void StartTcpListener()
        {
            try
            {
                if (tcpListener != null)
                {
                    StopTcpListener();
                }
                
                cancellationTokenSource = new CancellationTokenSource();
                TcpListener newListener;
                int boundPort;

                if (!TryStartTcpListener(currentPort, out newListener, out boundPort, out SocketException primaryException))
                {
                    if (currentPort == DEFAULT_PORT && primaryException.SocketErrorCode == SocketError.AddressAlreadyInUse)
                    {
                        Debug.LogFormat(LogType.Warning, LogOption.NoStacktrace, null, "[Unity Editor MCP] Port {0} is already in use. Falling back to an available loopback port.", DEFAULT_PORT);

                        if (!TryStartTcpListener(0, out newListener, out boundPort, out SocketException fallbackException))
                        {
                            throw fallbackException;
                        }
                    }
                    else
                    {
                        throw primaryException;
                    }
                }

                tcpListener = newListener;
                currentPort = boundPort;
                UnityEditorActivity.ListenerStarted(boundPort);
                registryWritePending = true;

                Status = McpStatus.Disconnected;
                Debug.Log($"[Unity Editor MCP] TCP listener started on port {currentPort}");
                
                // Start accepting connections asynchronously
                CancellationToken pStopToken = cancellationTokenSource.Token;
                listenerTask = Task.Run(() => AcceptConnectionsAsync(newListener, pStopToken));
            }
            catch (SocketException ex)
            {
                Status = McpStatus.Error;
                Debug.LogError($"[Unity Editor MCP] Failed to start TCP listener on port {currentPort}: {ex.Message}");
                
                if (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
                {
                    Debug.LogError($"[Unity Editor MCP] Port {currentPort} is already in use. Please ensure no other instance is running.");
                }
            }
            catch (Exception ex)
            {
                Status = McpStatus.Error;
                Debug.LogError($"[Unity Editor MCP] Unexpected error starting TCP listener: {ex}");
            }
        }

        private static bool TryStartTcpListener(int requestedPort, out TcpListener listener, out int boundPort, out SocketException socketException)
        {
            listener = null;
            boundPort = requestedPort;
            socketException = null;

            try
            {
                listener = new TcpListener(IPAddress.Loopback, requestedPort);
                listener.Start();
                boundPort = ((IPEndPoint)listener.LocalEndpoint).Port;
                return true;
            }
            catch (SocketException ex)
            {
                listener = null;
                socketException = ex;
                return false;
            }
        }
        
        /// <summary>
        /// 停止 TCP 监听，取消客户端连接并清除临时端口登记。
        /// </summary>
        private static void StopTcpListener()
        {
            try
            {
                cancellationTokenSource?.Cancel();
                tcpListener?.Stop();
                listenerTask?.Wait(TimeSpan.FromSeconds(1));
                
                tcpListener = null;
                cancellationTokenSource = null;
                listenerTask = null;
                
                Status = McpStatus.Disconnected;
                Debug.Log("[Unity Editor MCP] TCP listener stopped");
                UnityInstanceRegistry.Delete();
                UnityEditorActivity.ListenerStopped();
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Unity Editor MCP] Error stopping TCP listener: {ex}");
            }
        }
        
        /// <summary>
        /// 异步接收指定监听器的客户端。
        /// </summary>
        /// <param name="pListener">接收客户端的监听器。</param>
        /// <param name="cancellationToken">监听器关停标记。</param>
        /// <returns>监听器关停后结束的异步任务。</returns>
        private static async Task AcceptConnectionsAsync(TcpListener pListener, CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var tcpClient = await AcceptClientAsync(pListener, cancellationToken);
                    if (tcpClient != null)
                    {
                        Status = McpStatus.Connected;
                        Debug.Log($"[Unity Editor MCP] Client connected from {tcpClient.Client.RemoteEndPoint}");
                        
                        // Handle client in a separate task
                        _ = Task.Run(() => HandleClientAsync(tcpClient, cancellationToken));
                    }
                }
                catch (ObjectDisposedException)
                {
                    // Listener was stopped
                    break;
                }
                catch (Exception ex)
                {
                    if (!cancellationToken.IsCancellationRequested)
                    {
                        Debug.LogError($"[Unity Editor MCP] Error accepting connection: {ex}");
                    }
                }
            }
        }
        
        /// <summary>
        /// Accepts a client with cancellation support
        /// </summary>
        private static async Task<TcpClient> AcceptClientAsync(TcpListener listener, CancellationToken cancellationToken)
        {
            using (cancellationToken.Register(() => listener.Stop()))
            {
                try
                {
                    return await listener.AcceptTcpClientAsync();
                }
                catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
                {
                    return null;
                }
            }
        }
        

        /// <summary>
        /// 从客户端读取 TCP 帧并及时处理鉴权、取消和入队。
        /// </summary>
        /// <param name="pClient">已连接的客户端。</param>
        /// <param name="pCancellationToken">监听器关停标记。</param>
        /// <returns>连接关闭后完成的异步任务。</returns>
        /// <remarks>成本主要为 TCP I/O 和报文编解码。</remarks>
        private static async Task HandleClientAsync(TcpClient pClient, CancellationToken pCancellationToken)
        {
            ClientConnection pConnection = null;
            CancellationTokenRegistration pCloseOnStop = pCancellationToken.Register(pClient.Close);
            try
            {
                pClient.ReceiveTimeout = 30000;
                pClient.SendTimeout = 30000;
                pConnection = new ClientConnection(pClient.GetStream(), pCancellationToken);
                byte[] arrBuffer = new byte[4096];
                List<byte> listMessageBuffer = new List<byte>();

                while (!pCancellationToken.IsCancellationRequested)
                {
                    int nBytesRead = await pConnection.Stream.ReadAsync(arrBuffer, 0, arrBuffer.Length, pCancellationToken);
                    if (nBytesRead == 0)
                    {
                        break;
                    }

                    for (int nIndex = 0; nIndex < nBytesRead; nIndex++)
                    {
                        listMessageBuffer.Add(arrBuffer[nIndex]);
                    }

                    while (listMessageBuffer.Count >= 4)
                    {
                        int nMessageLength = listMessageBuffer[0] << 24 | listMessageBuffer[1] << 16 |
                            listMessageBuffer[2] << 8 | listMessageBuffer[3];
                        if (nMessageLength <= 0 || nMessageLength > int.MaxValue - 4)
                        {
                            throw new System.IO.InvalidDataException("Unity MCP TCP 帧长度无效。");
                        }

                        if (listMessageBuffer.Count < nMessageLength + 4)
                        {
                            break;
                        }

                        byte[] arrMessage = listMessageBuffer.GetRange(4, nMessageLength).ToArray();
                        listMessageBuffer.RemoveRange(0, nMessageLength + 4);

                        string szJson = Encoding.UTF8.GetString(arrMessage);
                        Debug.Log($"[Unity Editor MCP] Received command (length={nMessageLength}): {RedactCommandJson(szJson)}");
                        string szResponse = ReceiveCommand(pConnection, szJson);
                        if (szResponse != null)
                        {
                            _ = pConnection.SendResponseAsync(szResponse);
                        }
                    }
                }
            }
            catch (Exception pException)
            {
                if (!pCancellationToken.IsCancellationRequested)
                {
                    Debug.LogError($"[Unity Editor MCP] Client handler error: {pException}");
                }
            }
            finally
            {
                if (pConnection != null)
                {
                    pConnection.RemovePendingCommands();
                }

                pCloseOnStop.Dispose();
                pClient.Close();
                if (Status == McpStatus.Connected)
                {
                    Status = McpStatus.Disconnected;
                }

                Debug.Log("[Unity Editor MCP] Client disconnected");
            }
        }

        /// <summary>
        /// 鉴权后接收普通命令或撤销当前连接的待执行请求。
        /// </summary>
        /// <param name="pConnection">发送命令的客户端连接。</param>
        /// <param name="szJson">收到的 JSON 报文。</param>
        /// <returns>需要立即发送的回应，无需回应或正常入队时为空。</returns>
        /// <remarks>时间复杂度：O(n)，n 为 JSON 报文长度。待执行命令索引通常以常数时间处理。</remarks>
        private static string ReceiveCommand(ClientConnection pConnection, string szJson)
        {
            if (string.Equals(szJson.Trim(), "ping", StringComparison.OrdinalIgnoreCase))
            {
                return Response.ErrorResult("Plain ping requires an authenticated JSON command envelope", "AUTH_FAILED", null);
            }

            Command pCommand;
            try
            {
                pCommand = JsonConvert.DeserializeObject<Command>(szJson);
            }
            catch (JsonException pException)
            {
                return Response.ErrorResult($"JSON parsing error: {pException.Message}", "JSON_ERROR", null);
            }

            if (pCommand == null)
            {
                return Response.ErrorResult("Invalid command format", "PARSE_ERROR", null);
            }

            if (!IsAuthorized(pCommand))
            {
                return Response.ErrorResult(pCommand.Id, "Invalid or missing Unity Editor MCP auth token",
                    "AUTH_FAILED", new { commandType = pCommand.Type, executionState = "not_started" });
            }

            lock (m_pQueueLock)
            {
                if (string.Equals(pCommand.Type, "cancel_command", StringComparison.OrdinalIgnoreCase))
                {
                    string szCommandId = pCommand.Parameters?["commandId"]?.ToString();
                    if (!string.IsNullOrEmpty(szCommandId) && pConnection.PendingCommands.TryGetValue(szCommandId, out LinkedListNode<PendingCommand> pCanceled))
                    {
                        m_listCommandQueue.Remove(pCanceled);
                        pConnection.PendingCommands.Remove(szCommandId);
                    }

                    return null;
                }

                string szRejection = GetCommandRejection(pCommand);
                if (szRejection != null)
                {
                    return szRejection;
                }

                string szQueueId = string.IsNullOrEmpty(pCommand.Id) ? Guid.NewGuid().ToString("N") : pCommand.Id;
                if (pConnection.PendingCommands.ContainsKey(szQueueId))
                {
                    return Response.ErrorResult(pCommand.Id, "Unity MCP 请求 ID 正在使用。", "DUPLICATE_COMMAND_ID", null);
                }

                PendingCommand pPending = new PendingCommand(pCommand, pConnection, szQueueId);
                pConnection.PendingCommands.Add(szQueueId, m_listCommandQueue.AddLast(pPending));
            }

            return null;
        }

        /// <summary>
        /// 在接收和开始执行前检查请求有效期及缓存中的忙碌状态。
        /// </summary>
        /// <param name="pCommand">待检查的请求。</param>
        /// <returns>确认未执行时的结构化错误，可以继续处理时为空。</returns>
        private static string GetCommandRejection(Command pCommand)
        {
            if (pCommand.DeadlineUnixMs.HasValue && pCommand.DeadlineUnixMs.Value <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            {
                return Response.ErrorResult(pCommand.Id, "请求已过期，本次操作未执行。", "UNITY_REQUEST_EXPIRED",
                    new { executionState = "not_started" });
            }

            if (UnityEditorActivity.TryGetBusy(out string szState, out string szMessage))
            {
                return Response.ErrorResult(pCommand.Id, szMessage, "UNITY_BUSY",
                    new { state = szState, executionState = "not_started", retryAfterMs = UnityEditorActivity.RetryAfterMs });
            }

            return null;
        }

        /// <summary>
        /// 更新实例心跳，并在 Unity 主线程按顺序处理队列。
        /// </summary>
        /// <remarks>时间复杂度约为 O(n)，n 为出队请求数，实际耗时主要由调用的编辑器命令和 I/O 决定。</remarks>
        private static void ProcessCommandQueue()
        {
            if (tcpListener != null &&
                (registryWritePending || EditorApplication.timeSinceStartup - lastRegistryWriteTime >= RegistryHeartbeatIntervalSeconds))
            {
                WriteInstanceRegistry();
            }

            UnityEditorActivity.OnEditorUpdate(tcpListener != null);

            if (m_bProcessingQueue)
            {
                return;
            }

            int nQueuedAtUpdate;
            lock (m_pQueueLock)
            {
                nQueuedAtUpdate = m_listCommandQueue.Count;
            }

            // 每次更新只处理有限数量的命令，让持续进入的请求留到下一次更新。
            m_bProcessingQueue = true;
            try
            {
                for (int nIndex = 0; nIndex < nQueuedAtUpdate; nIndex++)
                {
                    PendingCommand pPending;
                    string szResponse;
                    lock (m_pQueueLock)
                    {
                        LinkedListNode<PendingCommand> pNext = m_listCommandQueue.First;
                        if (pNext == null)
                        {
                            break;
                        }

                        pPending = pNext.Value;
                        m_listCommandQueue.RemoveFirst();
                        pPending.Connection.PendingCommands.Remove(pPending.QueueId);
                        if (pPending.Connection.StopToken.IsCancellationRequested)
                        {
                            continue;
                        }

                        // 取消先取得锁时会移除请求。通过校验后由主线程接管，取消不能中止已开始的操作。
                        szResponse = GetCommandRejection(pPending.Command);
                    }

                    if (szResponse == null)
                    {
                        szResponse = ProcessCommand(pPending.Command);
                    }

                    _ = pPending.Connection.SendResponseAsync(szResponse);
                }
            }
            finally
            {
                m_bProcessingQueue = false;
            }
        }

        /// <summary>
        /// 执行已由主线程接管的请求，返回原有格式的工具结果。
        /// </summary>
        /// <param name="pCommand">通过执行前校验的请求。</param>
        /// <returns>工具执行结果或执行期间发生的错误。</returns>
        /// <remarks>耗时取决于编辑器命令。部分命令会访问资源或保存场景与预制。</remarks>
        private static string ProcessCommand(Command pCommand)
        {
            try
            {
                Debug.Log($"[Unity Editor MCP] Processing command: {pCommand}");
                if (ContextSwitchCommands.Contains(pCommand.Type))
                {
                    SceneSaveHelper.SaveSceneIfDirty();
                }

                if (!TryExecuteRegisteredCommand(pCommand, out object pResult))
                {
                    return Response.ErrorResult(pCommand.Id, $"Unknown command type: {pCommand.Type}", "UNKNOWN_COMMAND",
                        new { commandType = pCommand.Type, executionState = "not_started" });
                }

                string szResponse = Response.SuccessResult(pCommand.Id, pResult);
                if (WriteCommands.Contains(pCommand.Type))
                {
                    SceneSaveHelper.SaveSceneIfDirty();
                }

                return szResponse;
            }
            catch (Exception pException)
            {
                Debug.LogError($"[Unity Editor MCP] Error processing command {pCommand}: {pException}");
                return Response.ErrorResult(pCommand.Id, $"Internal error: {pException.Message}", "INTERNAL_ERROR",
                    new
                    {
                        commandType = pCommand.Type,
                        stackTrace = pException.StackTrace,
                        executionState = "unknown"
                    });
            }
        }

        /// <summary>
        /// 在域重载前保存重载快照，再关闭监听和域内事件。
        /// </summary>
        private static void BeforeAssemblyReload()
        {
            UnityEditorActivity.BeforeAssemblyReload();
            Shutdown();
        }

        /// <summary>
        /// 在编辑器退出时停止服务并移除活动快照。
        /// </summary>
        private static void OnEditorQuitting()
        {
            Shutdown();
            UnityInstanceRegistry.DeleteActivity();
        }

        /// <summary>
        /// 关闭当前域的监听和事件订阅。
        /// </summary>
        private static void Shutdown()
        {
            Debug.Log("[Unity Editor MCP] Shutting down...");
            StopTcpListener();
            EditorApplication.update -= ProcessCommandQueue;
            EditorApplication.quitting -= OnEditorQuitting;
            AssemblyReloadEvents.beforeAssemblyReload -= BeforeAssemblyReload;
            UnityEditorActivity.Destroy();
        }
        
        /// <summary>
        /// Restarts the TCP listener
        /// </summary>
        public static void Restart()
        {
            Debug.Log("[Unity Editor MCP] Restarting...");
            StopTcpListener();
            StartTcpListener();
        }
        
        /// <summary>
        /// Changes the listening port and restarts
        /// </summary>
        public static void ChangePort(int newPort)
        {
            if (newPort < 1024 || newPort > 65535)
            {
                Debug.LogError($"[Unity Editor MCP] Invalid port number: {newPort}. Must be between 1024 and 65535.");
                return;
            }
            
            currentPort = newPort;
            Restart();
        }

        private static void WriteInstanceRegistry()
        {
            if (tcpListener == null)
            {
                return;
            }

            registryWritePending = false;
            UnityInstanceRegistry.Write(currentPort, Status);
            lastRegistryWriteTime = EditorApplication.timeSinceStartup;
        }

        private static void RequestInstanceRegistryWrite()
        {
            if (tcpListener == null)
            {
                return;
            }

            if (Thread.CurrentThread.ManagedThreadId == mainThreadId)
            {
                WriteInstanceRegistry();
            }
            else
            {
                registryWritePending = true;
            }
        }

        private static bool IsAuthorized(Command command)
        {
            return command != null &&
                   !string.IsNullOrEmpty(command.AuthToken) &&
                   string.Equals(command.AuthToken, UnityInstanceRegistry.AuthToken, StringComparison.Ordinal);
        }

        private static bool TryExecuteRegisteredCommand(Command command, out object result)
        {
            result = null;
            if (command == null || string.IsNullOrEmpty(command.Type))
            {
                return false;
            }

            if (!CommandHandlers.TryGetValue(command.Type, out CommandHandlerDelegate handler))
            {
                return false;
            }

            result = handler(command);
            return true;
        }

        private static object HandlePing(Command command)
        {
            return new
            {
                message = "pong",
                echo = command.Parameters?["message"]?.ToString(),
                timestamp = DateTime.UtcNow.ToString("o"),
                unityVersion = Application.unityVersion,
                projectPath = UnityInstanceRegistry.ProjectPath,
                workspaceId = UnityInstanceRegistry.WorkspaceId,
                workspaceIdSource = UnityInstanceRegistry.WorkspaceIdSource,
                git = UnityInstanceRegistry.GitInfo,
                port = currentPort,
                packageVersion = UnityInstanceRegistry.PackageVersion
            };
        }

        private static object HandleReadLogs(JObject parameters)
        {
            int count = 100;
            string logTypeFilter = null;

            if (parameters != null)
            {
                if (parameters.ContainsKey("count") &&
                    int.TryParse(parameters["count"].ToString(), out int parsedCount))
                {
                    count = Math.Min(Math.Max(parsedCount, 1), 1000);
                }

                if (parameters.ContainsKey("logType"))
                {
                    logTypeFilter = parameters["logType"].ToString();
                }
            }

            LogType? filterType = null;
            if (!string.IsNullOrEmpty(logTypeFilter) &&
                Enum.TryParse(logTypeFilter, true, out LogType parsed))
            {
                filterType = parsed;
            }

            var logs = LogCapture.GetLogs(count, filterType);
            var logData = new List<object>();

            foreach (var log in logs)
            {
                logData.Add(new
                {
                    message = log.message,
                    stackTrace = log.stackTrace,
                    logType = log.logType.ToString(),
                    timestamp = log.timestamp.ToString("o")
                });
            }

            return new
            {
                logs = logData,
                count = logData.Count,
                totalCaptured = logs.Count
            };
        }

        private static object HandleClearLogs()
        {
            LogCapture.ClearLogs();
            return new
            {
                message = "Logs cleared successfully",
                timestamp = DateTime.UtcNow.ToString("o")
            };
        }

        /// <summary>
        /// Queues an AssetDatabase.Refresh() and returns immediately. A synchronous Refresh()
        /// runs on the main editor thread and blocks it for the whole import+compile pass
        /// (80-95s on large projects), leaving the TCP response pending for minutes and
        /// looking like a hang. Callers poll get_compilation_state / read_logs afterwards.
        /// </summary>
        private static object HandleRefreshAssets()
        {
            // Run the real refresh on the next editor frame, after this command's
            // response has already been sent back over TCP.
            EditorApplication.delayCall += () =>
            {
                Debug.Log("[Unity Editor MCP] refresh_assets: AssetDatabase.Refresh() starting (may take 1-2 minutes on large projects)");
                AssetDatabase.Refresh();
                Debug.Log("[Unity Editor MCP] refresh_assets: AssetDatabase.Refresh() finished");
            };
            return new
            {
                message = "Asset refresh queued (runs on next editor frame). On large projects the recompile can take 1-2 minutes; poll get_compilation_state until compiling is done, then read_logs for errors.",
                queued = true,
                timestamp = DateTime.UtcNow.ToString("o")
            };
        }

        private static string GetAction(Command command)
        {
            return command.Parameters?["action"]?.ToString();
        }

        private static string RedactCommandJson(string json)
        {
            try
            {
                var token = JObject.Parse(json);
                if (token["authToken"] != null)
                {
                    token["authToken"] = "[redacted]";
                }

                return token.ToString(Formatting.None);
            }
            catch
            {
                return json;
            }
        }

        #region 待处理请求与客户端连接

        /// <summary>
        /// 保存等待编辑器主线程执行的请求及所属客户端。
        /// </summary>
        private sealed class PendingCommand
        {
            /// <summary>待执行的请求。</summary>
            public Command Command { get; }

            /// <summary>发送请求的客户端连接。</summary>
            public ClientConnection Connection { get; }

            /// <summary>连接内的待执行命令索引键。</summary>
            public string QueueId { get; }

            /// <summary>
            /// 记录请求与取消索引。
            /// </summary>
            /// <param name="pCommand">待执行的请求。</param>
            /// <param name="pConnection">发送请求的客户端连接。</param>
            /// <param name="szQueueId">连接内的请求索引键。</param>
            public PendingCommand(Command pCommand, ClientConnection pConnection, string szQueueId)
            {
                Command = pCommand;
                Connection = pConnection;
                QueueId = szQueueId;
            }
        }

        /// <summary>
        /// 保存客户端流和待执行请求，并串行发送 TCP 响应帧。
        /// </summary>
        private sealed class ClientConnection
        {
            /// <summary>保证同一连接的帧头与正文连续写入。</summary>
            private readonly SemaphoreSlim m_pSendLock = new SemaphoreSlim(1);

            /// <summary>客户端的 TCP 网络流。</summary>
            public NetworkStream Stream { get; }

            /// <summary>监听器停止时触发的取消标记。</summary>
            public CancellationToken StopToken { get; }

            /// <summary>本连接尚未被主线程接管的请求，仅在队列锁内访问。</summary>
            public Dictionary<string, LinkedListNode<PendingCommand>> PendingCommands { get; } =
                new Dictionary<string, LinkedListNode<PendingCommand>>(StringComparer.Ordinal);

            /// <summary>
            /// 创建客户端连接的命令和响应上下文。
            /// </summary>
            /// <param name="pStream">客户端网络流。</param>
            /// <param name="pStopToken">监听器关停标记。</param>
            public ClientConnection(NetworkStream pStream, CancellationToken pStopToken)
            {
                Stream = pStream;
                StopToken = pStopToken;
            }

            /// <summary>
            /// 在客户端断开时移除它尚未开始的请求。
            /// </summary>
            /// <remarks>时间复杂度：O(n)，n 为该连接中仍在排队的请求数。</remarks>
            public void RemovePendingCommands()
            {
                lock (m_pQueueLock)
                {
                    foreach (LinkedListNode<PendingCommand> pPending in PendingCommands.Values)
                    {
                        m_listCommandQueue.Remove(pPending);
                    }

                    PendingCommands.Clear();
                }
            }

            /// <summary>
            /// 串行发送带长度前缀的工具回应。
            /// </summary>
            /// <param name="szResponse">已序列化的 JSON 回应。</param>
            /// <returns>本次发送尝试结束后的异步任务。</returns>
            /// <remarks>时间复杂度：O(n)，n 为响应长度，开销包括 UTF-8 编码和 TCP 写入。</remarks>
            public async Task SendResponseAsync(string szResponse)
            {
                try
                {
                    await m_pSendLock.WaitAsync(StopToken).ConfigureAwait(false);
                    try
                    {
                        byte[] arrMessage = Encoding.UTF8.GetBytes(szResponse);
                        byte[] arrLength = BitConverter.GetBytes(arrMessage.Length);
                        if (BitConverter.IsLittleEndian)
                        {
                            Array.Reverse(arrLength);
                        }

                        await Stream.WriteAsync(arrLength, 0, arrLength.Length, StopToken).ConfigureAwait(false);
                        await Stream.WriteAsync(arrMessage, 0, arrMessage.Length, StopToken).ConfigureAwait(false);
                    }
                    finally
                    {
                        m_pSendLock.Release();
                    }
                }
                catch (Exception pException)
                {
                    if (!StopToken.IsCancellationRequested)
                    {
                        Debug.LogWarning($"[Unity Editor MCP] 无法发送命令回应：{pException.Message}");
                        // 写入失败时可能已经发送了半帧。关闭连接，避免后续帧从错误的边界被解析。
                        Stream.Close();
                    }
                }
            }
        }

        #endregion
    }
}
