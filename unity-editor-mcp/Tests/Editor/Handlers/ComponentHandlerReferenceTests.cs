using System.IO;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Events;
using UnityEditor;
using UnityEditorMCP.Handlers;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Tests
{
    /// <summary>
    /// Covers the object-reference and UnityEvent support added to ComponentHandler:
    /// ConvertValue/ResolveObjectReference (assets, scene objects, instance IDs, coercion)
    /// and SetUnityEvent persistent-listener wiring via modify_component.
    /// </summary>
    [TestFixture]
    public class ComponentHandlerReferenceTests
    {
        // A non-UI component with a serialized object reference + a UnityEvent, so the tests
        // don't need the UnityEngine.UI assembly referenced.
        private class McpRefTestComponent : MonoBehaviour
        {
            [SerializeField] private Transform refTarget;
            public Transform RefTarget => refTarget;
            public UnityEvent onPoke;
        }

        private GameObject root;
        private GameObject target;
        private GameObject holder;
        private const string SpriteFolder = "Assets/MCPRefTests";
        private string spritePath;

        [SetUp]
        public void Setup()
        {
            root = new GameObject("MCPRefTestRoot");
            target = new GameObject("RefTarget");
            target.transform.SetParent(root.transform);
            holder = new GameObject("RefHolder");
            holder.transform.SetParent(root.transform);
            holder.AddComponent<McpRefTestComponent>();

            if (!AssetDatabase.IsValidFolder(SpriteFolder))
                AssetDatabase.CreateFolder("Assets", "MCPRefTests");
            spritePath = SpriteFolder + "/ref_sprite.png";
            var tex = new Texture2D(4, 4);
            File.WriteAllBytes(spritePath, tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
            AssetDatabase.ImportAsset(spritePath, ImportAssetOptions.ForceSynchronousImport);
            var importer = (TextureImporter)AssetImporter.GetAtPath(spritePath);
            importer.textureType = TextureImporterType.Sprite;
            importer.SaveAndReimport();
        }

        [TearDown]
        public void TearDown()
        {
            if (root != null) Object.DestroyImmediate(root);
            if (AssetDatabase.IsValidFolder(SpriteFolder)) AssetDatabase.DeleteAsset(SpriteFolder);
        }

        [Test]
        public void ResolveObjectReference_AssetPath_LoadsSprite()
        {
            var resolved = ComponentHandler.ResolveObjectReference(JToken.FromObject(spritePath), typeof(Sprite));
            Assert.IsInstanceOf<Sprite>(resolved, "Asset path should resolve to the imported Sprite");
        }

        [Test]
        public void ResolveObjectReference_ScenePath_ReturnsGameObject()
        {
            var resolved = ComponentHandler.ResolveObjectReference(JToken.FromObject("/MCPRefTestRoot/RefTarget"), typeof(GameObject));
            Assert.AreSame(target, resolved);
        }

        [Test]
        public void ResolveObjectReference_ScenePath_CoercesToComponent()
        {
            var resolved = ComponentHandler.ResolveObjectReference(JToken.FromObject("/MCPRefTestRoot/RefTarget"), typeof(Transform));
            Assert.AreSame(target.transform, resolved);
        }

        [Test]
        public void ResolveObjectReference_InstanceId_ReturnsObject()
        {
            var resolved = ComponentHandler.ResolveObjectReference(JToken.FromObject(target.GetInstanceID()), typeof(GameObject));
            Assert.AreSame(target, resolved);
        }

        [Test]
        public void ResolveObjectReference_Null_ReturnsNull()
        {
            Assert.IsNull(ComponentHandler.ResolveObjectReference(JValue.CreateNull(), typeof(GameObject)));
        }

        [Test]
        public void ModifyComponent_SetsSerializedObjectReference()
        {
            var result = ComponentHandler.ModifyComponent(new JObject
            {
                ["gameObjectPath"] = "/MCPRefTestRoot/RefHolder",
                ["componentType"] = "McpRefTestComponent",
                ["properties"] = new JObject { ["refTarget"] = "/MCPRefTestRoot/RefTarget" }
            });

            Assert.IsNull(result.GetType().GetProperty("error")?.GetValue(result));
            Assert.AreSame(target.transform, holder.GetComponent<McpRefTestComponent>().RefTarget);
        }

        [Test]
        public void ModifyComponent_WiresUnityEventPersistentCall()
        {
            ComponentHandler.ModifyComponent(new JObject
            {
                ["gameObjectPath"] = "/MCPRefTestRoot/RefHolder",
                ["componentType"] = "McpRefTestComponent",
                ["properties"] = new JObject
                {
                    ["onPoke"] = new JObject
                    {
                        ["persistentCalls"] = new JArray
                        {
                            new JObject
                            {
                                ["target"] = "/MCPRefTestRoot/RefTarget",
                                ["method"] = "SetActive",
                                ["argument"] = false
                            }
                        }
                    }
                }
            });

            var evt = holder.GetComponent<McpRefTestComponent>().onPoke;
            Assert.AreEqual(1, evt.GetPersistentEventCount());
            Assert.AreSame(target, evt.GetPersistentTarget(0));
            Assert.AreEqual("SetActive", evt.GetPersistentMethodName(0));
        }
    }
}
