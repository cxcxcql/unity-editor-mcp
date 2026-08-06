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
    /// Main Unity Editor MCP class that handles TCP communication and command processing
    /// </summary>
    [InitializeOnLoad]
    public static class UnityEditorMCP
    {
        private static TcpListener tcpListener;
        private static readonly Queue<(Command command, TcpClient client)> commandQueue = new Queue<(Command, TcpClient)>();
        private static readonly object queueLock = new object();
        private static CancellationTokenSource cancellationTokenSource;
        private static Task listenerTask;
        private const double RegistryHeartbeatIntervalSeconds = 5.0;
        private static double lastRegistryWriteTime;
        private static int mainThreadId;
        private static volatile bool registryWritePending;
        private delegate object CommandHandlerDelegate(Command command);
        private static readonly Dictionary<string, CommandHandlerDelegate> CommandHandlers =
            new Dictionary<string, CommandHandlerDelegate>(StringComparer.OrdinalIgnoreCase)
            {
                { "ping", HandlePing },
                { "get_project_info", command => UnityInstanceRegistry.GetProjectInfo(currentPort, Status) },
                { "read_logs", command => HandleReadLogs(command.Parameters) },
                { "clear_logs", command => HandleClearLogs() },
                { "refresh_assets", command => HandleRefreshAssets() },
                { "create_gameobject", command => GameObjectHandler.CreateGameObject(command.Parameters) },
                { "find_gameobject", command => GameObjectHandler.FindGameObjects(command.Parameters) },
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
                { "find_by_component", command => SceneAnalysisHandler.FindByComponent(command.Parameters) },
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
                { "ares.scene.dry_run", command => AresMcpDryRun.Execute(command.Parameters) }
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
        /// Static constructor - called when Unity loads
        /// </summary>
        static UnityEditorMCP()
        {
            mainThreadId = Thread.CurrentThread.ManagedThreadId;
            Debug.Log("[Unity Editor MCP] Initializing...");
            EditorApplication.update += ProcessCommandQueue;
            EditorApplication.quitting += Shutdown;
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
            
            // Start the TCP listener
            StartTcpListener();
        }
        
        /// <summary>
        /// Starts the TCP listener on the configured port
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
                
                Status = McpStatus.Disconnected;
                Debug.Log($"[Unity Editor MCP] TCP listener started on port {currentPort}");
                
                // Start accepting connections asynchronously
                listenerTask = Task.Run(() => AcceptConnectionsAsync(cancellationTokenSource.Token));
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
        /// Stops the TCP listener
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
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Unity Editor MCP] Error stopping TCP listener: {ex}");
            }
        }
        
        /// <summary>
        /// Accepts incoming TCP connections asynchronously
        /// </summary>
        private static async Task AcceptConnectionsAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var tcpClient = await AcceptClientAsync(tcpListener, cancellationToken);
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
        /// Handles communication with a connected client
        /// </summary>
        private static async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
        {
            try
            {
                client.ReceiveTimeout = 30000; // 30 second timeout
                client.SendTimeout = 30000;
                
                var buffer = new byte[4096];
                var stream = client.GetStream();
                var messageBuffer = new List<byte>();
                
                while (!cancellationToken.IsCancellationRequested && client.Connected)
                {
                    var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken);
                    if (bytesRead == 0)
                    {
                        // Client disconnected
                        break;
                    }
                    
                    // Add received bytes to message buffer
                    for (int i = 0; i < bytesRead; i++)
                    {
                        messageBuffer.Add(buffer[i]);
                    }
                    
                    // Process complete messages
                    while (messageBuffer.Count >= 4)
                    {
                        // Read message length (first 4 bytes, big-endian)
                        var lengthBytes = messageBuffer.GetRange(0, 4).ToArray();
                        if (BitConverter.IsLittleEndian)
                        {
                            Array.Reverse(lengthBytes);
                        }
                        var messageLength = BitConverter.ToInt32(lengthBytes, 0);
                        
                        // Check if we have the complete message
                        if (messageBuffer.Count >= 4 + messageLength)
                        {
                            // Extract message
                            var messageBytes = messageBuffer.GetRange(4, messageLength).ToArray();
                            messageBuffer.RemoveRange(0, 4 + messageLength);
                            
                            var json = Encoding.UTF8.GetString(messageBytes);
                            Debug.Log($"[Unity Editor MCP] Received command (length={messageLength}): {RedactCommandJson(json)}");
                            
                            try
                            {
                                // Handle special ping command
                                if (json.Trim().ToLower() == "ping")
                                {
                                    var authError = Response.ErrorResult(
                                        "Plain ping requires an authenticated JSON command envelope",
                                        "AUTH_FAILED",
                                        null
                                    );
                                    await SendFramedMessage(stream, authError, cancellationToken);
                                    continue;
                                }
                                
                                // Parse command
                                var command = JsonConvert.DeserializeObject<Command>(json);
                                if (command != null)
                                {
                                    // Queue command for processing on main thread
                                    lock (queueLock)
                                    {
                                        commandQueue.Enqueue((command, client));
                                    }
                                }
                                else
                                {
                                    var errorResponse = Response.ErrorResult("Invalid command format", "PARSE_ERROR", null);
                                    await SendFramedMessage(stream, errorResponse, cancellationToken);
                                }
                            }
                            catch (JsonException ex)
                            {
                                var errorResponse = Response.ErrorResult($"JSON parsing error: {ex.Message}", "JSON_ERROR", null);
                                await SendFramedMessage(stream, errorResponse, cancellationToken);
                            }
                        }
                        else
                        {
                            // Not enough data yet, wait for more
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                if (!cancellationToken.IsCancellationRequested)
                {
                    Debug.LogError($"[Unity Editor MCP] Client handler error: {ex}");
                }
            }
            finally
            {
                client?.Close();
                if (Status == McpStatus.Connected)
                {
                    Status = McpStatus.Disconnected;
                }
                Debug.Log("[Unity Editor MCP] Client disconnected");
            }
        }
        
        /// <summary>
        /// Sends a framed message over the stream
        /// </summary>
        private static async Task SendFramedMessage(NetworkStream stream, string message, CancellationToken cancellationToken)
        {
            var messageBytes = Encoding.UTF8.GetBytes(message);
            var lengthBytes = BitConverter.GetBytes(messageBytes.Length);
            
            // Convert to big-endian
            if (BitConverter.IsLittleEndian)
            {
                Array.Reverse(lengthBytes);
            }
            
            Debug.Log($"[Unity Editor MCP] Sending response (length={messageBytes.Length}): {message}");
            
            // Write length prefix
            await stream.WriteAsync(lengthBytes, 0, 4, cancellationToken);
            // Write message
            await stream.WriteAsync(messageBytes, 0, messageBytes.Length, cancellationToken);
            await stream.FlushAsync(cancellationToken);
        }
        
        /// <summary>
        /// Processes queued commands on the Unity main thread
        /// </summary>
        private static void ProcessCommandQueue()
        {
            lock (queueLock)
            {
                while (commandQueue.Count > 0)
                {
                    var (command, client) = commandQueue.Dequeue();
                    ProcessCommand(command, client);
                }
            }

            if (tcpListener != null &&
                (registryWritePending || EditorApplication.timeSinceStartup - lastRegistryWriteTime >= RegistryHeartbeatIntervalSeconds))
            {
                WriteInstanceRegistry();
            }
        }
        
        /// <summary>
        /// Processes a single command
        /// </summary>
        private static async void ProcessCommand(Command command, TcpClient client)
        {
            try
            {
                Debug.Log($"[Unity Editor MCP] Processing command: {command}");
                
                string response;

                if (!IsAuthorized(command))
                {
                    response = Response.ErrorResult(
                        command.Id,
                        "Invalid or missing Unity Editor MCP auth token",
                        "AUTH_FAILED",
                        new { commandType = command.Type }
                    );
                }
                else
                {
                
                if (TryExecuteRegisteredCommand(command, out object commandResult))
                {
                    response = Response.SuccessResult(command.Id, commandResult);
                }
                else
                {
                    response = Response.ErrorResult(
                        command.Id,
                        $"Unknown command type: {command.Type}",
                        "UNKNOWN_COMMAND",
                        new { commandType = command.Type }
                    );
                }
                }
                
                // Send response
                if (client.Connected)
                {
                    await SendFramedMessage(client.GetStream(), response, CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Unity Editor MCP] Error processing command {command}: {ex}");
                
                try
                {
                    if (client.Connected)
                    {
                        var errorResponse = Response.ErrorResult(
                            command.Id,
                            $"Internal error: {ex.Message}", 
                            "INTERNAL_ERROR",
                            new { 
                                commandType = command.Type,
                                stackTrace = ex.StackTrace
                            }
                        );
                        await SendFramedMessage(client.GetStream(), errorResponse, CancellationToken.None);
                    }
                }
                catch
                {
                    // Best effort - ignore errors when sending error response
                }
            }
        }
        
        /// <summary>
        /// Shuts down the MCP system
        /// </summary>
        private static void Shutdown()
        {
            Debug.Log("[Unity Editor MCP] Shutting down...");
            StopTcpListener();
            UnityInstanceRegistry.Delete();
            EditorApplication.update -= ProcessCommandQueue;
            EditorApplication.quitting -= Shutdown;
            AssemblyReloadEvents.beforeAssemblyReload -= Shutdown;
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

        private static object HandleRefreshAssets()
        {
            AssetDatabase.Refresh();
            return new
            {
                message = "Asset refresh triggered",
                isCompiling = EditorApplication.isCompiling,
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
    }
}
