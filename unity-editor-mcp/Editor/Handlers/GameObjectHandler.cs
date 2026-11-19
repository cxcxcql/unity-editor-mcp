using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using Newtonsoft.Json.Linq;
using UnityEditorMCP.Helpers;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Handles GameObject-related operations
    /// </summary>
    public static class GameObjectHandler
    {
        /// <summary>
        /// Creates a new GameObject based on parameters
        /// </summary>
        public static object CreateGameObject(JObject parameters)
        {
            try
            {
                // Parse parameters
                string name = parameters["name"]?.ToString() ?? "GameObject";
                string primitiveType = parameters["primitiveType"]?.ToString();
                
                // Parse transform
                var position = ParseVector3(parameters["position"]) ?? Vector3.zero;
                var rotation = ParseVector3(parameters["rotation"]) ?? Vector3.zero;
                var scale = ParseVector3(parameters["scale"]) ?? Vector3.one;
                
                // Parse parent
                string parentPath = parameters["parentPath"]?.ToString();
                GameObject parent = null;
                if (!string.IsNullOrEmpty(parentPath))
                {
                    parent = GameObject.Find(parentPath);
                    if (parent == null)
                    {
                        return new { error = $"Parent GameObject not found: {parentPath}" };
                    }
                }
                
                // Create GameObject
                GameObject newObject;
                if (!string.IsNullOrEmpty(primitiveType))
                {
                    newObject = CreatePrimitive(primitiveType);
                    if (newObject == null)
                    {
                        return new { error = $"Unknown primitive type: {primitiveType}" };
                    }
                }
                else
                {
                    newObject = new GameObject();
                }
                
                // Set properties
                newObject.name = name;
                newObject.transform.position = position;
                newObject.transform.rotation = Quaternion.Euler(rotation);
                newObject.transform.localScale = scale;
                
                // Set parent
                if (parent != null)
                {
                    newObject.transform.SetParent(parent.transform, true);
                }
                
                // Set tag
                string tag = parameters["tag"]?.ToString();
                if (!string.IsNullOrEmpty(tag))
                {
                    try
                    {
                        newObject.tag = tag;
                    }
                    catch (Exception)
                    {
                        Debug.LogWarning($"Invalid tag: {tag}");
                    }
                }
                
                // Set layer
                int? layer = parameters["layer"]?.ToObject<int>();
                if (layer.HasValue && layer.Value >= 0 && layer.Value < 32)
                {
                    newObject.layer = layer.Value;
                }
                
                // Register undo
                Undo.RegisterCreatedObjectUndo(newObject, $"Create {name}");
                
                // Select the new object
                Selection.activeGameObject = newObject;
                
                // Return info about created object
                return new
                {
                    id = newObject.GetInstanceID(),
                    name = newObject.name,
                    path = GetGameObjectPath(newObject),
                    position = new { x = position.x, y = position.y, z = position.z },
                    rotation = new { x = rotation.x, y = rotation.y, z = rotation.z },
                    scale = new { x = scale.x, y = scale.y, z = scale.z },
                    tag = newObject.tag,
                    layer = newObject.layer,
                    isActive = newObject.activeSelf
                };
            }
            catch (Exception ex)
            {
                return new { error = $"Failed to create GameObject: {ex.Message}" };
            }
        }
        
        /// <summary>
        /// Creates a primitive GameObject
        /// </summary>
        private static GameObject CreatePrimitive(string type)
        {
            switch (type.ToLower())
            {
                case "cube":
                    return GameObject.CreatePrimitive(PrimitiveType.Cube);
                case "sphere":
                    return GameObject.CreatePrimitive(PrimitiveType.Sphere);
                case "cylinder":
                    return GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                case "capsule":
                    return GameObject.CreatePrimitive(PrimitiveType.Capsule);
                case "plane":
                    return GameObject.CreatePrimitive(PrimitiveType.Plane);
                case "quad":
                    return GameObject.CreatePrimitive(PrimitiveType.Quad);
                default:
                    return null;
            }
        }
        
        /// <summary>
        /// Parses a Vector3 from JToken
        /// </summary>
        private static Vector3? ParseVector3(JToken token)
        {
            if (token == null) return null;
            
            try
            {
                if (token is JObject obj)
                {
                    float x = obj["x"]?.ToObject<float>() ?? 0;
                    float y = obj["y"]?.ToObject<float>() ?? 0;
                    float z = obj["z"]?.ToObject<float>() ?? 0;
                    return new Vector3(x, y, z);
                }
            }
            catch
            {
                // Invalid format
            }
            
            return null;
        }
        
        /// <summary>
        /// Gets the full hierarchy path of a GameObject
        /// </summary>
        public static string GetGameObjectPath(GameObject obj)
        {
            if (obj == null) return "";
            
            string path = obj.name;
            Transform parent = obj.transform.parent;
            
            while (parent != null)
            {
                path = parent.name + "/" + path;
                parent = parent.parent;
            }
            
            return "/" + path;
        }
        
        /// <summary>
        /// Modifies an existing GameObject
        /// </summary>
        public static object ModifyGameObject(JObject parameters)
        {
            try
            {
                string path = parameters["path"]?.ToString();
                if (string.IsNullOrEmpty(path))
                {
                    return new { error = "GameObject path is required" };
                }
                
                // Find the GameObject
                GameObject obj = GameObject.Find(path);
                if (obj == null)
                {
                    return new { error = $"GameObject not found: {path}" };
                }
                
                // Store original values for undo
                var originalName = obj.name;
                var originalPosition = obj.transform.position;
                var originalRotation = obj.transform.rotation;
                var originalScale = obj.transform.localScale;
                var originalActive = obj.activeSelf;
                
                // Apply modifications
                bool modified = false;
                
                // Name
                string newName = parameters["name"]?.ToString();
                if (!string.IsNullOrEmpty(newName) && newName != obj.name)
                {
                    obj.name = newName;
                    modified = true;
                }
                
                // Transform
                var position = ParseVector3(parameters["position"]);
                if (position.HasValue)
                {
                    obj.transform.position = position.Value;
                    modified = true;
                }
                
                var rotation = ParseVector3(parameters["rotation"]);
                if (rotation.HasValue)
                {
                    obj.transform.rotation = Quaternion.Euler(rotation.Value);
                    modified = true;
                }
                
                var scale = ParseVector3(parameters["scale"]);
                if (scale.HasValue)
                {
                    obj.transform.localScale = scale.Value;
                    modified = true;
                }
                
                // Active state
                bool? active = parameters["active"]?.ToObject<bool>();
                if (active.HasValue && active.Value != obj.activeSelf)
                {
                    obj.SetActive(active.Value);
                    modified = true;
                }
                
                // Tag
                string tag = parameters["tag"]?.ToString();
                if (!string.IsNullOrEmpty(tag) && tag != obj.tag)
                {
                    try
                    {
                        obj.tag = tag;
                        modified = true;
                    }
                    catch (Exception)
                    {
                        Debug.LogWarning($"Invalid tag: {tag}");
                    }
                }
                
                // Layer
                int? layer = parameters["layer"]?.ToObject<int>();
                if (layer.HasValue && layer.Value >= 0 && layer.Value < 32 && layer.Value != obj.layer)
                {
                    obj.layer = layer.Value;
                    modified = true;
                }
                
                // Parent
                string parentPath = parameters["parentPath"]?.ToString();
                if (parameters.ContainsKey("parentPath")) // Allow null to unparent
                {
                    GameObject newParent = null;
                    if (!string.IsNullOrEmpty(parentPath))
                    {
                        newParent = GameObject.Find(parentPath);
                        if (newParent == null)
                        {
                            return new { error = $"Parent GameObject not found: {parentPath}" };
                        }
                    }
                    
                    if (obj.transform.parent != (newParent ? newParent.transform : null))
                    {
                        obj.transform.SetParent(newParent ? newParent.transform : null, true);
                        modified = true;
                    }
                }
                
                if (modified)
                {
                    // Register undo
                    Undo.RecordObject(obj, "Modify GameObject");
                    Undo.RecordObject(obj.transform, "Modify GameObject Transform");
                    
                    // Mark as dirty for saving
                    EditorUtility.SetDirty(obj);
                }
                
                // Return updated info
                return new
                {
                    id = obj.GetInstanceID(),
                    name = obj.name,
                    path = GetGameObjectPath(obj),
                    position = new { x = obj.transform.position.x, y = obj.transform.position.y, z = obj.transform.position.z },
                    rotation = new { x = obj.transform.rotation.eulerAngles.x, y = obj.transform.rotation.eulerAngles.y, z = obj.transform.rotation.eulerAngles.z },
                    scale = new { x = obj.transform.localScale.x, y = obj.transform.localScale.y, z = obj.transform.localScale.z },
                    tag = obj.tag,
                    layer = obj.layer,
                    isActive = obj.activeSelf,
                    modified = modified
                };
            }
            catch (Exception ex)
            {
                return new { error = $"Failed to modify GameObject: {ex.Message}" };
            }
        }
        
        /// <summary>
        /// 按名称、标签和层筛选已加载的场景对象。
        /// </summary>
        /// <param name="parameters">名称、标签、层、美术树开关及分页参数。</param>
        /// <param name="szResponseId">TCP 回包中的请求 ID。</param>
        /// <returns>所有匹配对象的数量及本页详情，或检索错误。</returns>
        /// <remarks>
        /// 遍历为 O(n)，n 为实际访问的节点数。剪枝模式按实例 ID 排序命中项，额外排序开销约为 O(m log m)，m 为命中数。
        /// 仅本页生成路径和 Transform 详情并序列化。
        /// </remarks>
        public static object FindGameObjects(JObject parameters, string szResponseId = null)
        {
            try
            {
                string szName = parameters["name"]?.ToString();
                string szTag = parameters["tag"]?.ToString();
                int? nLayer = parameters["layer"]?.ToObject<int>();
                bool bExactMatch = parameters["exactMatch"]?.ToObject<bool>() ?? true;
                bool bSkipArtNodes = parameters["skipArtNodes"]?.ToObject<bool>() ?? true;
                (int nOffset, int nLimit) = Response.ReadSearchPage(parameters);

                IEnumerable<GameObject> pCandidates;
                if (bSkipArtNodes)
                {
                    pCandidates = EnumeratePrunedSceneObjects(bIncludeInactive: true, bActiveSceneOnly: false);
                }
                else
                {
                    pCandidates = GameObject.FindObjectsOfType<GameObject>(true);
                }

                List<GameObject> listResults = new List<GameObject>();
                foreach (GameObject pGameObject in pCandidates)
                {
                    bool bMatches = true;
                    if (!string.IsNullOrEmpty(szName))
                    {
                        if (bExactMatch)
                        {
                            bMatches &= pGameObject.name == szName;
                        }
                        else
                        {
                            bMatches &= pGameObject.name.IndexOf(szName, StringComparison.OrdinalIgnoreCase) >= 0;
                        }
                    }

                    if (!string.IsNullOrEmpty(szTag))
                    {
                        bMatches &= pGameObject.CompareTag(szTag);
                    }

                    if (nLayer.HasValue)
                    {
                        bMatches &= pGameObject.layer == nLayer.Value;
                    }

                    if (bMatches)
                    {
                        listResults.Add(pGameObject);
                    }
                }

                // 旧查询按实例 ID 返回，剪枝模式只需恢复命中项的相同顺序。
                if (bSkipArtNodes)
                {
                    listResults.Sort((pLeft, pRight) => pLeft.GetInstanceID().CompareTo(pRight.GetInstanceID()));
                }

                Dictionary<string, object> dicResult = new Dictionary<string, object> { ["count"] = listResults.Count };
                return Response.CreateSearchPage(szResponseId, dicResult, "objects", listResults.Count, nOffset, nLimit,
                    nIndex => DescribeFoundGameObject(listResults[nIndex]),
                    nIndex => new
                    {
                        id = listResults[nIndex].GetInstanceID(),
                        index = nIndex,
                        truncated = true,
                        reason = "RESULT_ITEM_TOO_LARGE"
                    });
            }
            catch (Exception pException)
            {
                return new { error = $"Failed to find GameObjects: {pException.Message}" };
            }
        }

        /// <summary>生成对象查找单条命中的路径和 Transform 详情。</summary>
        /// <param name="pGameObject">命中的场景对象。</param>
        /// <returns>可序列化的对象详情。</returns>
        /// <remarks>会沿父节点向上构建场景路径，主要开销取决于层级深度及路径长度。</remarks>
        private static object DescribeFoundGameObject(GameObject pGameObject)
        {
            Transform pTransform = pGameObject.transform;
            Vector3 pPosition = pTransform.position;
            Vector3 pRotation = pTransform.rotation.eulerAngles;
            Vector3 pScale = pTransform.localScale;

            return new
            {
                id = pGameObject.GetInstanceID(),
                name = pGameObject.name,
                path = GetGameObjectPath(pGameObject),
                tag = pGameObject.tag,
                layer = pGameObject.layer,
                isActive = pGameObject.activeSelf,
                transform = new
                {
                    position = new { x = pPosition.x, y = pPosition.y, z = pPosition.z },
                    rotation = new { x = pRotation.x, y = pRotation.y, z = pRotation.z },
                    scale = new { x = pScale.x, y = pScale.y, z = pScale.z }
                }
            };
        }

        /// <summary>
        /// 从场景顶层逐棵遍历，跳过名称精确为 root 的节点及其后代。
        /// </summary>
        /// <param name="bIncludeInactive">是否检索非激活对象。</param>
        /// <param name="bActiveSceneOnly">是否沿用组件查找包含非激活对象时的活动场景范围及隐藏标记规则。</param>
        /// <returns>可以进入名称或组件匹配的场景对象。</returns>
        /// <remarks>
        /// 时间复杂度约为 O(n)，n 为实际访问的节点数。临时列表和栈保存场景顶层对象及待处理的子节点。
        /// </remarks>
        internal static IEnumerable<GameObject> EnumeratePrunedSceneObjects(bool bIncludeInactive, bool bActiveSceneOnly)
        {
            IEnumerable<Scene> pScenes;
            if (bActiveSceneOnly)
            {
                pScenes = new[] { SceneManager.GetActiveScene() };
            }
            else
            {
                pScenes = GetMainStageSearchScenes();
            }

            List<GameObject> listRoots = new List<GameObject>();
            Stack<Transform> pPending = new Stack<Transform>();

            foreach (Scene pScene in pScenes)
            {
                if (!pScene.IsValid() || !pScene.isLoaded)
                {
                    continue;
                }

                pScene.GetRootGameObjects(listRoots);
                foreach (GameObject pRoot in listRoots)
                {
                    pPending.Push(pRoot.transform);
                    while (pPending.Count > 0)
                    {
                        Transform pTransform = pPending.Pop();
                        GameObject pGameObject = pTransform.gameObject;
                        if (pGameObject.name == "root" || (!bIncludeInactive && !pGameObject.activeInHierarchy))
                        {
                            continue;
                        }

                        // 保存标记仅决定本节点是否返回，子节点仍按各自的标记判断。
                        if (bActiveSceneOnly || (pGameObject.hideFlags & HideFlags.DontSave) == 0)
                        {
                            yield return pGameObject;
                        }

                        for (int nIndex = pTransform.childCount - 1; nIndex >= 0; --nIndex)
                        {
                            pPending.Push(pTransform.GetChild(nIndex));
                        }
                    }
                }
            }
        }

        /// <summary>
        /// 收集主舞台的场景以及播放期间的常驻场景。
        /// </summary>
        /// <returns>供顶层节点检索的场景列表。</returns>
        /// <remarks>时间复杂度为 O(n)，n 为已打开的场景数，层级窗口查询只访问折叠后的场景标题。</remarks>
        private static List<Scene> GetMainStageSearchScenes()
        {
            int nSceneCount = SceneManager.sceneCount;
            List<Scene> listScenes = new List<Scene>(nSceneCount + 1);
            for (int nIndex = 0; nIndex < nSceneCount; ++nIndex)
            {
                Scene pScene = SceneManager.GetSceneAt(nIndex);
                if (pScene.IsValid() && !EditorSceneManager.IsPreviewScene(pScene))
                {
                    listScenes.Add(pScene);
                }
            }

            if (Application.isPlaying)
            {
                // Unity 2020.3 在层级窗口中单独展示常驻场景。保持所有标题折叠即可取得场景，无须创建临时对象。
                HierarchyProperty pHierarchy = new HierarchyProperty(HierarchyType.GameObjects, forceImport: false)
                {
                    showSceneHeaders = true
                };
                int[] arrExpanded = Array.Empty<int>();
                while (pHierarchy.Next(arrExpanded))
                {
                    if (!pHierarchy.isSceneHeader)
                    {
                        continue;
                    }

                    Scene pScene = pHierarchy.GetScene();
                    if (pScene.IsValid() && pScene.name == "DontDestroyOnLoad" && !listScenes.Contains(pScene))
                    {
                        listScenes.Add(pScene);
                        break;
                    }
                }
            }

            return listScenes;
        }

        /// <summary>
        /// Deletes GameObject(s)
        /// </summary>
        public static object DeleteGameObject(JObject parameters)
        {
            try
            {
                string path = parameters["path"]?.ToString();
                string[] paths = parameters["paths"]?.ToObject<string[]>();
                bool includeChildren = parameters["includeChildren"]?.ToObject<bool>() ?? true;
                
                // Validate input
                if (string.IsNullOrEmpty(path) && (paths == null || paths.Length == 0))
                {
                    return new { error = "Either 'path' or 'paths' parameter is required" };
                }
                
                // Collect all paths
                List<string> allPaths = new List<string>();
                if (!string.IsNullOrEmpty(path))
                {
                    allPaths.Add(path);
                }
                if (paths != null)
                {
                    allPaths.AddRange(paths);
                }
                
                // Find and delete GameObjects
                List<string> deleted = new List<string>();
                List<string> notFound = new List<string>();
                
                foreach (string objPath in allPaths)
                {
                    GameObject obj = GameObject.Find(objPath);
                    if (obj != null)
                    {
                        deleted.Add(objPath);
                        Undo.DestroyObjectImmediate(obj);
                    }
                    else
                    {
                        notFound.Add(objPath);
                    }
                }
                
                return new
                {
                    deletedCount = deleted.Count,
                    deleted = deleted,
                    notFound = notFound,
                    notFoundCount = notFound.Count
                };
            }
            catch (Exception ex)
            {
                return new { error = $"Failed to delete GameObject: {ex.Message}" };
            }
        }
        
        /// <summary>
        /// Gets the scene hierarchy
        /// </summary>
        public static object GetHierarchy(JObject parameters)
        {
            try
            {
                bool includeInactive = parameters["includeInactive"]?.ToObject<bool>() ?? true;
                int maxDepth = parameters["maxDepth"]?.ToObject<int>() ?? -1;
                bool includeComponents = parameters["includeComponents"]?.ToObject<bool>() ?? false;
                // 默认过滤美术节点（名字为 root 的节点及其子树），避免场景层级过于庞大
                bool skipArtNodes = parameters["skipArtNodes"]?.ToObject<bool>() ?? true;

                // Get root GameObjects
                GameObject[] rootObjects = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();

                // Build hierarchy
                List<object> hierarchy = new List<object>();
                foreach (var root in rootObjects)
                {
                    if (!includeInactive && !root.activeInHierarchy)
                        continue;

                    var node = BuildHierarchyNode(root, 0, maxDepth, includeInactive, includeComponents, skipArtNodes);
                    if (node != null)
                        hierarchy.Add(node);
                }
                
                return new
                {
                    sceneName = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                    objectCount = hierarchy.Count,
                    hierarchy = hierarchy
                };
            }
            catch (Exception ex)
            {
                return new { error = $"Failed to get hierarchy: {ex.Message}" };
            }
        }
        
        /// <summary>
        /// Builds a hierarchy node for a GameObject
        /// </summary>
        private static object BuildHierarchyNode(GameObject obj, int currentDepth, int maxDepth, bool includeInactive, bool includeComponents, bool skipArtNodes)
        {
            // 过滤美术节点：名字为 root 的节点其下全是美术子节点，对整个解决方案作用不大
            if (skipArtNodes && obj.name == "root")
                return null;

            var node = new Dictionary<string, object>
            {
                ["name"] = obj.name,
                ["path"] = GetGameObjectPath(obj),
                ["isActive"] = obj.activeSelf,
                ["tag"] = obj.tag,
                ["layer"] = obj.layer,
                ["transform"] = new
                {
                    position = new { x = obj.transform.position.x, y = obj.transform.position.y, z = obj.transform.position.z },
                    rotation = new { x = obj.transform.rotation.eulerAngles.x, y = obj.transform.rotation.eulerAngles.y, z = obj.transform.rotation.eulerAngles.z },
                    scale = new { x = obj.transform.localScale.x, y = obj.transform.localScale.y, z = obj.transform.localScale.z }
                }
            };

            // Add components if requested
            if (includeComponents)
            {
                var components = obj.GetComponents<Component>();
                var componentList = new List<string>();
                foreach (var comp in components)
                {
                    if (comp != null)
                    {
                        componentList.Add(comp.GetType().Name);
                    }
                }
                node["components"] = componentList;
            }

            // Add children if within depth limit
            if (maxDepth < 0 || currentDepth < maxDepth)
            {
                List<object> children = new List<object>();
                foreach (Transform child in obj.transform)
                {
                    if (!includeInactive && !child.gameObject.activeInHierarchy)
                        continue;

                    var childNode = BuildHierarchyNode(child.gameObject, currentDepth + 1, maxDepth, includeInactive, includeComponents, skipArtNodes);
                    if (childNode != null)
                        children.Add(childNode);
                }

                if (children.Count > 0)
                {
                    node["children"] = children;
                }
            }

            return node;
        }
    }
}