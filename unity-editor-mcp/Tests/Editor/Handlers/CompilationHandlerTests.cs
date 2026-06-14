using NUnit.Framework;
using Newtonsoft.Json.Linq;
using System;
using System.Reflection;
using UnityEditorMCP.Handlers;

namespace UnityEditorMCP.Tests
{
    [TestFixture]
    public class CompilationHandlerTests
    {
        [Test]
        public void GetCompilationState_UnknownTimestamp_ReturnsNull()
        {
            typeof(CompilationHandler)
                .GetField("lastCompilationTime", BindingFlags.NonPublic | BindingFlags.Static)
                .SetValue(null, DateTime.MinValue);

            var result = JObject.FromObject(CompilationHandler.GetCompilationState(new JObject
            {
                ["includeMessages"] = false
            }));

            Assert.IsTrue(result["success"].Value<bool>());
            Assert.IsTrue(result.ContainsKey("lastCompilationTime"));
            Assert.AreEqual(JTokenType.Null, result["lastCompilationTime"].Type);
        }
    }
}
