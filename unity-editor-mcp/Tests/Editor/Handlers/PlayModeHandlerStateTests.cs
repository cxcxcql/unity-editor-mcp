using NUnit.Framework;
using Newtonsoft.Json.Linq;
using UnityEditorMCP.Handlers;

namespace UnityEditorMCP.Tests
{
    [TestFixture]
    public class PlayModeHandlerStateTests
    {
        [Test]
        public void GetEditorState_IncludesPlayerLoopHealthFields()
        {
            var result = PlayModeHandler.HandleCommand("get_editor_state", new JObject());
            var json = JObject.FromObject(result);
            var state = json["state"] as JObject;

            Assert.IsNotNull(state);
            Assert.IsTrue(state.ContainsKey("frameCount"));
            Assert.IsTrue(state.ContainsKey("time"));
            Assert.IsTrue(state.ContainsKey("realtimeSinceStartup"));
            Assert.IsTrue(state.ContainsKey("timeScale"));
            Assert.IsTrue(state.ContainsKey("isPlayerLoopAdvancing"));
        }
    }
}
