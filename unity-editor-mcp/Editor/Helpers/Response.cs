using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Helpers
{
    /// <summary>
    /// Helper class for creating standardized response messages
    /// </summary>
    public static class Response
    {
        /// <summary>两个场景检索指令的回包上限，单位为 UTF-8 字节，取 Node TCP 客户端支持的 1 MiB。</summary>
        private const int m_nSearchFrameLimitBytes = 1024 * 1024;

        /// <summary>读取场景检索的分页参数，偏移从零开始。</summary>
        /// <param name="pParameters">检索请求参数。</param>
        /// <returns>起始偏移和请求页大小。</returns>
        /// <exception cref="ArgumentException">偏移或页大小超出整数范围，或者字段类型不正确。</exception>
        internal static (int nOffset, int nLimit) ReadSearchPage(JObject pParameters)
        {
            int nOffset = 0;
            JToken pOffset = pParameters?["offset"];
            if (pOffset != null &&
                (pOffset.Type != JTokenType.Integer || !int.TryParse(pOffset.ToString(), out nOffset) || nOffset < 0))
            {
                throw new ArgumentException("offset must be an integer between 0 and 2147483647");
            }

            int nLimit = 100;
            JToken pLimit = pParameters?["limit"];
            if (pLimit != null &&
                (pLimit.Type != JTokenType.Integer || !int.TryParse(pLimit.ToString(), out nLimit) || nLimit < 1 || nLimit > 1000))
            {
                throw new ArgumentException("limit must be an integer between 1 and 1000");
            }

            return (nOffset, nLimit);
        }

        /// <summary>
        /// 按请求页大小和 TCP 帧预算填充搜索结果，并返回实际下一页偏移。
        /// </summary>
        /// <param name="szResponseId">TCP 回包中的请求 ID，用于计入实际 JSON 大小。</param>
        /// <param name="dicResult">不含结果列表和分页字段的全量统计。</param>
        /// <param name="szItemsKey">结果列表在回包中的字段名。</param>
        /// <param name="nTotalCount">查找命中的全量条数。</param>
        /// <param name="nOffset">本页起始偏移，从零开始。</param>
        /// <param name="nLimit">请求的单页条数上限。</param>
        /// <param name="pCreateItem">按有序索引生成一条完整的结果。</param>
        /// <param name="pCreateOversizedItem">单条完整结果超出帧预算时，按索引生成带身份的截断记录。</param>
        /// <returns>带分页信息的结果对象，或回包元数据超限错误。</returns>
        /// <remarks>时间与额外空间约为 O(n)，n 为本页尝试序列化的数据字节数。分页不序列化其余命中项。</remarks>
        internal static object CreateSearchPage(string szResponseId, Dictionary<string, object> dicResult, string szItemsKey,
            int nTotalCount, int nOffset, int nLimit, Func<int, object> pCreateItem, Func<int, object> pCreateOversizedItem)
        {
            // 计入真实响应信封及分页字段的最大长度。空数组的括号已包含在预算内。
            List<JRaw> listItems = new List<JRaw>();
            dicResult["offset"] = nOffset;
            dicResult["limit"] = nLimit;
            dicResult["returnedCount"] = nLimit;
            dicResult["hasMore"] = false;
            dicResult["nextOffset"] = int.MaxValue;
            dicResult[szItemsKey] = listItems;
            int nFrameBytes = Encoding.UTF8.GetByteCount(SuccessResult(szResponseId, dicResult));

            if (nFrameBytes > m_nSearchFrameLimitBytes)
            {
                return new { error = "Search response metadata exceeds the Unity TCP frame limit" };
            }

            for (int nIndex = nOffset; nIndex < nTotalCount && listItems.Count < nLimit; ++nIndex)
            {
                string szItem = JsonConvert.SerializeObject(pCreateItem(nIndex));
                int nItemBytes = Encoding.UTF8.GetByteCount(szItem);
                int nSeparatorBytes = listItems.Count > 0 ? 1 : 0;

                if (nItemBytes > m_nSearchFrameLimitBytes - nFrameBytes - nSeparatorBytes)
                {
                    if (listItems.Count > 0)
                    {
                        // 下一页从这一条继续，保留能单独装入一页的完整记录。
                        break;
                    }

                    szItem = JsonConvert.SerializeObject(pCreateOversizedItem(nIndex));
                    nItemBytes = Encoding.UTF8.GetByteCount(szItem);
                    if (nItemBytes > m_nSearchFrameLimitBytes - nFrameBytes)
                    {
                        return new { error = "Search result identifier exceeds the Unity TCP frame limit" };
                    }
                }

                // 复用已计量的 JSON，避免再次转义或改变实际条目字节数。
                listItems.Add(new JRaw(szItem));
                nFrameBytes += nSeparatorBytes + nItemBytes;
            }

            int nNextOffset = nOffset + listItems.Count;
            bool bHasMore = nNextOffset < nTotalCount;
            dicResult["returnedCount"] = listItems.Count;
            dicResult["hasMore"] = bHasMore;
            dicResult["nextOffset"] = bHasMore ? (int?)nNextOffset : null;
            return dicResult;
        }

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