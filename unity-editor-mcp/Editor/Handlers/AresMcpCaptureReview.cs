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
    /// Ares MCP: Capture Review — 固定机位截图审查（不改变场景状态）。
    ///
    /// 对应报告工具 ares.scene.capture_review（只读/产物类）。
    /// 输入：scene_path（可选）、views（机位列表，默认四视图）、width/height
    /// 输出：截图清单 + Scene Hash
    ///
    /// 机位：player_spawn / top_orthographic / main_camera / scene_overview
    /// 截图保存到 Assets/Ares/MCP/Reports/（输出目录，不污染正式场景）
    /// </summary>
    public static class AresMcpCaptureReview
    {
        private static readonly string[] DEFAULT_VIEWS = { "main_camera", "top_orthographic", "scene_overview" };

        public static object Execute(JObject parameters)
        {
            string scenePath = parameters?["scene_path"]?.ToString();
            var views = parameters?["views"] as JArray;
            int width = parameters?["width"]?.ToObject<int>() ?? 1920;
            int height = parameters?["height"]?.ToObject<int>() ?? 1080;

            Scene scene = GetScene(scenePath);
            string sceneHash = GetSceneHash(scenePath ?? scene.path);

            var selectedViews = views != null && views.Any()
                ? views.Select(v => v.ToString()).ToList()
                : DEFAULT_VIEWS.ToList();

            // 输出目录
            string outputDir = "Assets/Ares/MCP/Reports";
            if (!AssetDatabase.IsValidFolder(outputDir))
            {
                string parent = Path.GetDirectoryName(outputDir).Replace('\\', '/');
                string leaf = Path.GetFileName(outputDir);
                if (!AssetDatabase.IsValidFolder(parent))
                {
                    string[] parts = parent.Split('/');
                    string cur = parts[0];
                    for (int i = 1; i < parts.Length; i++)
                    {
                        if (!AssetDatabase.IsValidFolder(cur + "/" + parts[i]))
                            AssetDatabase.CreateFolder(cur, parts[i]);
                        cur += "/" + parts[i];
                    }
                }
                if (!AssetDatabase.IsValidFolder(outputDir))
                    AssetDatabase.CreateFolder(parent, leaf);
            }

            var results = new List<object>();
            string timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");

            foreach (var view in selectedViews)
            {
                string fileName = $"review_{view}_{timestamp}.png";
                string assetPath = $"{outputDir}/{fileName}";
                string fullPath = Path.Combine(Application.dataPath, "..", assetPath);

                try
                {
                    bool ok = CaptureView(scene, view, fullPath, width, height);
                    AssetDatabase.Refresh();
                    results.Add(new
                    {
                        view,
                        captured = ok,
                        path = assetPath,
                        width,
                        height
                    });
                }
                catch (Exception ex)
                {
                    results.Add(new { view, captured = false, error = ex.Message });
                }
            }

            return new
            {
                capture_at = DateTime.UtcNow.ToString("o"),
                scene = scene.name,
                scene_path = scene.path,
                scene_hash = sceneHash,
                views = results,
                _note = "Screenshots saved under Assets/Ares/MCP/Reports/. Scene state unchanged."
            };
        }

        private static bool CaptureView(Scene scene, string view, string fullPath, int width, int height)
        {
            switch (view)
            {
                case "main_camera":
                {
                    var cam = FindMainCamera(scene);
                    if (cam == null) return false;
                    return RenderCamera(cam, fullPath, width, height);
                }
                case "top_orthographic":
                {
                    var cam = FindMainCamera(scene);
                    if (cam == null) return false;
                    // 临时正交俯视相机
                    var go = new GameObject("__AresReviewTopCam");
                    var topCam = go.AddComponent<Camera>();
                    topCam.orthographic = true;
                    topCam.orthographicSize = 20f;
                    topCam.transform.position = new Vector3(0, 50, 0);
                    topCam.transform.rotation = Quaternion.Euler(90, 0, 0);
                    topCam.clearFlags = CameraClearFlags.SolidColor;
                    topCam.backgroundColor = new Color(0.15f, 0.15f, 0.2f);
                    try
                    {
                        bool ok = RenderCamera(topCam, fullPath, width, height);
                        return ok;
                    }
                    finally
                    {
                        UnityEngine.Object.DestroyImmediate(go);
                    }
                }
                case "scene_overview":
                {
                    // 用 SceneView 截图（编辑器视角）
                    return CaptureSceneView(fullPath, width, height);
                }
                default:
                    return false;
            }
        }

        private static Camera FindMainCamera(Scene scene)
        {
            foreach (var root in scene.GetRootGameObjects())
            {
                var cam = root.GetComponentInChildren<Camera>(true);
                if (cam != null && cam.enabled) return cam;
            }
            return Camera.main;
        }

        private static bool RenderCamera(Camera cam, string fullPath, int width, int height)
        {
            // 保存原状态
            var origPos = cam.transform.position;
            var origRot = cam.transform.rotation;
            int origTarget = cam.targetTexture != null ? cam.targetTexture.GetInstanceID() : 0;

            try
            {
                var rt = new RenderTexture(width, height, 24);
                var prev = cam.targetTexture;
                cam.targetTexture = rt;
                cam.Render();
                cam.targetTexture = prev;

                RenderTexture.active = rt;
                var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                RenderTexture.active = null;
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);

                byte[] png = tex.EncodeToPNG();
                UnityEngine.Object.DestroyImmediate(tex);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                File.WriteAllBytes(fullPath, png);
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                cam.transform.position = origPos;
                cam.transform.rotation = origRot;
            }
        }

        private static bool CaptureSceneView(string fullPath, int width, int height)
        {
            var sceneView = SceneView.lastActiveSceneView;
            if (sceneView == null) return false;

            // SceneView 截图需要编辑器窗口渲染，这里用临时相机近似
            var go = new GameObject("__AresReviewOverviewCam");
            var cam = go.AddComponent<Camera>();
            cam.orthographic = true;
            cam.orthographicSize = 30f;
            var sceneBounds = GetSceneBounds();
            if (sceneBounds.size.sqrMagnitude > 0.01f)
            {
                cam.transform.position = sceneBounds.center + new Vector3(0, sceneBounds.size.magnitude, 0);
                cam.transform.rotation = Quaternion.Euler(90, 0, 0);
                cam.orthographicSize = Mathf.Max(sceneBounds.extents.x, sceneBounds.extents.z) + 5f;
            }
            else
            {
                cam.transform.position = new Vector3(0, 30, 0);
                cam.transform.rotation = Quaternion.Euler(90, 0, 0);
            }
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.1f, 0.1f, 0.15f);
            try
            {
                bool ok = RenderCamera(cam, fullPath, width, height);
                return ok;
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        private static Bounds GetSceneBounds()
        {
            var scene = SceneManager.GetActiveScene();
            var bounds = new Bounds(Vector3.zero, Vector3.zero);
            bool found = false;
            foreach (var root in scene.GetRootGameObjects())
            {
                foreach (var rend in root.GetComponentsInChildren<Renderer>(true))
                {
                    if (!found) { bounds = rend.bounds; found = true; }
                    else bounds.Encapsulate(rend.bounds);
                }
            }
            return bounds;
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
}
