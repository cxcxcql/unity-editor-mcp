using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Models
{
    /// <summary>
    /// Represents a command received from the MCP server
    /// </summary>
    [Serializable]
    public class Command
    {
        /// <summary>
        /// Unique identifier for the command
        /// </summary>
        [JsonProperty("id")]
        public string Id { get; set; }
        
        /// <summary>
        /// The type of command to execute
        /// </summary>
        [JsonProperty("type")]
        public string Type { get; set; }
        
        /// <summary>
        /// Parameters for the command as a JSON object
        /// </summary>
        [JsonProperty("params")]
        public JObject Parameters { get; set; }

        /// <summary>
        /// Per-editor-instance token used to authenticate local bridge commands.
        /// </summary>
        [JsonProperty("authToken")]
        public string AuthToken { get; set; }
        
        /// <summary>
        /// 请求开始执行的最迟时间，单位为 Unix 毫秒。旧客户端可省略。
        /// </summary>
        [JsonProperty("deadlineUnixMs")]
        public long? DeadlineUnixMs { get; set; }

        /// <summary>
        /// Timestamp when the command was received
        /// </summary>
        [JsonIgnore]
        public DateTime ReceivedAt { get; set; } = DateTime.Now;
        
        public override string ToString()
        {
            return $"Command[{Id}]: {Type}";
        }
    }
}
