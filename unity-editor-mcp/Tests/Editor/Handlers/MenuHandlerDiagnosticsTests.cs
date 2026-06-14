using NUnit.Framework;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditorMCP.Handlers;

namespace UnityEditorMCP.Tests
{
    [TestFixture]
    public class MenuHandlerDiagnosticsTests
    {
        [Test]
        public void ExecuteMenuItem_InvalidPath_IncludesDiagnostics()
        {
            var result = JObject.FromObject(MenuHandler.ExecuteMenuItem(new JObject
            {
                ["menuPath"] = "InvalidPath"
            }));

            Assert.IsFalse(result["success"].Value<bool>());
            Assert.AreEqual("not_found", result["validationStatus"].Value<string>());
            Assert.AreEqual("INVALID_MENU_PATH_FORMAT", result["reasonCode"].Value<string>());
            Assert.IsNotNull(result["editorState"]);
        }

        [Test]
        public void ExecuteMenuItem_BlacklistedKnownPath_IncludesEditorStateDiagnostics()
        {
            var result = JObject.FromObject(MenuHandler.ExecuteMenuItem(new JObject
            {
                ["menuPath"] = "File/Quit",
                ["safetyCheck"] = true
            }));

            Assert.IsFalse(result["success"].Value<bool>());
            Assert.IsFalse(result["executed"].Value<bool>());
            Assert.IsTrue(result["menuExists"].Value<bool>());
            Assert.AreEqual("not_executed", result["validationStatus"].Value<string>());
            Assert.AreEqual("BLACKLISTED", result["reasonCode"].Value<string>());
            Assert.IsNotNull(result["editorState"]);
        }

        [Test]
        public void ExecuteMenuItem_PlayAlias_ReturnsRecommendedToolWithoutExecutingMenuPath()
        {
            var result = JObject.FromObject(MenuHandler.ExecuteMenuItem(new JObject
            {
                ["menuPath"] = "Edit/Play",
                ["safetyCheck"] = true
            }));

            Assert.IsTrue(result["success"].Value<bool>());
            Assert.IsFalse(result["executed"].Value<bool>());
            Assert.IsTrue(result["menuExists"].Value<bool>());
            Assert.AreEqual("not_executed", result["validationStatus"].Value<string>());
            Assert.AreEqual("USE_RECOMMENDED_TOOL", result["reasonCode"].Value<string>());
            Assert.IsTrue(new[] { "play_game", "stop_game" }.Contains(result["recommendedTool"].Value<string>()));
            Assert.IsNotNull(result["editorState"]);
        }
    }
}
