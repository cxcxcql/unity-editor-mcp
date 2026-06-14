using System.Reflection;
using NUnit.Framework;
using UnityEditorMCP.Handlers;
using UnityEngine;

namespace UnityEditorMCP.Tests
{
    [TestFixture]
    public class ConsoleHandlerTests
    {
        [Test]
        public void GetLogTypeFromMode_PrefersWarningWhenWarningAndScriptingBitsArePresent()
        {
            const int modeBitWarning = 1 << 2;
            const int modeBitScriptingException = 1 << 18;
            var method = typeof(ConsoleHandler).GetMethod(
                "GetLogTypeFromMode",
                BindingFlags.Static | BindingFlags.NonPublic
            );

            var result = (LogType)method.Invoke(null, new object[] { modeBitWarning | modeBitScriptingException });

            Assert.AreEqual(LogType.Warning, result);
        }
    }
}
