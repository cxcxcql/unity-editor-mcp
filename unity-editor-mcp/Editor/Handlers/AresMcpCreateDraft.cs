using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEditor;
using UnityEditor.SceneManagement;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Ares MCP: Create Draft — 从模板场景创建草稿场景（写入 Generated 目录）。
    ///
    /// 对应报告工具 ares.scene.create_draft（写入类）。
    /// 输入：template_scene（可选，默认空场景）、output_path（必填，如 Assets/Ares/Scenes/Generated/X.unity）、task_id
    /// 输出：Draft Scene + Generated Root + 初始 Hash
    ///
    /// 安全约束：
    /// - 只允许写入 Assets/Ares/Scenes/Generated/ 目录
    /// - 不修改模板场景
    /// - 创建 Generated Root（含生成标记组件）
    /// </summary>
    public static class AresMcpCreateDraft
    {
        private const string GENERATED_ROOT = "Generated";
        private const string GENERATED_DIR = "Assets/Ares/Scenes/Generated";

        public static object Execute(JObject parameters)
        {
            string templateScene = parameters?["template_scene"]?.ToString();
            string outputPath = parameters?["output_path"]?.ToString();
            string taskId = parameters?["task_id"]?.ToString() ?? $"draft-{DateTime.Now:yyyyMMdd-HHmmss}";

            if (string.IsNullOrEmpty(outputPath))
                return new { error = "output_path is required (e.g. Assets/Ares/Scenes/Generated/Town_Event_Draft.unity)" };

            // 边界检查：只允许 Generated 目录
            if (!outputPath.StartsWith(GENERATED_DIR, StringComparison.OrdinalIgnoreCase))
                return new { error = $"output_path must be under {GENERATED_DIR} (boundary enforcement)" };

            if (!outputPath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
                outputPath += ".unity";

            try
            {
                // 确保目录存在
                string dir = Path.GetDirectoryName(outputPath).Replace('\\', '/');
                EnsureFolder(dir);

                // 复制模板场景（如果指定且存在）
                if (!string.IsNullOrEmpty(templateScene))
                {
                    if (!File.Exists(Path.Combine(Application.dataPath, "..", templateScene)))
                        return new { error = $"Template scene not found: {templateScene}" };
                    if (AssetDatabase.CopyAsset(templateScene, outputPath))
                        Debug.Log($"[AresMcpCreateDraft] Copied template: {templateScene} -> {outputPath}");
                    else
                        return new { error = $"Failed to copy template: {templateScene}" };
                }
                else
                {
                    // 创建空场景
                    var newScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                    EditorSceneManager.SaveScene(newScene, outputPath);
                }

                // 打开草稿场景并注入 Generated Root
                var scene = EditorSceneManager.OpenScene(outputPath, OpenSceneMode.Single);

                // 检查是否已有 Generated Root
                var root = scene.GetRootGameObjects().FirstOrDefault(go => go.name == GENERATED_ROOT);
                if (root == null)
                {
                    root = new GameObject(GENERATED_ROOT);
                    SceneManager.MoveGameObjectToScene(root, scene);
                    Undo.RegisterCreatedObjectUndo(root, "Create Generated Root");
                }

                // 标记组件（用于识别生成区域）
                var marker = root.GetComponent<AresGeneratedMarker>();
                if (marker == null)
                    marker = root.AddComponent<AresGeneratedMarker>();
                marker.TaskId = taskId;
                marker.CreatedAt = DateTime.UtcNow.ToString("o");

                EditorSceneManager.SaveScene(scene);
                AssetDatabase.Refresh();

                string hash = GetSceneHash(outputPath);

                return new
                {
                    draft_created = true,
                    task_id = taskId,
                    scene_path = outputPath,
                    scene_hash = hash,
                    generated_root = "/" + GENERATED_ROOT,
                    marker = "AresGeneratedMarker",
                    _note = "Draft scene ready. Use ares.scene.dry_run + ares.scene.apply_transaction to populate."
                };
            }
            catch (Exception ex)
            {
                return new { error = ex.Message };
            }
        }

        private static void EnsureFolder(string folderPath)
        {
            string[] parts = folderPath.Split('/');
            string cur = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                string next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next))
                    AssetDatabase.CreateFolder(cur, parts[i]);
                cur = next;
            }
        }

        private static string GetSceneHash(string scenePath)
        {
            try
            {
                string fullPath = Path.Combine(Application.dataPath, "..", scenePath);
                if (File.Exists(fullPath))
                {
                    byte[] bytes = File.ReadAllBytes(fullPath);
                    return BitConverter.ToString(System.Security.Cryptography.MD5.Create().ComputeHash(bytes))
                        .Replace("-", "").ToLower();
                }
            }
            catch { }
            return "unknown";
        }
    }

    /// <summary>
    /// 生成区域标记组件 — 标识 Generated Root 及其任务归属。
    /// </summary>
    public class AresGeneratedMarker : MonoBehaviour
    {
        public string TaskId = "";
        public string CreatedAt = "";
    }
}
