using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEditor;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Ares MCP: DryRun — 解析 SceneRecipe，计算 ChangeSet，不修改场景。
    /// 
    /// 对应报告工具 ares.scene.dry_run（只读/计划类）。
    /// 输入：SceneRecipe JSON（操作清单）
    /// 输出：ChangeSet（预计变化摘要、有效/无效操作、边界警告）
    /// 
    /// Recipe 最小版 Schema：
    /// {
    ///   "scene_path": "Assets/...",
    ///   "root_name": "Generated",
    ///   "operations": [
    ///     { "type": "instantiate_prefab", "prefab_path": "Assets/Prefabs/X.prefab", "position": [0,0,0], "rotation": [0,0,0], "name": "新对象" },
    ///     { "type": "modify_component", "target_path": "/Generated/X", "component": "Transform", "property": "m_LocalPosition.x", "value": 5 }
    ///   ]
    /// }
    /// </summary>
    public static class AresMcpDryRun
    {
        /// <summary>
        /// 执行 DryRun 并返回 ChangeSet
        /// </summary>
        public static object Execute(JObject parameters)
        {
            var ops = parameters?["operations"] as JArray;
            if (ops == null || !ops.Any())
                return new { error = "operations is required and must be a non-empty array" };

            string scenePath = parameters["scene_path"]?.ToString();
            string rootName = parameters["root_name"]?.ToString() ?? "Generated";

            var results = new List<object>();
            var warnings = new List<string>();
            var errorsList = new List<string>();
            int validCount = 0, invalidCount = 0;
            int willCreate = 0, willModify = 0, willDelete = 0;

            // 验证场景路径
            var scene = GetScene(scenePath);
            string sceneHash = GetSceneHash(scenePath);

            // 查找 Generated Root（不创建）
            GameObject rootObj = null;
            if (!string.IsNullOrEmpty(scene.path))
            {
                var rootObjects = scene.GetRootGameObjects();
                rootObj = rootObjects.FirstOrDefault(go => go.name == rootName);
                if (rootObj == null)
                    warnings.Add($"Root '{rootName}' not found in scene; would be auto-created by apply_transaction");
            }

            foreach (var opToken in ops)
            {
                var op = opToken as JObject;
                if (op == null) continue;

                string type = op["type"]?.ToString();
                var dryResult = AnalyzeOperation(type, op, rootObj, scene);
                results.Add(dryResult);

                if (((dynamic)dryResult).valid == true) validCount++;
                else invalidCount++;

                switch (type)
                {
                    case "instantiate_prefab": willCreate++; break;
                    case "modify_component": willModify++; break;
                    case "delete_object": willDelete++; break;
                    case "instantiate_prefab_batch":
                        willCreate += (int)(((dynamic)dryResult).batch_count ?? 1);
                        break;
                }
            }

            // 边界检查
            bool boundaryOk = rootObj != null;
            if (!boundaryOk && validCount > 0)
                warnings.Add($"Generated Root '{rootName}' not present; apply_transaction would create it");

            return new
            {
                dry_run_at = DateTime.UtcNow.ToString("o"),
                scene_hash = sceneHash,
                scene_path = scenePath,
                root_name = rootName,
                summary = new
                {
                    total_ops = ops.Count,
                    valid = validCount,
                    invalid = invalidCount,
                    will_create = willCreate,
                    will_modify = willModify,
                    will_delete = willDelete,
                    boundary_ok = boundaryOk,
                    ready_for_execution = invalidCount == 0 && warnings.Count == 0
                },
                operations = results,
                warnings = warnings,
                errors = errorsList,
                _note = "DryRun is a read-only analysis. No scene changes were made. Run ares.scene.apply_transaction with the returned change_set_id to execute."
            };
        }

        private static object AnalyzeOperation(string type, JObject op, GameObject root, Scene scene)
        {
            try
            {
                switch (type)
                {
                    case "instantiate_prefab":
                        return AnalyzePrefabInstantiate(op, root);
                    case "modify_component":
                        return AnalyzeModifyComponent(op, scene);
                    case "delete_object":
                        return AnalyzeDeleteObject(op, scene);
                    case "instantiate_prefab_batch":
                        return AnalyzeBatchPrefab(op, root);
                    default:
                        return new { type, valid = false, error = $"Unknown operation type: {type}" };
                }
            }
            catch (Exception ex)
            {
                return new { type, valid = false, error = ex.Message };
            }
        }

        private static object AnalyzePrefabInstantiate(JObject op, GameObject root)
        {
            string prefabPath = op["prefab_path"]?.ToString();
            string name = op["name"]?.ToString();
            var pos = op["position"] as JArray;
            var rot = op["rotation"] as JArray;
            var scale = op["scale"] as JArray;

            if (string.IsNullOrEmpty(prefabPath))
                return new { type = "instantiate_prefab", valid = false, error = "prefab_path is required" };

            // 检查 Prefab 是否存在
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            if (prefab == null)
                return new { type = "instantiate_prefab", valid = false, error = $"Prefab not found: {prefabPath}" };

            // 检查名称冲突
            bool nameConflict = false;
            if (root != null && !string.IsNullOrEmpty(name))
            {
                foreach (Transform child in root.transform)
                {
                    if (child.name == name) { nameConflict = true; break; }
                }
            }

            var analysis = new
            {
                type = "instantiate_prefab",
                valid = true,
                prefab_path = prefabPath,
                prefab_name = prefab.name,
                target_name = name ?? prefab.name,
                position = ParseVector3(pos),
                rotation = ParseQuaternion(rot),
                scale = scale != null ? ParseVector3(scale) : Vector3.one,
                name_conflict = nameConflict,
                warnings = new List<object>()
            };

            if (nameConflict)
                (analysis.warnings as List<object>).Add($"Name '{name}' already exists under root '{root?.name}'; apply_transaction may rename or skip");

            return analysis;
        }

        private static object AnalyzeModifyComponent(JObject op, Scene scene)
        {
            string targetPath = op["target_path"]?.ToString();
            string component = op["component"]?.ToString();
            string property = op["property"]?.ToString();

            if (string.IsNullOrEmpty(targetPath))
                return new { type = "modify_component", valid = false, error = "target_path is required" };

            // 查找目标 GameObject
            GameObject target = null;
            if (scene.isLoaded)
            {
                foreach (var go in scene.GetRootGameObjects())
                {
                    if (go != null)
                    {
                        var found = go.transform.Find(targetPath.TrimStart('/'));
                        if (found != null) { target = found.gameObject; break; }
                    }
                }
            }

            return new
            {
                type = "modify_component",
                valid = target != null,
                target_path = targetPath,
                component,
                property,
                target_exists = target != null,
                error = target != null ? null : $"Target not found: {targetPath}"
            };
        }

        private static object AnalyzeDeleteObject(JObject op, Scene scene)
        {
            string targetPath = op["target_path"]?.ToString();
            if (string.IsNullOrEmpty(targetPath))
                return new { type = "delete_object", valid = false, error = "target_path is required" };

            GameObject target = null;
            if (scene.isLoaded)
            {
                foreach (var go in scene.GetRootGameObjects())
                {
                    var found = go.transform.Find(targetPath.TrimStart('/'));
                    if (found != null) { target = found.gameObject; break; }
                }
            }

            return new
            {
                type = "delete_object",
                valid = target != null,
                target_path = targetPath,
                target_exists = target != null,
                error = target != null ? null : $"Target not found: {targetPath}"
            };
        }

        private static object AnalyzeBatchPrefab(JObject op, GameObject root)
        {
            var items = op["items"] as JArray;
            if (items == null || !items.Any())
                return new { type = "instantiate_prefab_batch", valid = false, error = "items is required" };

            var results = new List<object>();
            int valid = 0, invalid = 0;

            foreach (var item in items)
            {
                var itemOp = item as JObject;
                if (itemOp == null) continue;
                itemOp["type"] = "instantiate_prefab";
                var r = AnalyzePrefabInstantiate(itemOp, root);
                if (((dynamic)r).valid == true) valid++; else invalid++;
                results.Add(r);
            }

            return new
            {
                type = "instantiate_prefab_batch",
                valid = invalid == 0,
                batch_count = items.Count,
                valid_count = valid,
                invalid_count = invalid,
                items = results
            };
        }

        private static Scene GetScene(string scenePath)
        {
            if (!string.IsNullOrEmpty(scenePath))
            {
                var s = SceneManager.GetSceneByPath(scenePath);
                if (s.IsValid()) return s;
            }
            return SceneManager.GetActiveScene();
        }

        private static string GetSceneHash(string scenePath)
        {
            if (string.IsNullOrEmpty(scenePath))
                scenePath = SceneManager.GetActiveScene().path;
            try
            {
                string fullPath = System.IO.Path.Combine(Application.dataPath, "..", scenePath);
                if (System.IO.File.Exists(fullPath))
                {
                    byte[] bytes = System.IO.File.ReadAllBytes(fullPath);
                    return BitConverter.ToString(System.Security.Cryptography.MD5.Create().ComputeHash(bytes))
                        .Replace("-", "").ToLower();
                }
            }
            catch { }
            return "unknown";
        }

        private static Vector3 ParseVector3(JArray arr)
        {
            if (arr == null || arr.Count < 3) return Vector3.zero;
            return new Vector3((float)arr[0], (float)arr[1], (float)arr[2]);
        }

        private static Quaternion ParseQuaternion(JArray arr)
        {
            if (arr == null || arr.Count < 4) return Quaternion.identity;
            return new Quaternion((float)arr[0], (float)arr[1], (float)arr[2], (float)arr[3]);
        }
    }
}
