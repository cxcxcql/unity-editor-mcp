using System;
using System.IO;
using Newtonsoft.Json;
using UnityEditor.PackageManager;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEditorMCP.Models;
using Process = System.Diagnostics.Process;

namespace UnityEditorMCP.Core
{
    internal static class UnityInstanceRegistry
    {
        private const string RegistryFolderName = ".unity-editor-mcp";
        private const string InstancesFolderName = "instances";

        /// <summary>独立活动快照的目录名称。</summary>
        private const string ActivityFolderName = "activity";

        /// <summary>操作系统记录的进程启动时间，格式为 UTC ISO 8601。</summary>
        private static readonly string ProcessStartedAt = ReadProcessStartedAt();

        /// <summary>按当前 Unity 进程 ID 保存的活动快照路径。</summary>
        private static string ActivityFilePath =>
            Path.Combine(GetHomeDirectory(), RegistryFolderName, ActivityFolderName, $"{ProcessId}.json");

        private static readonly int ProcessId = Process.GetCurrentProcess().Id;
        private static readonly string InstanceId = Guid.NewGuid().ToString("N");
        private static readonly string InstanceAuthToken = Guid.NewGuid().ToString("N");
        private static readonly string StartedAt = DateTime.UtcNow.ToString("o");
        private static readonly ProjectIdentity Identity = LoadProjectIdentity();

        private const string WorkspaceIdGitPath = "unity-editor-mcp/workspace-id";

        public static string RegistryDirectory
        {
            get
            {
                return Path.Combine(GetHomeDirectory(), RegistryFolderName, InstancesFolderName);
            }
        }

        public static string RegistryFilePath
        {
            get
            {
                return Path.Combine(RegistryDirectory, $"{ProcessId}.json");
            }
        }

        public static string ProjectPath
        {
            get
            {
                try
                {
                    var assetsPath = Application.dataPath;
                    var projectPath = Directory.GetParent(assetsPath)?.FullName;
                    return string.IsNullOrEmpty(projectPath) ? assetsPath : Path.GetFullPath(projectPath);
                }
                catch
                {
                    return Application.dataPath;
                }
            }
        }

        public static string WorkspaceId
        {
            get
            {
                return Identity.WorkspaceId;
            }
        }

        public static string AuthToken
        {
            get
            {
                return InstanceAuthToken;
            }
        }

        public static string WorkspaceIdSource
        {
            get
            {
                return Identity.WorkspaceIdSource;
            }
        }

        public static object GitInfo
        {
            get
            {
                return CreateGitPayload(Identity.Git);
            }
        }

        public static void Write(int port, McpStatus status)
        {
            try
            {
                Directory.CreateDirectory(RegistryDirectory);
                File.WriteAllText(RegistryFilePath, JsonConvert.SerializeObject(CreatePayload(port, status, includeAuthToken: true), Formatting.Indented));
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning($"[Unity Editor MCP] Failed to write instance registry: {ex.Message}");
            }
        }

        public static void Delete()
        {
            try
            {
                if (File.Exists(RegistryFilePath))
                {
                    File.Delete(RegistryFilePath);
                }
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning($"[Unity Editor MCP] Failed to delete instance registry: {ex.Message}");
            }
        }


        /// <summary>
        /// 在编辑器主线程发布可跨域重载读取的活动快照。
        /// </summary>
        /// <param name="nPort">监听端口，首次完成绑定前为空。</param>
        /// <param name="szState">当前活动阶段。</param>
        /// <param name="szSource">活动来源。</param>
        /// <param name="pActivityStartedAt">活动开始的 UTC 时间。</param>
        /// <remarks>时间复杂度：O(1)，写入同目录临时文件后替换单个快照。</remarks>
        public static void WriteActivity(int? nPort, string szState, string szSource, DateTime pActivityStartedAt)
        {
            string szPath = ActivityFilePath;
            string szTempPath = szPath + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(szPath));
                string szJson = JsonConvert.SerializeObject(new
                {
                    schemaVersion = 1,
                    pid = ProcessId,
                    processStartedAt = ProcessStartedAt,
                    instanceId = InstanceId,
                    projectPath = ProjectPath,
                    workspaceId = WorkspaceId,
                    workspaceIdSource = WorkspaceIdSource,
                    isBatchMode = Application.isBatchMode,
                    host = "127.0.0.1",
                    port = nPort,
                    state = szState,
                    source = szSource,
                    activityStartedAt = pActivityStartedAt.ToString("o"),
                    updatedAt = DateTime.UtcNow.ToString("o")
                });

                File.WriteAllText(szTempPath, szJson);
                if (File.Exists(szPath))
                {
                    File.Replace(szTempPath, szPath, null);
                }
                else
                {
                    File.Move(szTempPath, szPath);
                }
            }
            catch (Exception pException)
            {
                // 已成功发布的快照仍然可读，下一次心跳会重新写入临时文件。
                UnityEngine.Debug.LogWarning($"[Unity Editor MCP] 无法写入活动快照：{pException.Message}");
            }
        }

        /// <summary>
        /// 编辑器退出时删除活动快照和可能残留的临时文件。
        /// </summary>
        public static void DeleteActivity()
        {
            try
            {
                File.Delete(ActivityFilePath);
                File.Delete(ActivityFilePath + ".tmp");
            }
            catch (Exception pException)
            {
                UnityEngine.Debug.LogWarning($"[Unity Editor MCP] 无法删除活动快照：{pException.Message}");
            }
        }

        /// <summary>
        /// 获取跨脚本域保持稳定的 Unity 进程启动时间。
        /// </summary>
        /// <returns>UTC ISO 8601 时间，系统无法读取时为空。</returns>
        private static string ReadProcessStartedAt()
        {
            try
            {
                using (Process pProcess = Process.GetCurrentProcess())
                {
                    return pProcess.StartTime.ToUniversalTime().ToString("o");
                }
            }
            catch (Exception pException)
            {
                UnityEngine.Debug.LogWarning($"[Unity Editor MCP] 无法读取进程启动时间：{pException.Message}");
                return null;
            }
        }

        public static object GetProjectInfo(int port, McpStatus status)
        {
            return CreatePayload(port, status, includeRegistryPath: true);
        }

        public static string PackageVersion
        {
            get
            {
                try
                {
                    var packageInfo = PackageInfo.FindForAssembly(typeof(UnityEditorMCP).Assembly);
                    return packageInfo?.version ?? "unknown";
                }
                catch
                {
                    return "unknown";
                }
            }
        }

        /// <summary>
        /// 生成 TCP 实例登记或项目查询结果，共用相同的项目及进程身份。
        /// </summary>
        /// <param name="port">当前 TCP 监听端口。</param>
        /// <param name="status">TCP 连接状态。</param>
        /// <param name="includeRegistryPath">是否附带登记文件路径。</param>
        /// <param name="includeAuthToken">是否写入仅供本机桥接使用的令牌。</param>
        /// <returns>可序列化的实例信息。</returns>
        private static object CreatePayload(int port, McpStatus status, bool includeRegistryPath = false, bool includeAuthToken = false)
        {
            var activeScene = EditorSceneManager.GetActiveScene();
            return new
            {
                schemaVersion = 2,
                instanceId = InstanceId,
                authToken = includeAuthToken ? InstanceAuthToken : null,
                projectPath = ProjectPath,
                projectName = new DirectoryInfo(ProjectPath).Name,
                workspaceId = WorkspaceId,
                workspaceIdSource = WorkspaceIdSource,
                git = GitInfo,
                pid = ProcessId,
                processStartedAt = ProcessStartedAt,
                activityTracking = true,
                host = "127.0.0.1",
                port,
                unityVersion = Application.unityVersion,
                packageVersion = PackageVersion,
                status = status.ToString(),
                isBatchMode = Application.isBatchMode,
                activeScene = string.IsNullOrEmpty(activeScene.path) ? activeScene.name : activeScene.path,
                startedAt = StartedAt,
                lastSeen = DateTime.UtcNow.ToString("o"),
                registryPath = includeRegistryPath ? RegistryFilePath : null,
                registryDirectory = includeRegistryPath ? RegistryDirectory : null
            };
        }

        private static ProjectIdentity LoadProjectIdentity()
        {
            var projectPath = ProjectPath;
            var git = ReadGitMetadata(projectPath);
            if (git != null && !string.IsNullOrEmpty(git.WorkspaceIdPath))
            {
                return new ProjectIdentity
                {
                    WorkspaceId = ReadOrCreateWorkspaceId(git.WorkspaceIdPath),
                    WorkspaceIdSource = "git",
                    Git = git
                };
            }

            var libraryWorkspaceIdPath = Path.Combine(projectPath, "Library", "UnityEditorMCP", "workspace-id");
            return new ProjectIdentity
            {
                WorkspaceId = ReadOrCreateWorkspaceId(libraryWorkspaceIdPath),
                WorkspaceIdSource = "library",
                Git = null
            };
        }

        private static GitMetadata ReadGitMetadata(string projectPath)
        {
            try
            {
                var core = RunGit(projectPath, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--git-path", WorkspaceIdGitPath);
                if (string.IsNullOrEmpty(core))
                {
                    return null;
                }

                var parts = core.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 4)
                {
                    return null;
                }

                var topLevel = ResolvePath(projectPath, parts[0]);
                var gitDir = ResolvePath(projectPath, parts[1]);
                var commonDir = ResolvePath(projectPath, parts[2]);
                var workspaceIdPath = ResolvePath(projectPath, parts[3]);

                return new GitMetadata
                {
                    TopLevel = topLevel,
                    GitDir = gitDir,
                    CommonDir = commonDir,
                    WorktreeName = GetWorktreeName(gitDir, commonDir),
                    Branch = EmptyToNull(RunGit(projectPath, "rev-parse", "--abbrev-ref", "HEAD")),
                    Head = EmptyToNull(RunGit(projectPath, "rev-parse", "--verify", "HEAD")),
                    WorkspaceIdPath = workspaceIdPath
                };
            }
            catch
            {
                return null;
            }
        }

        private static string RunGit(string projectPath, params string[] args)
        {
            try
            {
                var startInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "git",
                    Arguments = "-C " + QuoteArgument(projectPath) + " " + JoinArguments(args),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };

                using (var process = Process.Start(startInfo))
                {
                    if (process == null)
                    {
                        return null;
                    }

                    if (!process.WaitForExit(3000))
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch
                        {
                            // Ignore cleanup failures for a timed-out helper process.
                        }

                        return null;
                    }

                    var stdout = process.StandardOutput.ReadToEnd();
                    process.StandardError.ReadToEnd();
                    return process.ExitCode == 0 ? stdout.Trim() : null;
                }
            }
            catch
            {
                return null;
            }
        }

        private static string ReadOrCreateWorkspaceId(string filePath)
        {
            try
            {
                if (File.Exists(filePath))
                {
                    var existing = File.ReadAllText(filePath).Trim();
                    if (!string.IsNullOrEmpty(existing))
                    {
                        return existing;
                    }
                }

                var directory = Path.GetDirectoryName(filePath);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                var workspaceId = Guid.NewGuid().ToString("D");
                File.WriteAllText(filePath, workspaceId + Environment.NewLine);
                return workspaceId;
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning($"[Unity Editor MCP] Failed to persist workspace ID at {filePath}: {ex.Message}");
                return Guid.NewGuid().ToString("D");
            }
        }

        private static object CreateGitPayload(GitMetadata git)
        {
            if (git == null)
            {
                return null;
            }

            return new
            {
                topLevel = git.TopLevel,
                gitDir = git.GitDir,
                commonDir = git.CommonDir,
                worktreeName = git.WorktreeName,
                branch = git.Branch,
                head = git.Head
            };
        }

        private static string ResolvePath(string basePath, string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return null;
            }

            return Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(basePath, value));
        }

        private static string GetWorktreeName(string gitDir, string commonDir)
        {
            if (string.IsNullOrEmpty(gitDir) || string.IsNullOrEmpty(commonDir))
            {
                return null;
            }

            var comparison = IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            var worktreesRoot = EnsureTrailingSeparator(Path.Combine(commonDir, "worktrees"));
            var normalizedGitDir = Path.GetFullPath(gitDir);

            if (normalizedGitDir.StartsWith(worktreesRoot, comparison))
            {
                var relative = normalizedGitDir.Substring(worktreesRoot.Length);
                var separators = new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar };
                var segments = relative.Split(separators, StringSplitOptions.RemoveEmptyEntries);
                if (segments.Length > 0)
                {
                    return segments[0];
                }
            }

            return "main";
        }

        private static string EnsureTrailingSeparator(string value)
        {
            var fullPath = Path.GetFullPath(value);
            if (fullPath.EndsWith(Path.DirectorySeparatorChar.ToString()) ||
                fullPath.EndsWith(Path.AltDirectorySeparatorChar.ToString()))
            {
                return fullPath;
            }

            return fullPath + Path.DirectorySeparatorChar;
        }

        private static string JoinArguments(string[] args)
        {
            if (args == null || args.Length == 0)
            {
                return string.Empty;
            }

            var quoted = new string[args.Length];
            for (var i = 0; i < args.Length; i++)
            {
                quoted[i] = QuoteArgument(args[i]);
            }

            return string.Join(" ", quoted);
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static string EmptyToNull(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }

        private static bool IsWindows()
        {
            return Path.DirectorySeparatorChar == '\\';
        }

        private static string GetHomeDirectory()
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return string.IsNullOrEmpty(home) ? Path.GetTempPath() : home;
        }

        private sealed class ProjectIdentity
        {
            public string WorkspaceId { get; set; }
            public string WorkspaceIdSource { get; set; }
            public GitMetadata Git { get; set; }
        }

        private sealed class GitMetadata
        {
            public string TopLevel { get; set; }
            public string GitDir { get; set; }
            public string CommonDir { get; set; }
            public string WorktreeName { get; set; }
            public string Branch { get; set; }
            public string Head { get; set; }
            public string WorkspaceIdPath { get; set; }
        }
    }
}
