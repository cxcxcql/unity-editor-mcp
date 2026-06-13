using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditorMCP.Core;
using UnityEditorMCP.Helpers;
using UnityEditorMCP.Models;

namespace UnityEditorMCP.Tests.Integration
{
    [TestFixture]
    public class UnityEditorMCPDispatchTests
    {
        [Test]
        public void Authorization_ShouldAcceptCurrentInstanceToken()
        {
            var command = new Command
            {
                Id = "auth-ok",
                Type = "ping",
                AuthToken = GetCurrentAuthToken(),
                Parameters = new JObject()
            };

            Assert.IsTrue(IsAuthorized(command));
        }

        [Test]
        public void Authorization_ShouldRejectMissingOrWrongToken()
        {
            Assert.IsFalse(IsAuthorized(new Command { Id = "missing", Type = "ping" }));
            Assert.IsFalse(IsAuthorized(new Command
            {
                Id = "wrong",
                Type = "ping",
                AuthToken = "wrong-token"
            }));
        }

        [Test]
        public void DispatcherRegistry_ShouldInvokeRegisteredCommandHandler()
        {
            var command = new Command
            {
                Id = "dispatch-ping",
                Type = "ping",
                AuthToken = GetCurrentAuthToken(),
                Parameters = new JObject
                {
                    ["message"] = "hello"
                }
            };

            var dispatched = TryExecuteRegisteredCommand(command, out object result);
            var json = JObject.FromObject(result);

            Assert.IsTrue(dispatched);
            Assert.AreEqual("pong", json["message"].Value<string>());
            Assert.AreEqual("hello", json["echo"].Value<string>());
        }

        [Test]
        public void DispatcherRegistry_ShouldRejectUnknownCommand()
        {
            var command = new Command
            {
                Id = "unknown",
                Type = "not_a_command",
                AuthToken = GetCurrentAuthToken()
            };

            Assert.IsFalse(TryExecuteRegisteredCommand(command, out object result));
            Assert.IsNull(result);

            var response = JObject.Parse(Response.ErrorResult(
                command.Id,
                "Unknown command type: not_a_command",
                "UNKNOWN_COMMAND",
                new { commandType = command.Type }
            ));
            Assert.AreEqual("UNKNOWN_COMMAND", response["code"].Value<string>());
        }

        private static bool IsAuthorized(Command command)
        {
            var method = typeof(UnityEditorMCP.Core.UnityEditorMCP).GetMethod(
                "IsAuthorized",
                BindingFlags.NonPublic | BindingFlags.Static
            );
            return (bool)method.Invoke(null, new object[] { command });
        }

        private static bool TryExecuteRegisteredCommand(Command command, out object result)
        {
            var method = typeof(UnityEditorMCP.Core.UnityEditorMCP).GetMethod(
                "TryExecuteRegisteredCommand",
                BindingFlags.NonPublic | BindingFlags.Static
            );
            var args = new object[] { command, null };
            var dispatched = (bool)method.Invoke(null, args);
            result = args[1];
            return dispatched;
        }

        private static string GetCurrentAuthToken()
        {
            var registryType = typeof(UnityEditorMCP.Core.UnityEditorMCP).Assembly.GetType(
                "UnityEditorMCP.Core.UnityInstanceRegistry"
            );
            var property = registryType.GetProperty(
                "AuthToken",
                BindingFlags.Public | BindingFlags.Static
            );
            return (string)property.GetValue(null);
        }
    }
}
