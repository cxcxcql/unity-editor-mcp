using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEditor;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Ares MCP: Asset Search — 资产搜索（GUID、路径、类型、标签）。
    ///
    /// 对应报告工具 ares.assets.search（只读类）。
    /// 输入：query（名称关键词）、type（prefab/material/script/...）、tag、folder（搜索目录）、limit
    /// 输出：GUID、路径、类型、匹配分数
    /// </summary>
    public static class AresMcpAssetSearch
    {
        public static object Execute(JObject parameters)
        {
            string query = parameters?["query"]?.ToString();
            string type = parameters?["type"]?.ToString();
            string tag = parameters?["tag"]?.ToString();
            string folder = parameters?["folder"]?.ToString();
            int limit = parameters?["limit"]?.ToObject<int>() ?? 50;

            // 构建 FindAssets 过滤器
            string filter = "";
            if (!string.IsNullOrEmpty(type))
            {
                switch (type.ToLower())
                {
                    case "prefab": filter += "t:Prefab"; break;
                    case "script": filter += "t:Script"; break;
                    case "material": filter += "t:Material"; break;
                    case "texture": filter += "t:Texture"; break;
                    case "scene": filter += "t:Scene"; break;
                    case "audio": filter += "t:AudioClip"; break;
                    case "animation": filter += "t:AnimationClip"; break;
                    case "font": filter += "t:Font"; break;
                    case "shader": filter += "t:Shader"; break;
                    default: filter += $"t:{type}"; break;
                }
            }
            if (!string.IsNullOrEmpty(query))
                filter = (filter.Length > 0 ? filter + " " : "") + query;

            string[] searchFolders = null;
            if (!string.IsNullOrEmpty(folder))
                searchFolders = new[] { folder };

            string[] guids = AssetDatabase.FindAssets(filter, searchFolders);
            if (guids.Length > limit) guids = guids.Take(limit).ToArray();

            var results = new List<object>();
            foreach (var guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path);
                if (asset == null) continue;

                // 匹配分数：名称完全匹配 > 前缀 > 包含
                int score = 50;
                string name = asset.name;
                if (!string.IsNullOrEmpty(query))
                {
                    if (name.Equals(query, StringComparison.OrdinalIgnoreCase)) score = 100;
                    else if (name.StartsWith(query, StringComparison.OrdinalIgnoreCase)) score = 80;
                    else if (name.Contains(query, StringComparison.OrdinalIgnoreCase)) score = 60;
                    else score = 40;
                }

                var entry = new
                {
                    guid,
                    name,
                    path,
                    asset_type = asset.GetType().Name,
                    score,
                    is_prefab = asset is GameObject
                };
                results.Add(entry);
            }

            results = results.OrderByDescending(r => ((dynamic)r).score).ToList();

            // 标签过滤（如果指定）
            if (!string.IsNullOrEmpty(tag))
                results = results.Where(r =>
                {
                    var go = AssetDatabase.LoadAssetAtPath<GameObject>(((dynamic)r).path);
                    return go != null && go.tag == tag;
                }).ToList();

            return new
            {
                search_at = DateTime.UtcNow.ToString("o"),
                query,
                type,
                folder,
                result_count = results.Count,
                total_matches = guids.Length,
                results,
                _note = "Read-only asset search. GUIDs are stable and usable in recipes."
            };
        }
    }
}
