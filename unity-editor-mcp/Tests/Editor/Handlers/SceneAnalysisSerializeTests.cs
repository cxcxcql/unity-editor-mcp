using NUnit.Framework;
using UnityEngine;
using UnityEditorMCP.Handlers;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Tests
{
    /// <summary>
    /// Regression coverage for SceneAnalysisHandler.GetComponentValues serialization.
    /// Component values must never produce a Newtonsoft self-referencing loop — e.g. a
    /// UnityEngine.Object property (Component.transform) or a struct containing a Color
    /// (Color.linear returns a Color whose .linear returns a Color ...). Previously
    /// get_component_values crashed with "Self referencing loop detected for property 'linear'".
    /// </summary>
    [TestFixture]
    public class SceneAnalysisSerializeTests
    {
        [System.Serializable]
        public struct Swatch
        {
            public Color tint;
            public Vector3 dir;
        }

        private class McpSerializeProbe : MonoBehaviour
        {
            public Color Tint => new Color(0.1f, 0.2f, 0.3f, 0.4f);                 // -> flattened {r,g,b,a}
            public Swatch Block => new Swatch { tint = Color.red, dir = Vector3.up }; // unknown struct -> safe string
            public Transform Self => transform;                                      // UnityEngine.Object -> descriptor
        }

        private GameObject go;

        private static object GetValues()
        {
            return SceneAnalysisHandler.GetComponentValues(new JObject
            {
                ["gameObjectName"] = "McpSerializeProbe",
                ["componentType"] = "McpSerializeProbe"
            });
        }

        [SetUp]
        public void Setup()
        {
            go = new GameObject("McpSerializeProbe");
            go.AddComponent<McpSerializeProbe>();
        }

        [TearDown]
        public void TearDown()
        {
            if (go != null) Object.DestroyImmediate(go);
        }

        [Test]
        public void GetComponentValues_DoesNotReturnError()
        {
            var result = GetValues();
            Assert.IsNull(result.GetType().GetProperty("error")?.GetValue(result),
                "GetComponentValues should not error on Color/struct/Object properties");
        }

        [Test]
        public void GetComponentValues_ResultIsLoopFreeJson()
        {
            var result = GetValues();
            // Default settings use ReferenceLoopHandling.Error — the exact path that crashed
            // before the fix. It must now serialize without throwing.
            Assert.DoesNotThrow(() => JsonConvert.SerializeObject(result),
                "Serialized component values must not contain a self-referencing loop");
        }

        [Test]
        public void GetComponentValues_FlattensColorProperty()
        {
            var json = JObject.FromObject(GetValues());
            var tint = json["properties"]?["Tint"]?["value"];
            Assert.IsNotNull(tint, "Tint property should be present");
            Assert.AreEqual(0.2f, tint["g"].ToObject<float>(), 1e-4f, "Color should be flattened to r/g/b/a");
        }

        [Test]
        public void GetComponentValues_EmitsDescriptorForUnityObject()
        {
            var json = JObject.FromObject(GetValues());
            var self = json["properties"]?["Self"]?["value"];
            Assert.IsNotNull(self, "Self (Transform) property should be present");
            Assert.AreEqual("McpSerializeProbe", self["name"]?.ToObject<string>(),
                "UnityEngine.Object should serialize as a lightweight descriptor, not recurse");
        }
    }
}
