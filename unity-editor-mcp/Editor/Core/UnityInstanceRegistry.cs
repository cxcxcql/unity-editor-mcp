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

        private static readonly int ProcessId = Process.GetCurrentProcess().Id;
        private static readonly string InstanceId = Guid.NewGuid().ToString("N");
        private static readonly string StartedAt = DateTime.UtcNow.ToString("o");

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

        public static void Write(int port, McpStatus status)
        {
            try
            {
                Directory.CreateDirectory(RegistryDirectory);
                File.WriteAllText(RegistryFilePath, JsonConvert.SerializeObject(CreatePayload(port, status), Formatting.Indented));
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

        private static object CreatePayload(int port, McpStatus status, bool includeRegistryPath = false)
        {
            var activeScene = EditorSceneManager.GetActiveScene();
            return new
            {
                schemaVersion = 1,
                instanceId = InstanceId,
                projectPath = ProjectPath,
                projectName = new DirectoryInfo(ProjectPath).Name,
                pid = ProcessId,
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

        private static string GetHomeDirectory()
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return string.IsNullOrEmpty(home) ? Path.GetTempPath() : home;
        }
    }
}
