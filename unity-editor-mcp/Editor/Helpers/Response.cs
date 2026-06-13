using Newtonsoft.Json;
using System.Collections.Generic;

namespace UnityEditorMCP.Helpers
{
    /// <summary>
    /// Helper class for creating standardized response messages
    /// </summary>
    public static class Response
    {
        /// <summary>
        /// Creates a success response with optional data
        /// </summary>
        /// <param name="data">Optional data to include in the response</param>
        /// <returns>JSON string of the response</returns>
        public static string Success(object data = null)
        {
            var response = new Dictionary<string, object>
            {
                ["status"] = "success"
            };
            
            if (data != null)
            {
                response["data"] = data;
            }
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates a success response with command ID and data
        /// </summary>
        /// <param name="id">Command ID</param>
        /// <param name="data">Data to include in the response (pass null for none)</param>
        /// <returns>JSON string of the response</returns>
        /// <remarks>
        /// <paramref name="data"/> has no default value on purpose: a single-argument
        /// call such as Success(null) or Success("text") must bind to Success(object),
        /// not silently select this id overload.
        /// </remarks>
        public static string Success(string id, object data)
        {
            var response = new Dictionary<string, object>
            {
                ["id"] = id,
                ["success"] = true
            };
            
            if (data != null)
            {
                response["data"] = data;
            }
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates an error response with message and optional error code
        /// </summary>
        /// <param name="message">Error message</param>
        /// <param name="code">Optional error code</param>
        /// <param name="details">Optional additional error details</param>
        /// <returns>JSON string of the response</returns>
        public static string Error(string message, string code = null, object details = null)
        {
            var response = new Dictionary<string, object>
            {
                ["status"] = "error",
                ["error"] = message
            };
            
            if (!string.IsNullOrEmpty(code))
            {
                response["code"] = code;
            }
            
            if (details != null)
            {
                response["details"] = details;
            }
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates an error response with command ID
        /// </summary>
        /// <param name="id">Command ID</param>
        /// <param name="message">Error message</param>
        /// <param name="code">Error code (pass null for none)</param>
        /// <param name="details">Additional error details (pass null for none)</param>
        /// <returns>JSON string of the response</returns>
        /// <remarks>
        /// <paramref name="code"/> and <paramref name="details"/> have no default values
        /// on purpose: a two-argument call such as Error("msg", "CODE") must bind to the
        /// no-id Error(string, string, object) overload instead of being ambiguous with this one.
        /// </remarks>
        public static string Error(string id, string message, string code, object details)
        {
            var response = new Dictionary<string, object>
            {
                ["id"] = id,
                ["success"] = false,
                ["error"] = message
            };
            
            if (!string.IsNullOrEmpty(code))
            {
                response["code"] = code;
            }
            
            if (details != null)
            {
                response["details"] = details;
            }
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates a response for the ping command
        /// </summary>
        /// <returns>JSON string of the pong response</returns>
        public static string Pong()
        {
            return Success(new { message = "pong", timestamp = System.DateTime.UtcNow.ToString("o") });
        }
        
        // ===== New Format Methods (Phase 1.1) =====
        
        /// <summary>
        /// Creates a standardized success response (new format)
        /// </summary>
        /// <param name="result">The result data</param>
        /// <returns>JSON string of the response</returns>
        public static string SuccessResult(object result)
        {
            var response = new Dictionary<string, object>
            {
                ["status"] = "success",
                ["result"] = result
            };
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates a standardized success response with command ID (new format)
        /// </summary>
        /// <param name="id">Command ID</param>
        /// <param name="result">The result data</param>
        /// <returns>JSON string of the response</returns>
        public static string SuccessResult(string id, object result)
        {
            var response = new Dictionary<string, object>
            {
                ["id"] = id,
                ["status"] = "success",
                ["result"] = result
            };
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates a standardized error response (new format)
        /// </summary>
        /// <param name="errorMessage">Error message</param>
        /// <param name="code">Error code</param>
        /// <param name="details">Optional error details</param>
        /// <returns>JSON string of the response</returns>
        public static string ErrorResult(string errorMessage, string code = "UNKNOWN_ERROR", object details = null)
        {
            var response = new Dictionary<string, object>
            {
                ["status"] = "error",
                ["error"] = errorMessage,
                ["code"] = code
            };
            
            if (details != null)
            {
                response["details"] = details;
            }
            
            return JsonConvert.SerializeObject(response);
        }
        
        /// <summary>
        /// Creates a standardized error response with command ID (new format)
        /// </summary>
        /// <param name="id">Command ID</param>
        /// <param name="errorMessage">Error message</param>
        /// <param name="code">Error code (pass null for none)</param>
        /// <param name="details">Additional error details (pass null for none)</param>
        /// <returns>JSON string of the response</returns>
        /// <remarks>
        /// <paramref name="code"/> and <paramref name="details"/> have no default values
        /// on purpose: a two-argument call such as ErrorResult("msg", "CODE") must bind to the
        /// no-id ErrorResult(string, string, object) overload instead of being ambiguous with this one.
        /// </remarks>
        public static string ErrorResult(string id, string errorMessage, string code, object details)
        {
            var response = new Dictionary<string, object>
            {
                ["id"] = id,
                ["status"] = "error",
                ["error"] = errorMessage,
                ["code"] = code
            };
            
            if (details != null)
            {
                response["details"] = details;
            }
            
            return JsonConvert.SerializeObject(response);
        }
    }
}