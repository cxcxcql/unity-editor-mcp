using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.Compilation;

namespace UnityEditorMCP.Core
{
    #region 编辑器活动

    /// <summary>
    /// 将编辑器活动保存到独立快照，并在内存中提供给 TCP 后台线程。
    /// </summary>
    public static class UnityEditorActivity
    {
        /// <summary>活动快照的心跳间隔，单位为秒。</summary>
        private const double HeartbeatSeconds = 5.0;

        /// <summary>已知忙碌期间建议客户端重新查询的间隔，单位为毫秒。</summary>
        internal const int RetryAfterMs = 5000;

        /// <summary>按进入顺序保留当前项目构建来源。</summary>
        private static readonly LinkedList<string> m_listBuildSources = new LinkedList<string>();

        /// <summary>当前活动的不可变副本，供 TCP 后台线程读取。</summary>
        private static volatile ActivityState m_pCurrent =
            new ActivityState("unresponsive", "unity.editorUpdate", DateTime.UtcNow);

        /// <summary>是否已订阅编译事件。</summary>
        private static bool m_bInitialized;

        /// <summary>是否已收到编译开始事件且还未结束。</summary>
        private static bool m_bCompiling;

        /// <summary>是否已进入标准 Player Build。</summary>
        private static bool m_bPlayerBuild;

        /// <summary>是否已开始域重载。</summary>
        private static bool m_bReloading;

        /// <summary>监听器启动后是否已推进编辑器更新。</summary>
        private static bool m_bReady;

        /// <summary>当前域绑定的 TCP 端口，首次绑定前为空。</summary>
        private static int? m_nPort;

        /// <summary>上次尝试写快照的编辑器启动后秒数，首次写入前为负无穷。</summary>
        private static double m_dwLastWriteTime = double.NegativeInfinity;

        /// <summary>
        /// 在编辑器主线程上开始跟踪一项项目构建。
        /// </summary>
        /// <param name="szSource">构建来源，例如 project.assetBundle 或 project.hotUpdate。</param>
        /// <returns>由调用方在构建完成时于编辑器主线程释放的作用域。</returns>
        /// <exception cref="ArgumentException">构建来源为空。</exception>
        /// <remarks>时间复杂度：O(1)，活动变化时同步更新一次快照。</remarks>
        public static IDisposable BeginBuild(string szSource)
        {
            if (string.IsNullOrWhiteSpace(szSource))
            {
                throw new ArgumentException("构建来源不能为空。", nameof(szSource));
            }

            Initialize();
            LinkedListNode<string> pSource = m_listBuildSources.AddLast(szSource);
            Publish();
            return new BuildActivity(pSource);
        }

        /// <summary>
        /// 在编辑器初始化时订阅编译事件。
        /// </summary>
        internal static void Initialize()
        {
            if (m_bInitialized)
            {
                return;
            }

            m_bInitialized = true;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
        }

        /// <summary>
        /// 移除编译事件订阅。
        /// </summary>
        internal static void Destroy()
        {
            if (!m_bInitialized)
            {
                return;
            }

            CompilationPipeline.compilationStarted -= OnCompilationStarted;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
            m_bInitialized = false;
        }

        /// <summary>
        /// 记录监听端口，等待编辑器推进一次更新后发布就绪。
        /// </summary>
        /// <param name="nPort">实际绑定的 TCP 端口。</param>
        internal static void ListenerStarted(int nPort)
        {
            m_nPort = nPort;
            m_bReady = false;
            m_dwLastWriteTime = double.NegativeInfinity;
        }

        /// <summary>
        /// 监听器关停后撤销就绪状态。
        /// </summary>
        internal static void ListenerStopped()
        {
            m_bReady = false;
            Publish();
        }

        /// <summary>
        /// 确认编辑器可继续处理命令，维护构建状态和心跳。
        /// </summary>
        /// <param name="bListening">监听器是否已完成启动。</param>
        /// <remarks>时间复杂度：O(1)，状态变化或心跳到期时同步更新一次快照。</remarks>
        internal static void OnEditorUpdate(bool bListening)
        {
            m_bReady = bListening;
            m_bPlayerBuild = BuildPipeline.isBuildingPlayer;
            Publish();
        }

        /// <summary>
        /// 在域重载关闭 TCP 监听器前保存重载状态。
        /// </summary>
        internal static void BeforeAssemblyReload()
        {
            m_bReloading = true;
            Publish();
        }

        /// <summary>
        /// 在标准 Player Build 前记录活动，结束、失败或取消后由编辑器更新清理。
        /// </summary>
        internal static void BeginPlayerBuild()
        {
            m_bPlayerBuild = true;
            Publish();
        }

        /// <summary>
        /// 读取明确的忙碌状态和对应说明，可在 TCP 后台线程调用。
        /// </summary>
        /// <param name="szState">当前活动状态。</param>
        /// <param name="szMessage">返回给客户端的忙碌说明。</param>
        /// <returns>存在明确的阻塞活动时返回 true。</returns>
        internal static bool TryGetBusy(out string szState, out string szMessage)
        {
            szState = m_pCurrent.State;
            switch (szState)
            {
                case "compiling":
                    szMessage = "Unity 正在编译脚本，本次操作未执行。请稍后查询状态。";
                    break;
                case "building":
                    szMessage = "Unity 正在构建，本次操作未执行。请稍后查询状态。";
                    break;
                case "reloading":
                    szMessage = "Unity 正在重载脚本域，本次操作未执行。请稍后查询状态。";
                    break;
                default:
                    szMessage = null;
                    break;
            }

            return szMessage != null;
        }

        /// <summary>
        /// 在编译开始时立即发布编译状态。
        /// </summary>
        /// <param name="pContext">Unity 编译上下文。</param>
        private static void OnCompilationStarted(object pContext)
        {
            m_bCompiling = true;
            Publish();
        }

        /// <summary>
        /// 标记编译结束，等待编辑器更新或域重载确认下一阶段。
        /// </summary>
        /// <param name="pContext">Unity 编译上下文。</param>
        private static void OnCompilationFinished(object pContext)
        {
            m_bCompiling = false;
        }

        /// <summary>
        /// 计算当前活动，按变化或心跳周期发布完整快照。
        /// </summary>
        /// <remarks>时间复杂度：O(1)，发布时同步替换单个文件。</remarks>
        private static void Publish()
        {
            string szState;
            string szSource;
            if (m_bReloading)
            {
                szState = "reloading";
                szSource = "unity.domainReload";
            }
            else if (m_listBuildSources.Last != null)
            {
                szState = "building";
                szSource = m_listBuildSources.Last.Value;
            }
            else if (m_bPlayerBuild)
            {
                szState = "building";
                szSource = "unity.playerBuild";
            }
            else if (m_bCompiling || EditorApplication.isCompiling)
            {
                szState = "compiling";
                szSource = "unity.compilation";
            }
            else
            {
                szState = m_bReady ? "ready" : "unresponsive";
                szSource = "unity.editorUpdate";
            }

            double dwNow = EditorApplication.timeSinceStartup;
            bool bChanged = m_pCurrent.State != szState || m_pCurrent.Source != szSource;
            if (bChanged)
            {
                m_pCurrent = new ActivityState(szState, szSource, DateTime.UtcNow);
            }

            if (bChanged || dwNow - m_dwLastWriteTime >= HeartbeatSeconds)
            {
                // 更新不可变内存状态后，独立进程通过完整文件接收同一状态。
                m_dwLastWriteTime = dwNow;
                UnityInstanceRegistry.WriteActivity(m_nPort, m_pCurrent.State, m_pCurrent.Source, m_pCurrent.StartedAt);
            }
        }

        /// <summary>
        /// 保存后台线程可一次读取的活动。
        /// </summary>
        private sealed class ActivityState
        {
            /// <summary>当前活动阶段。</summary>
            public string State { get; }

            /// <summary>当前活动来源。</summary>
            public string Source { get; }

            /// <summary>进入当前活动的 UTC 时间。</summary>
            public DateTime StartedAt { get; }

            /// <summary>
            /// 保存一次活动变更。
            /// </summary>
            /// <param name="szState">活动阶段。</param>
            /// <param name="szSource">活动来源。</param>
            /// <param name="pStartedAt">进入活动的 UTC 时间。</param>
            public ActivityState(string szState, string szSource, DateTime pStartedAt)
            {
                State = szState;
                Source = szSource;
                StartedAt = pStartedAt;
            }
        }

        /// <summary>
        /// 保留调用方的项目构建活动直至构建完成。
        /// </summary>
        private sealed class BuildActivity : IDisposable
        {
            /// <summary>当前构建在活动列表中的节点，释放后为空。</summary>
            private LinkedListNode<string> m_pSource;

            /// <summary>
            /// 关联当前构建的活动节点。
            /// </summary>
            /// <param name="pSource">当前构建的活动节点。</param>
            public BuildActivity(LinkedListNode<string> pSource)
            {
                m_pSource = pSource;
            }

            /// <summary>
            /// 结束本项构建，恢复其他构建活动或等待编辑器更新确认空闲。
            /// </summary>
            /// <remarks>时间复杂度：O(1)，活动变化时同步更新快照。</remarks>
            public void Dispose()
            {
                if (m_pSource == null)
                {
                    return;
                }

                m_listBuildSources.Remove(m_pSource);
                m_pSource = null;
                if (m_listBuildSources.Count > 0)
                {
                    Publish();
                }
            }
        }
    }

    #endregion

    #region Player Build 回调

    /// <summary>
    /// 在 Unity Player Build 的最早构建回调阶段登记活动。
    /// </summary>
    internal sealed class UnityEditorMcpPlayerBuild : IPreprocessBuildWithReport
    {
        /// <summary>最小的回调顺序编号。</summary>
        public int callbackOrder => int.MinValue;

        /// <summary>
        /// 在 Unity 开始构建 Player 时登记活动。
        /// </summary>
        /// <param name="pReport">Unity 提供的构建报告。</param>
        public void OnPreprocessBuild(BuildReport pReport)
        {
            UnityEditorActivity.BeginPlayerBuild();
        }
    }

    #endregion
}
