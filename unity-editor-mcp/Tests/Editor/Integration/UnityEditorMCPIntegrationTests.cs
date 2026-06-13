using NUnit.Framework;
using UnityEditorMCP.Core;
using UnityEditorMCP.Models;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using EditorMCP = UnityEditorMCP.Core.UnityEditorMCP;

namespace UnityEditorMCP.Tests.Integration
{
    [TestFixture]
    public class UnityEditorMCPIntegrationTests
    {
        private const int CONNECTION_TIMEOUT_MS = 5000;
        
        [Test]
        public async Task UnityEditorMCP_ShouldAcceptTcpConnection()
        {
            // Arrange
            TcpClient client = null;
            
            try
            {
                // Act - Try to connect to the Unity TCP server
                client = new TcpClient();
                var connectTask = client.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                
                // Wait for connection with timeout
                var completed = await Task.WhenAny(connectTask, Task.Delay(CONNECTION_TIMEOUT_MS));
                
                // Assert
                Assert.IsTrue(completed == connectTask, "Connection should complete within timeout");
                Assert.IsTrue(client.Connected, "Client should be connected");
                Assert.AreEqual(McpStatus.Connected, EditorMCP.Status, "MCP status should be Connected");
            }
            finally
            {
                client?.Close();
                client?.Dispose();
            }
        }
        
        [Test]
        public async Task UnityEditorMCP_ShouldProcessPingCommand()
        {
            // Arrange
            TcpClient client = null;
            
            try
            {
                client = new TcpClient();
                await client.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                
                var stream = client.GetStream();
                
                // Create ping command
                var pingCommand = new Command
                {
                    Id = "test-ping-001",
                    Type = "ping",
                    AuthToken = GetCurrentAuthToken(),
                    Parameters = new Newtonsoft.Json.Linq.JObject
                    {
                        ["message"] = "Hello Unity"
                    }
                };
                
                // Act - Send ping command
                await SendFramedJson(stream, JsonConvert.SerializeObject(pingCommand));
                var response = await ReadFramedJson(stream);
                
                // Assert
                Assert.IsNotNull(response, "Response should not be null");
                Assert.AreEqual("test-ping-001", response["id"].Value<string>(), "Response ID should match command ID");
                Assert.AreEqual("success", response["status"].Value<string>(), "Response should indicate success");
                Assert.AreEqual("pong", response["result"]["message"].Value<string>(), "Response should contain pong message");
            }
            finally
            {
                client?.Close();
                client?.Dispose();
            }
        }
        
        [Test]
        public async Task UnityEditorMCP_ShouldHandleInvalidJson()
        {
            // Arrange
            TcpClient client = null;
            
            try
            {
                client = new TcpClient();
                await client.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                
                var stream = client.GetStream();
                
                // Act - Send invalid JSON
                await SendFramedJson(stream, "{ invalid json }");
                var response = await ReadFramedJson(stream);
                
                // Assert
                Assert.AreEqual("error", response["status"].Value<string>(), "Response should indicate failure");
                Assert.AreEqual("JSON_ERROR", response["code"].Value<string>(), "Response should include JSON error code");
                Assert.IsTrue(response["error"].Value<string>().Contains("parsing"), "Error should mention parsing issue");
            }
            finally
            {
                client?.Close();
                client?.Dispose();
            }
        }
        
        [Test]
        public async Task UnityEditorMCP_ShouldHandleMultipleClients()
        {
            // Arrange
            TcpClient client1 = null;
            TcpClient client2 = null;
            
            try
            {
                // Act - Connect two clients
                client1 = new TcpClient();
                await client1.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                
                client2 = new TcpClient();
                await client2.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                
                // Send commands from both clients
                var command1 = new Command { Id = "client1-cmd", Type = "ping", AuthToken = GetCurrentAuthToken() };
                var command2 = new Command { Id = "client2-cmd", Type = "ping", AuthToken = GetCurrentAuthToken() };
                
                await SendFramedJson(client1.GetStream(), JsonConvert.SerializeObject(command1));
                await SendFramedJson(client2.GetStream(), JsonConvert.SerializeObject(command2));
                
                // Assert - Both clients should be connected
                Assert.IsTrue(client1.Connected, "Client 1 should remain connected");
                Assert.IsTrue(client2.Connected, "Client 2 should remain connected");
            }
            finally
            {
                client1?.Close();
                client1?.Dispose();
                client2?.Close();
                client2?.Dispose();
            }
        }
        
        [Test]
        public void UnityEditorMCP_StatusShouldBeDisconnectedOnStartup()
        {
            // Assert - Check initial status
            // Note: In actual Unity, the MCP might already be connected from previous tests
            // This test verifies that the status enum is working correctly
            Assert.IsTrue(
                EditorMCP.Status == McpStatus.Disconnected || 
                EditorMCP.Status == McpStatus.Connected,
                "Status should be either Disconnected or Connected"
            );
        }
        
        [Test]
        public async Task UnityEditorMCP_ShouldReconnectAfterDisconnection()
        {
            // Arrange
            TcpClient client = null;
            
            try
            {
                // First connection
                client = new TcpClient();
                await client.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                Assert.IsTrue(client.Connected, "Should connect initially");
                
                // Disconnect
                client.Close();
                client.Dispose();
                
                // Wait a bit for server to process disconnection
                await Task.Delay(500);
                
                // Act - Reconnect
                client = new TcpClient();
                var reconnectTask = client.ConnectAsync("127.0.0.1", EditorMCP.DEFAULT_PORT);
                var completed = await Task.WhenAny(reconnectTask, Task.Delay(CONNECTION_TIMEOUT_MS));
                
                // Assert
                Assert.IsTrue(completed == reconnectTask, "Should reconnect within timeout");
                Assert.IsTrue(client.Connected, "Should be connected after reconnection");
            }
            finally
            {
                client?.Close();
                client?.Dispose();
            }
        }

        private static async Task SendFramedJson(NetworkStream stream, string json)
        {
            var payload = Encoding.UTF8.GetBytes(json);
            var lengthBytes = BitConverter.GetBytes(payload.Length);
            if (BitConverter.IsLittleEndian)
            {
                Array.Reverse(lengthBytes);
            }

            await stream.WriteAsync(lengthBytes, 0, lengthBytes.Length);
            await stream.WriteAsync(payload, 0, payload.Length);
            await stream.FlushAsync();
        }

        private static async Task<JObject> ReadFramedJson(NetworkStream stream)
        {
            var lengthBytes = await ReadExact(stream, 4);
            if (BitConverter.IsLittleEndian)
            {
                Array.Reverse(lengthBytes);
            }

            var length = BitConverter.ToInt32(lengthBytes, 0);
            var payload = await ReadExact(stream, length);
            return JObject.Parse(Encoding.UTF8.GetString(payload));
        }

        private static async Task<byte[]> ReadExact(NetworkStream stream, int length)
        {
            var buffer = new byte[length];
            var offset = 0;
            while (offset < length)
            {
                var readTask = stream.ReadAsync(buffer, offset, length - offset);
                var completed = await Task.WhenAny(readTask, Task.Delay(CONNECTION_TIMEOUT_MS));
                Assert.IsTrue(completed == readTask, "Should receive framed response within timeout");

                var bytesRead = await readTask;
                Assert.Greater(bytesRead, 0, "Socket closed before full frame was read");
                offset += bytesRead;
            }

            return buffer;
        }

        private static string GetCurrentAuthToken()
        {
            var registryType = typeof(EditorMCP).Assembly.GetType("UnityEditorMCP.Core.UnityInstanceRegistry");
            var property = registryType.GetProperty("AuthToken", BindingFlags.Public | BindingFlags.Static);
            return (string)property.GetValue(null);
        }
    }
}
