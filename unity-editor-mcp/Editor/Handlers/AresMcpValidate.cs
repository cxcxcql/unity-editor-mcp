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
    /// Ares MCP: Validate — 场景健康检查（Missing Script / Missing Reference / Prefab 断链 / 预算）。
    ///
    /// 对应报告工具 ares.scene.validate（只读/测试类）。
    /// 输入：scene_path（可选，默认当前）、checks（可选，指定检查项）
    /// 输出：errors / warnings / budgets / 对象定位
    /// </summary>
    public static class AresMcpValidate
    {
        public static object Execute(JObject parameters)
        {
            string scenePath = parameters?["scene_path"]?.ToString();
            var checks = parameters?["checks"] as JArray;

            Scene scene = GetScene(scenePath);
            var errors = new List<object>();
            var warnings = new List<object>();

            var allObjects = CollectAllGameObjects(scene);
            int total = allObjects.Count;

            // 1. Missing Script 检查
            var missingScripts = allObjects
                .Where(go => go.GetComponents<Component>().Any(c => c == null))
                .Select(go => new
                {
                    object_name = go.name,
                    path = GetPath(go),
                    issue = "missing_script"
                })
                .ToList();
            foreach (var m in missingScripts) errors.Add(m);

            // 2. Missing Reference 检查（序列化字段为 null 但引用非空类型）
            var missingRefs = CheckMissingReferences(allObjects);
            foreach (var m in missingRefs) errors.Add(m);

            // 3. Prefab 断链检查
            var brokenPrefabs = allObjects
                .Where(go => PrefabUtility.IsPartOfPrefabInstance(go))
                .Where(go =>
                {
                    var source = PrefabUtility.GetCorrespondingObjectFromSource(go);
                    return source == null;
                })
                .Select(go => new
                {
                    object_name = go.name,
                    path = GetPath(go),
                    issue = "broken_prefab_link"
                })
                .ToList();
            foreach (var b in brokenPrefabs) errors.Add(b);

            // 4. 预算统计
            var dynamicLights = allObjects.Where(go => go.GetComponent<Light>() != null).Count();
            var particleSystems = allObjects.Where(go => go.GetComponent<ParticleSystem>() != null).Count();
            var colliders = allObjects.Where(go => go.GetComponent<Collider>() != null).Count();
            var audioSources = allObjects.Where(go => go.GetComponent<AudioSource>() != null).Count();
            var animators = allObjects.Where(go => go.GetComponent<Animator>() != null).Count();
            var rectTransforms = allObjects.Where(go => go.GetComponent<RectTransform>() != null).Count();

            // 5. 空对象检查（只有 Transform 的对象）
            var emptyObjects = allObjects
                .Where(go => go.GetComponents<Component>().Length == 1 && go.transform.childCount == 0)
                .Select(go => new { object_name = go.name, path = GetPath(go), issue = "empty_object" })
                .Take(20)
                .ToList();
            foreach (var e in emptyObjects) warnings.Add(e);

            // 6. 静态检查：没有引用任何东西的孤儿
            var inactiveObjects = allObjects.Where(go => !go.activeInHierarchy).Count();
            if (inactiveObjects > 20)
                warnings.Add(new { issue = "many_inactive_objects", count = inactiveObjects });

            return new
            {
                validate_at = DateTime.UtcNow.ToString("o"),
                scene = scene.name,
                scene_path = scene.path,
                object_count = total,
                summary = new
                {
                    errors = errors.Count,
                    warnings = warnings.Count,
                    missing_scripts = missingScripts.Count,
                    missing_references = missingRefs.Count,
                    broken_prefab_links = brokenPrefabs.Count,
                    empty_objects = emptyObjects.Count,
                    inactive_objects = inactiveObjects
                },
                budgets = new
                {
                    dynamic_lights = dynamicLights,
                    particle_systems = particleSystems,
                    colliders = colliders,
                    audio_sources = audioSources,
                    animators = animators,
                    rect_transforms = rectTransforms
                },
                errors = errors.Take(50).ToList(),
                warnings = warnings.Take(50).ToList(),
                _note = "Read-only validation. Errors block commit; warnings require manual review."
            };
        }

        private static List<GameObject> CollectAllGameObjects(Scene scene)
        {
            var result = new List<GameObject>();
            foreach (var root in scene.GetRootGameObjects())
            {
                if (root == null) continue;
                CollectRecursive(root, result);
            }
            return result;
        }

        private static void CollectRecursive(GameObject go, List<GameObject> list)
        {
            if (go == null) return;
            list.Add(go);
            foreach (Transform child in go.transform)
            {
                if (child != null) CollectRecursive(child.gameObject, list);
            }
        }

        private static List<object> CheckMissingReferences(List<GameObject> allObjects)
        {
            var result = new List<object>();
            // 仅检查已知会断引用的序列化字段：通过 SerializedObject 遍历
            // （开销较大，限制在生成区内或前 200 个对象）
            int scanned = 0;
            foreach (var go in allObjects)
            {
                if (scanned++ > 200) break;
                var so = new SerializedObject(go);
                var it = so.GetIterator();
                while (it.Next(true))
                {
                    if (it.propertyType == SerializedPropertyType.ObjectReference && it.objectReferenceValue == null && !string.IsNullOrEmpty(it.propertyPath))
                    {
                        // 跳过常见无害字段（m_GameObject, m_Script 等）
                        if (it.propertyPath == "m_GameObject" || it.propertyPath == "m_Script") continue;
                        if (it.propertyPath.Contains("m_Enabled")) continue;
                        if (it.propertyPath.StartsWith("m_")) continue;
                        // 只报名字空间带引用的字段（简化：非空路径且引用类型为 UnityEngine.Object 子类）
                        if (it.objectReferenceInstanceIDValue == 0 && it.propertyPath.Contains("m_"))
                            continue;
                        result.Add(new
                        {
                            object_name = go.name,
                            path = GetPath(go),
                            field = it.propertyPath,
                            issue = "missing_reference"
                        });
                        break; // 每个对象只报第一个
                    }
                }
            }
            return result;
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

        private static string GetPath(GameObject go)
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
    }
}
