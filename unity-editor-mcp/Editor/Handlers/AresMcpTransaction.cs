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
    /// Ares MCP: Transaction — 基于已批准 Recipe 执行场景写入，支持 Undo/回滚。
    ///
    /// 对应报告工具 ares.scene.apply_transaction（写入类，需 Approval Token）。
    ///
    /// 输入（与报告接口对齐）：
    /// {
    ///   "operation": "apply|commit|rollback",
    ///   "recipe": { "operations": [...] },
    ///   "expected_scene_hash": "...",
    ///   "approved_change_set_hash": "...",
    ///   "approval_token": "approval:reviewer:HASH",
    ///   "idempotency_key": "unique-task-id"
    /// }
    ///
    /// 安全约束：
    /// - 只写入 Generated Root 下
    /// - 删除操作默认关闭（需显式 allow_delete:true）
    /// - Scene Hash 乐观锁（expected_scene_hash 不匹配则拒绝）
    /// - 单 Undo Group 包裹全部操作
    /// - 异常自动 Undo
    /// </summary>
    public static class AresMcpTransaction
    {
        private const string GENERATED_ROOT = "Generated";

        public static object Execute(JObject parameters)
        {
            string operation = parameters?["operation"]?.ToString() ?? "apply";
            string expectedHash = parameters?["expected_scene_hash"]?.ToString();
            string approvedChangeSetHash = parameters?["approved_change_set_hash"]?.ToString();
            string approvalToken = parameters?["approval_token"]?.ToString();
            string idempotencyKey = parameters?["idempotency_key"]?.ToString();

            switch (operation)
            {
                case "apply":
                    return ApplyTransaction(parameters, expectedHash, approvedChangeSetHash, approvalToken, idempotencyKey);
                case "rollback":
                    return RollbackTransaction();
                default:
                    return new { error = $"Unknown operation: {operation}. Valid: apply, rollback" };
            }
        }

        private static object ApplyTransaction(JObject parameters, string expectedHash,
            string approvedChangeSetHash, string approvalToken, string idempotencyKey)
        {
            var ops = parameters?["recipe"]?["operations"] as JArray;
            if (ops == null || !ops.Any())
                return new { error = "recipe.operations is required and must be a non-empty array" };

            // 乐观锁：比对 Scene Hash
            string actualHash = GetSceneHash(null);
            if (!string.IsNullOrEmpty(expectedHash) && expectedHash != actualHash)
                return new
                {
                    error = "scene_changed_since_recipe",
                    expected_hash = expectedHash,
                    actual_hash = actualHash,
                    reason = "Scene was modified after DryRun. Re-run dry_run and get new approval."
                };

            if (string.IsNullOrEmpty(approvalToken))
                return new { error = "approval_token is required" };

            string transactionId = $"tx-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{idempotencyKey ?? "unknown"}";
            var log = new List<object>();
            int successCount = 0, failCount = 0, skipCount = 0;

            // Undo Group 开始
            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName($"Ares MCP Transaction: {transactionId}");

            try
            {
                var scene = SceneManager.GetActiveScene();
                GameObject root = EnsureGeneratedRoot(scene);

                foreach (var opToken in ops)
                {
                    var op = opToken as JObject;
                    if (op == null) continue;

                    string type = op["type"]?.ToString();
                    try
                    {
                        var result = ExecuteOperation(type, op, root, scene);
                        log.Add(result);
                        if (((dynamic)result).status == "ok") successCount++;
                        else if (((dynamic)result).status == "skipped") skipCount++;
                        else failCount++;
                    }
                    catch (Exception ex)
                    {
                        log.Add(new { type, status = "error", error = ex.Message });
                        failCount++;
                        throw; // 任何失败都回滚整个事务
                    }
                }

                // 提交
                string finalHash = GetSceneHash(null);

                return new
                {
                    transaction_id = transactionId,
                    status = failCount == 0 ? "committed" : "rolled_back",
                    scene_hash = finalHash,
                    undo_group = undoGroup,
                    summary = new
                    {
                        total = ops.Count,
                        success = successCount,
                        failed = failCount,
                        skipped = skipCount
                    },
                    log,
                    _note = "Undo group registered. Use ares.scene.apply_transaction { operation: 'rollback' } to undo."
                };
            }
            catch (Exception ex)
            {
                // 回滚
                Undo.CollapseUndoOperations(undoGroup);
                Undo.PerformUndo();

                string finalHash = GetSceneHash(null);
                return new
                {
                    transaction_id = transactionId,
                    status = "rolled_back",
                    scene_hash = finalHash,
                    error = ex.Message,
                    summary = new { total = ops.Count, success = successCount, failed = failCount + 1, skipped = skipCount },
                    log
                };
            }
        }

        private static object RollbackTransaction()
        {
            try
            {
                Undo.PerformUndo();
                string hash = GetSceneHash(null);
                return new { status = "rolled_back", scene_hash = hash, note = "Last undo group reverted." };
            }
            catch (Exception ex)
            {
                return new { status = "error", error = ex.Message, note = "Undo may have no operations left in stack." };
            }
        }

        private static object ExecuteOperation(string type, JObject op, GameObject root, Scene scene)
        {
            switch (type)
            {
                case "instantiate_prefab":
                    return InstantiatePrefab(op, root);
                case "modify_component":
                    return ModifyComponent(op, scene);
                case "delete_object":
                    return DeleteObject(op, scene);
                case "instantiate_prefab_batch":
                    return BatchInstantiatePrefab(op, root);
                default:
                    return new { type, status = "error", error = $"Unknown operation: {type}" };
            }
        }

        private static object InstantiatePrefab(JObject op, GameObject root)
        {
            string prefabPath = op["prefab_path"]?.ToString();
            string name = op["name"]?.ToString();
            var posArr = op["position"] as JArray;
            var rotArr = op["rotation"] as JArray;
            var scaleArr = op["scale"] as JArray;

            if (string.IsNullOrEmpty(prefabPath))
                return new { type = "instantiate_prefab", status = "error", error = "prefab_path is required" };

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            if (prefab == null)
                return new { type = "instantiate_prefab", status = "error", error = $"Prefab not found: {prefabPath}" };

            Vector3 pos = ParseVector3(posArr);
            Quaternion rot = ParseQuaternion(rotArr);
            Vector3 scl = scaleArr != null ? ParseVector3(scaleArr) : Vector3.one;

            // 幂等检查：同名对象已存在
            Transform existing = root.transform.Find(name ?? prefab.name);
            if (existing != null)
            {
                bool allowUpdate = op["allow_update"]?.ToObject<bool>() ?? false;
                if (allowUpdate)
                {
                    Undo.RecordObject(existing, "Update position");
                    existing.localPosition = pos;
                    existing.localRotation = rot;
                    existing.localScale = scl;
                    return new { type = "instantiate_prefab", status = "updated", object_name = existing.name, path = "/" + GENERATED_ROOT + "/" + existing.name };
                }
                return new { type = "instantiate_prefab", status = "skipped", object_name = existing.name, reason = "already exists, allow_update=false" };
            }

            GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, root.transform);
            instance.name = name ?? prefab.name;
            instance.transform.localPosition = pos;
            instance.transform.localRotation = rot;
            instance.transform.localScale = scl;
            Undo.RegisterCreatedObjectUndo(instance, "Instantiate " + instance.name);

            return new
            {
                type = "instantiate_prefab",
                status = "ok",
                object_name = instance.name,
                path = "/" + GENERATED_ROOT + "/" + instance.name,
                prefab_path = prefabPath
            };
        }

        private static object ModifyComponent(JObject op, Scene scene)
        {
            string targetPath = op["target_path"]?.ToString();
            string component = op["component"]?.ToString();
            string property = op["property"]?.ToString();
            var value = op["value"];

            if (string.IsNullOrEmpty(targetPath))
                return new { type = "modify_component", status = "error", error = "target_path is required" };

            GameObject target = FindByPath(scene, targetPath);
            if (target == null)
                return new { type = "modify_component", status = "error", error = $"Target not found: {targetPath}" };

            // 边界检查：只允许在 Generated Root 下修改
            if (!IsUnderGeneratedRoot(target))
                return new { type = "modify_component", status = "error", error = $"Target {targetPath} is not under Generated Root (read-only zone)" };

            var comp = target.GetComponent(component);
            if (comp == null)
                return new { type = "modify_component", status = "error", error = $"Component '{component}' not found on {targetPath}" };

            Undo.RecordObject(comp, $"Modify {component}.{property}");

            try
            {
                var fi = comp.GetType().GetField(property, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
                var pi = comp.GetType().GetProperty(property, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);

                object convertedValue = ConvertValue(value, fi?.FieldType ?? pi?.PropertyType);

                if (fi != null) fi.SetValue(comp, convertedValue);
                else if (pi != null) pi.SetValue(comp, convertedValue);
                else return new { type = "modify_component", status = "error", error = $"Field/property '{property}' not found on {component}" };

                EditorUtility.SetDirty(comp);
                return new { type = "modify_component", status = "ok", target = targetPath, component, property };
            }
            catch (Exception ex)
            {
                return new { type = "modify_component", status = "error", error = $"Failed to set {property}: {ex.Message}" };
            }
        }

        private static object DeleteObject(JObject op, Scene scene)
        {
            bool allowDelete = op["allow_delete"]?.ToObject<bool>() ?? false;
            if (!allowDelete)
                return new { type = "delete_object", status = "skipped", reason = "Delete operations require explicit allow_delete=true" };

            string targetPath = op["target_path"]?.ToString();
            if (string.IsNullOrEmpty(targetPath))
                return new { type = "delete_object", status = "error", error = "target_path is required" };

            GameObject target = FindByPath(scene, targetPath);
            if (target == null)
                return new { type = "delete_object", status = "error", error = $"Target not found: {targetPath}" };

            if (!IsUnderGeneratedRoot(target))
                return new { type = "delete_object", status = "error", error = $"Target {targetPath} is not under Generated Root" };

            Undo.DestroyObjectImmediate(target);
            return new { type = "delete_object", status = "ok", target = targetPath };
        }

        private static object BatchInstantiatePrefab(JObject op, GameObject root)
        {
            var items = op["items"] as JArray;
            if (items == null || !items.Any())
                return new { type = "instantiate_prefab_batch", status = "error", error = "items is required" };

            var results = new List<object>();
            int ok = 0, fail = 0;
            foreach (var item in items)
            {
                var r = InstantiatePrefab(item as JObject, root);
                results.Add(r);
                if (((dynamic)r).status == "ok") ok++; else fail++;
            }
            return new { type = "instantiate_prefab_batch", status = fail == 0 ? "ok" : "partial", batch_count = items.Count, ok, fail, items = results };
        }

        // ========== Helpers ==========

        private static GameObject EnsureGeneratedRoot(Scene scene)
        {
            foreach (var go in scene.GetRootGameObjects())
            {
                if (go != null && go.name == GENERATED_ROOT)
                    return go;
            }
            // 创建 Generated Root
            var root = new GameObject(GENERATED_ROOT);
            Undo.RegisterCreatedObjectUndo(root, "Create Generated Root");
            SceneManager.MoveGameObjectToScene(root, scene);
            return root;
        }

        private static GameObject FindByPath(Scene scene, string path)
        {
            path = path.TrimStart('/');
            foreach (var go in scene.GetRootGameObjects())
            {
                if (go == null) continue;
                Transform found = go.transform.Find(path);
                if (found != null) return found.gameObject;
            }
            return null;
        }

        private static bool IsUnderGeneratedRoot(GameObject go)
        {
            Transform t = go.transform;
            while (t != null)
            {
                if (t.name == GENERATED_ROOT && t.parent == null)
                    return true;
                t = t.parent;
            }
            return false;
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
            return new Vector3((float)(double)arr[0], (float)(double)arr[1], (float)(double)arr[2]);
        }

        private static Quaternion ParseQuaternion(JArray arr)
        {
            if (arr == null || arr.Count < 4) return Quaternion.identity;
            return new Quaternion((float)(double)arr[0], (float)(double)arr[1],
                                  (float)(double)arr[2], (float)(double)arr[3]);
        }

        private static object ConvertValue(JToken value, Type targetType)
        {
            if (targetType == null || value == null) return null;
            if (targetType == typeof(float) || targetType == typeof(double))
                return (float)(double)value;
            if (targetType == typeof(int))
                return (int)value;
            if (targetType == typeof(bool))
                return (bool)value;
            if (targetType == typeof(string))
                return value.ToString();
            if (targetType == typeof(Vector3) && value is JArray arr && arr.Count >= 3)
                return new Vector3((float)(double)arr[0], (float)(double)arr[1], (float)(double)arr[2]);
            return value.ToObject(targetType);
        }
    }
}
