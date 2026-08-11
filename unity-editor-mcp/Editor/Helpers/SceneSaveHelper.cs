using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEditor;
using UnityEditor.SceneManagement;

namespace UnityEditorMCP.Helpers
{
    /// <summary>
    /// Ares MCP: 场景/prefab 统一保存助手。
    ///
    /// 背景：modify_component / modify_gameobject / instantiate_prefab 等场景写操作
    /// 只调用 EditorUtility.SetDirty 标记内存脏，从不落盘。场景保持 dirty 时，
    /// 后续 open_prefab / load_scene / exit_prefab_mode 会触发 Unity 的未保存确认框，
    /// MCP 无头环境下没人点按钮，命令就卡住，直到用户手动 Ctrl+S 才继续。
    ///
    /// 修复：写操作完成后自动保存当前上下文（prefab stage → 保存 prefab 资产；
    /// 普通场景 → 保存活动场景），切换上下文前也先保存，避免脏状态阻塞后续命令。
    /// </summary>
    public static class SceneSaveHelper
    {
        /// <summary>
        /// 保存当前上下文中的脏内容：prefab stage 优先，否则保存活动场景。
        /// 播放模式下不保存。若场景从未保存过（无路径）则跳过。
        /// </summary>
        public static void SaveSceneIfDirty()
        {
            // 播放模式下不保存场景
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                return;

            // 1) 若处于 prefab stage 且 prefab 内容被修改，保存 prefab 资产
            var stage = UnityEditor.Experimental.SceneManagement.PrefabStageUtility.GetCurrentPrefabStage();
            if (stage != null && stage.scene.isDirty)
            {
                PrefabUtility.SaveAsPrefabAsset(stage.prefabContentsRoot, stage.assetPath);
            }

            // 2) 保存所有已落盘（有路径）且 dirty 的打开场景。
            //    逐个检查而非 SaveOpenScenes：避免把未保存过的新场景也拉进保存流程；
            //    也覆盖 prefab mode 中 modify_component 命中主场景实例、主场景变 dirty 的情况。
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (scene.IsValid() && scene.isDirty && !string.IsNullOrEmpty(scene.path))
                {
                    EditorSceneManager.SaveScene(scene);
                }
            }
        }
    }
}
