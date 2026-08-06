using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEditor;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Ares MCP: 上下文快照工具 — 一键获取场景/编译/Console摘要，作为高层只读入口。
    /// 
    /// 对应报告工具 ares.context.snapshot（只读、无副作用）。
    /// 用法（TCP帧）：{"id":"x","type":"ares.context.snapshot","params":{"maxHierarchyDepth":2,"recentLogs":20}}
    /// </summary>
    public static class AresMcpSnapshot
    {
        private const int DEFAULT_MAX_DEPTH = 2;
        private const int DEFAULT_RECENT_LOGS = 20;

        /// <summary>
        /// 执行快照并返回结构化结果
        /// </summary>
        public static object Execute(JObject parameters)
        {
            try
            {
                int maxDepth = parameters?["maxHierarchyDepth"]?.ToObject<int>() ?? DEFAULT_MAX_DEPTH;
                int recentLogs = parameters?["recentLogs"]?.ToObject<int>() ?? DEFAULT_RECENT_LOGS;
                string scenePath = parameters?["scenePath"]?.ToString();

                var sceneData = GetSceneData(scenePath);
                var hierarchyData = GetHierarchyData(maxDepth);
                var compilationData = GetCompilationData();
                var consoleData = GetConsoleData(recentLogs);

                return new
                {
                    snapshot_at = DateTime.UtcNow.ToString("o"),
                    unity_version = Application.unityVersion,
                    scene = sceneData,
                    hierarchy = hierarchyData,
                    compilation = compilationData,
                    console = consoleData
                };
            }
            catch (Exception ex)
            {
                Debug.LogError($"[AresMcpSnapshot] Snapshot failed: {ex.Message}");
                return new { error = ex.Message, stack = ex.StackTrace };
            }
        }

        private static object GetSceneData(string scenePath)
        {
            Scene scene = string.IsNullOrEmpty(scenePath)
                ? SceneManager.GetActiveScene()
                : SceneManager.GetSceneByPath(scenePath);

            string assetPath = scene.path;
            string hash = null;

            if (!string.IsNullOrEmpty(assetPath) && scene.isLoaded)
            {
                try
                {
                    // 优先用 AssetDatabase hash（反映 .unity 文件内容），不可用则 fallback 到场景名+对象数
                    UnityEngine.Object sceneAsset = AssetDatabase.LoadAssetAtPath<SceneAsset>(assetPath);
                    if (sceneAsset != null)
                    {
                        // 注意：GetAssetDependencyHash 在 2020.3 可能不可用，用文件 MD5 fallback
#if UNITY_2022_1_OR_NEWER
                        hash = AssetDatabase.GetAssetDependencyHash(assetPath).ToString();
#else
                        string fullPath = Path.Combine(Application.dataPath, "..", assetPath);
                        if (File.Exists(fullPath))
                        {
                            byte[] bytes = File.ReadAllBytes(fullPath);
                            hash = BitConverter.ToString(MD5.Create().ComputeHash(bytes)).Replace("-", "").ToLower();
                        }
#endif
                    }
                }
                catch { /* hash 获取失败不阻断快照 */ }
            }

            if (hash == null)
            {
                // fallback: 轻量 identity
                hash = $"name:{scene.name}|roots:{scene.rootCount}|path:{assetPath?.GetHashCode():x}";
            }

            return new
            {
                name = scene.name,
                path = assetPath,
                loaded = scene.isLoaded,
                is_active = scene == SceneManager.GetActiveScene(),
                build_index = scene.buildIndex,
                hash,
                root_count = scene.rootCount
            };
        }

        private static object GetHierarchyData(int maxDepth)
        {
            var roots = new List<object>();
            var rootObjects = SceneManager.GetActiveScene().GetRootGameObjects();
            int totalCount = 0;

            foreach (var go in rootObjects)
            {
                totalCount++;
                var node = BuildHierarchyNode(go, 0, maxDepth, ref totalCount);
                roots.Add(node);
            }

            return new
            {
                object_count = totalCount,
                root_objects = roots,
                max_depth = maxDepth
            };
        }

        private static object BuildHierarchyNode(GameObject go, int currentDepth, int maxDepth, ref int counter)
        {
            var components = new List<string>();
            foreach (var comp in go.GetComponents<Component>())
            {
                if (comp != null) components.Add(comp.GetType().Name);
            }

            var children = new List<object>();
            if (currentDepth < maxDepth)
            {
                foreach (Transform child in go.transform)
                {
                    counter++;
                    children.Add(BuildHierarchyNode(child.gameObject, currentDepth + 1, maxDepth, ref counter));
                }
            }
            else if (go.transform.childCount > 0)
            {
                // 超深度：只标数量
                return new
                {
                    name = go.name,
                    path = GetGameObjectPath(go),
                    active = go.activeSelf,
                    tag = go.tag,
                    layer = LayerMask.LayerToName(go.layer),
                    children_truncated = go.transform.childCount,
                    components = components
                };
            }

            return new
            {
                name = go.name,
                path = GetGameObjectPath(go),
                active = go.activeSelf,
                tag = go.tag,
                layer = LayerMask.LayerToName(go.layer),
                children = children,
                components = components
            };
        }

        private static string GetGameObjectPath(GameObject go)
        {
            string path = go.name;
            Transform parent = go.transform.parent;
            while (parent != null)
            {
                path = parent.name + "/" + path;
                parent = parent.parent;
            }
            return "/" + path;
        }

        private static object GetCompilationData()
        {
            return new
            {
                is_compiling = EditorApplication.isCompiling,
                is_updating = EditorApplication.isUpdating,
                playing = Application.isPlaying,
                time_since_startup = (int)EditorApplication.timeSinceStartup
            };
        }

        private static object GetConsoleData(int recentLogs)
        {
            // Unity 2020.3 的 Console Window 日志获取用反射（Application.GetStackTraceLogType 等也可用）
            // 更可靠的方式：读 Editor 日志文件
            var errors = new List<string>();
            var warnings = new List<string>();

            try
            {
                string logPath = Application.consoleLogPath;
                if (File.Exists(logPath))
                {
                    string[] lines = File.ReadAllLines(logPath);
                    int eCount = 0, wCount = 0;
                    for (int i = lines.Length - 1; i >= 0 && (eCount + wCount) < recentLogs; i--)
                    {
                        string line = lines[i];
                        if (line.Contains(") (at ") || line.Length < 20) continue;

                        if (line.Contains("Scripting.LogException") || line.Contains(": error CS") ||
                            line.Contains("Exception:") || line.Contains("Error:"))
                        {
                            errors.Add(line.Length > 200 ? line.Substring(0, 200) + "..." : line);
                            eCount++;
                        }
                        else if (line.Contains("Warning:") || line.Contains("[Warning]") || line.Contains("CS0"))
                        {
                            warnings.Add(line.Length > 200 ? line.Substring(0, 200) + "..." : line);
                            wCount++;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                errors.Add($"[AresMcpSnapshot] Failed to read console log: {ex.Message}");
            }

            // 同时从 Application.GetStackTraceLogType 看是否有未读异常
            // （2020.3 不支持 Application.consoleLogPath 的实时读取，但 Log 文件在磁盘上已写入）

            return new
            {
                error_count = errors.Count,
                warning_count = warnings.Count,
                sample = errors.Concat(warnings.Select(w => "[WARN] " + w)).Take(recentLogs).ToList(),
                log_file = Application.consoleLogPath,
                _note = "Snapshot read from Editor.log; real-time Console reading limited in 2020.3"
            };
        }
    }
}
