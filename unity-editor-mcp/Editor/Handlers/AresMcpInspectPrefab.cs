using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEditor;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Ares MCP: Inspect Prefab — 只读 Prefab 元数据检查（Bounds、Pivot、组件、依赖）。
    ///
    /// 对应报告工具 ares.assets.inspect_prefab（只读类）。
    /// 输入：guid 或 path（二选一）
    /// 输出：Bounds、Pivot、Socket（空 Transform 子节点）、组件清单、依赖、缩略图路径
    /// 不打开 Prefab Mode，不修改任何内容。
    /// </summary>
    public static class AresMcpInspectPrefab
    {
        public static object Execute(JObject parameters)
        {
            string guid = parameters?["guid"]?.ToString();
            string path = parameters?["path"]?.ToString();

            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(guid))
                path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path))
                return new { error = "Either guid or path is required" };

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null)
                return new { error = $"Prefab not found: {path}" };

            // 组件清单（去重计数）
            var componentCounts = new Dictionary<string, int>();
            foreach (var comp in prefab.GetComponentsInChildren<Component>(true))
            {
                if (comp == null)
                {
                    string key = "<missing>";
                    componentCounts[key] = componentCounts.ContainsKey(key) ? componentCounts[key] + 1 : 1;
                    continue;
                }
                string name = comp.GetType().Name;
                componentCounts[name] = componentCounts.ContainsKey(name) ? componentCounts[name] + 1 : 1;
            }

            // 子节点层级摘要（深度 2）
            var hierarchy = new List<object>();
            foreach (Transform child in prefab.transform)
            {
                hierarchy.Add(BuildNode(child, 2));
            }

            // Bounds 计算（Renderer 包围盒 + 子级 Renderer）
            var bounds = GetPrefabBounds(prefab);
            bool hasBounds = bounds.size.sqrMagnitude > 0.01f;

            // Socket 检测：空 Transform（只有自身，无组件、无子节点）→ 挂点
            var sockets = new List<string>();
            foreach (Transform child in prefab.GetComponentsInChildren<Transform>(true))
            {
                if (child != prefab.transform &&
                    child.childCount == 0 &&
                    child.GetComponents<Component>().Length == 1 &&
                    !child.name.StartsWith("__"))
                {
                    sockets.Add(child.name);
                }
            }

            // 依赖
            var dependencies = new List<string>();
            foreach (var dep in AssetDatabase.GetDependencies(path, false))
            {
                if (dep != path && !dep.EndsWith(".cs"))
                    dependencies.Add(dep);
            }

            // 缩略图：生成到临时目录
            string thumbnailPath = null;
            try
            {
                var thumbnail = AssetPreview.GetAssetPreview(prefab);
                if (thumbnail != null)
                {
                    string thumbDir = "Assets/Ares/MCP/Catalog/ThumbnailCache";
                    EnsureFolder(thumbDir);
                    thumbnailPath = $"{thumbDir}/{guid ?? Guid.NewGuid().ToString("N")}.png";
                    byte[] png = thumbnail.EncodeToPNG();
                    System.IO.File.WriteAllBytes(
                        System.IO.Path.Combine(Application.dataPath, "..", thumbnailPath), png);
                    AssetDatabase.Refresh();
                }
            }
            catch { /* 缩略图失败不阻断 */ }

            return new
            {
                inspect_at = DateTime.UtcNow.ToString("o"),
                name = prefab.name,
                path,
                guid = guid ?? AssetDatabase.AssetPathToGUID(path),
                bounds = hasBounds ? new { center = bounds.center, size = bounds.size, extents = bounds.extents } : null,
                pivot = prefab.transform.position,
                rotation = prefab.transform.rotation.eulerAngles,
                layer = prefab.layer,
                tag = prefab.tag,
                is_ui = prefab.GetComponent<RectTransform>() != null,
                child_count = prefab.transform.childCount,
                sockets,
                components = componentCounts,
                hierarchy,
                dependencies = dependencies.Take(30).ToList(),
                thumbnail = thumbnailPath,
                _note = "Read-only inspection. Prefab was NOT opened in Prefab Mode."
            };
        }

        private static object BuildNode(Transform t, int maxDepth)
        {
            var node = new
            {
                name = t.name,
                local_position = t.localPosition,
                local_scale = t.localScale,
                child_count = t.childCount,
                children = new List<object>()
            };
            if (maxDepth > 0)
            {
                var children = new List<object>();
                foreach (Transform c in t)
                    children.Add(BuildNode(c, maxDepth - 1));
                return new { name = t.name, local_position = t.localPosition, local_scale = t.localScale, children };
            }
            return node;
        }

        private static Bounds GetPrefabBounds(GameObject prefab)
        {
            var bounds = new Bounds(Vector3.zero, Vector3.zero);
            bool found = false;
            // 未实例化时用 Renderer 的 bounds 不可靠，改用 Mesh + Transform 计算
            foreach (var renderer in prefab.GetComponentsInChildren<Renderer>(true))
            {
                var meshFilter = renderer.GetComponent<MeshFilter>();
                if (meshFilter != null && meshFilter.sharedMesh != null)
                {
                    var meshBounds = meshFilter.sharedMesh.bounds;
                    var worldBounds = new Bounds(renderer.transform.TransformPoint(meshBounds.center),
                        Vector3.Scale(meshBounds.size, renderer.transform.lossyScale));
                    if (!found) { bounds = worldBounds; found = true; }
                    else bounds.Encapsulate(worldBounds);
                }
                else
                {
                    // Collider 兜底
                    var collider = renderer.GetComponent<Collider>();
                    if (collider != null)
                    {
                        if (!found) { bounds = collider.bounds; found = true; }
                        else bounds.Encapsulate(collider.bounds);
                    }
                }
            }
            // SpriteRenderer 兜底
            if (!found)
            {
                foreach (var sr in prefab.GetComponentsInChildren<SpriteRenderer>(true))
                {
                    if (!found) { bounds = sr.bounds; found = true; }
                    else bounds.Encapsulate(sr.bounds);
                }
            }
            return bounds;
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
    }
}
