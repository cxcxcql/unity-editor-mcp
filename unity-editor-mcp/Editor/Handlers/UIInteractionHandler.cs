using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using UnityEditor;
using Newtonsoft.Json.Linq;

namespace UnityEditorMCP.Handlers
{
    /// <summary>
    /// Handles UI interaction operations
    /// </summary>
    public static class UIInteractionHandler
    {
        /// <summary>
        /// Finds UI elements based on various filters
        /// </summary>
        public static object FindUIElements(JObject parameters)
        {
            try
            {
                // Parse parameters
                string elementType = parameters["elementType"]?.ToString();
                string tagFilter = parameters["tagFilter"]?.ToString();
                string namePattern = parameters["namePattern"]?.ToString();
                bool includeInactive = parameters["includeInactive"]?.ToObject<bool>() ?? false;
                string canvasFilter = parameters["canvasFilter"]?.ToString();

                // Find all canvases in the scene
                Canvas[] allCanvases = includeInactive 
                    ? Resources.FindObjectsOfTypeAll<Canvas>() 
                    : UnityEngine.Object.FindObjectsOfType<Canvas>();

                List<object> elements = new List<object>();

                // Search through each canvas
                foreach (var canvas in allCanvases)
                {
                    // Skip if canvas filter doesn't match
                    if (!string.IsNullOrEmpty(canvasFilter) && canvas.name != canvasFilter)
                        continue;

                    // Get all UI components in the canvas
                    var allComponents = includeInactive
                        ? canvas.GetComponentsInChildren<Component>(true)
                        : canvas.GetComponentsInChildren<Component>(false);

                    foreach (var component in allComponents)
                    {
                        // Skip if not a UI component
                        if (!IsUIComponent(component))
                            continue;

                        // Apply filters
                        if (!PassesFilters(component, elementType, tagFilter, namePattern))
                            continue;

                        // Get interactable status
                        bool isInteractable = GetInteractableStatus(component);

                        // Create element info
                        var elementInfo = new
                        {
                            path = GetGameObjectPath(component.gameObject),
                            elementType = component.GetType().Name,
                            name = component.gameObject.name,
                            isActive = component.gameObject.activeInHierarchy,
                            isInteractable = isInteractable,
                            tag = component.gameObject.tag,
                            canvasPath = GetGameObjectPath(canvas.gameObject)
                        };

                        elements.Add(elementInfo);
                    }
                }

                return new
                {
                    elements = elements,
                    count = elements.Count
                };
            }
            catch (Exception e)
            {
                Debug.LogError($"[UIInteractionHandler] Error in FindUIElements: {e.Message}");
                return new { error = $"Failed to find UI elements: {e.Message}" };
            }
        }

        /// <summary>
        /// Clicks on a UI element
        /// </summary>
        public static object ClickUIElement(JObject parameters)
        {
            try
            {
                string elementPath = parameters["elementPath"]?.ToString();
                string clickType = parameters["clickType"]?.ToString() ?? "left";
                float holdDuration = parameters["holdDuration"]?.ToObject<float>() ?? 0f;
                
                if (string.IsNullOrEmpty(elementPath))
                {
                    return new { error = "elementPath is required" };
                }

                // Find the GameObject
                GameObject targetObject = GameObject.Find(elementPath);
                if (targetObject == null)
                {
                    return new { error = $"UI element not found at path: {elementPath}" };
                }

                // Check if it's a UI element
                var uiComponent = targetObject.GetComponent<Graphic>();
                if (uiComponent == null)
                {
                    return new { error = $"GameObject at {elementPath} is not a UI element" };
                }

                // Check if interactable
                var selectable = targetObject.GetComponent<Selectable>();
                if (selectable != null && !selectable.interactable)
                {
                    return new { error = $"UI element at {elementPath} is not interactable" };
                }

                // Simulate click based on component type
                bool success = SimulateClick(targetObject, clickType, holdDuration);

                if (!success)
                {
                    return new { error = "Failed to simulate click on UI element" };
                }

                return new
                {
                    success = true,
                    elementPath = elementPath,
                    clickType = clickType,
                    message = $"Successfully clicked {targetObject.name}"
                };
            }
            catch (Exception e)
            {
                Debug.LogError($"[UIInteractionHandler] Error in ClickUIElement: {e.Message}");
                return new { error = $"Failed to click UI element: {e.Message}" };
            }
        }

        /// <summary>
        /// Gets the state of a UI element
        /// </summary>
        public static object GetUIElementState(JObject parameters)
        {
            try
            {
                string elementPath = parameters["elementPath"]?.ToString();
                bool includeChildren = parameters["includeChildren"]?.ToObject<bool>() ?? false;
                bool includeInteractableInfo = parameters["includeInteractableInfo"]?.ToObject<bool>() ?? true;

                if (string.IsNullOrEmpty(elementPath))
                {
                    return new { error = "elementPath is required" };
                }

                GameObject targetObject = GameObject.Find(elementPath);
                if (targetObject == null)
                {
                    return new { error = $"UI element not found at path: {elementPath}" };
                }

                var state = GetElementState(targetObject, includeChildren, includeInteractableInfo);
                return state;
            }
            catch (Exception e)
            {
                Debug.LogError($"[UIInteractionHandler] Error in GetUIElementState: {e.Message}");
                return new { error = $"Failed to get UI element state: {e.Message}" };
            }
        }

        /// <summary>
        /// Sets the value of a UI element
        /// </summary>
        public static object SetUIElementValue(JObject parameters)
        {
            try
            {
                string elementPath = parameters["elementPath"]?.ToString();
                var value = parameters["value"];
                bool triggerEvents = parameters["triggerEvents"]?.ToObject<bool>() ?? true;

                if (string.IsNullOrEmpty(elementPath))
                {
                    return new { error = "elementPath is required" };
                }

                if (value == null)
                {
                    return new { error = "value is required" };
                }

                GameObject targetObject = GameObject.Find(elementPath);
                if (targetObject == null)
                {
                    return new { error = $"UI element not found at path: {elementPath}" };
                }

                bool success = SetElementValue(targetObject, value, triggerEvents);
                if (!success)
                {
                    return new { error = "Failed to set UI element value - unsupported element type" };
                }

                return new
                {
                    success = true,
                    elementPath = elementPath,
                    newValue = value.ToString(),
                    message = $"Successfully set value for {targetObject.name}"
                };
            }
            catch (Exception e)
            {
                Debug.LogError($"[UIInteractionHandler] Error in SetUIElementValue: {e.Message}");
                return new { error = $"Failed to set UI element value: {e.Message}" };
            }
        }

        /// <summary>
        /// Simulates a complex UI input sequence
        /// </summary>
        public static object SimulateUIInput(JObject parameters)
        {
            try
            {
                var inputSequence = parameters["inputSequence"]?.ToObject<JArray>();
                float waitBetween = parameters["waitBetween"]?.ToObject<float>() ?? 100f;
                bool validateState = parameters["validateState"]?.ToObject<bool>() ?? true;

                if (inputSequence == null || inputSequence.Count == 0)
                {
                    return new { error = "inputSequence is required and must not be empty" };
                }

                List<object> results = new List<object>();
                
                foreach (JObject action in inputSequence)
                {
                    string actionType = action["type"]?.ToString();
                    var actionParams = action["params"] as JObject;

                    if (string.IsNullOrEmpty(actionType) || actionParams == null)
                    {
                        results.Add(new { error = "Invalid action format" });
                        continue;
                    }

                    // Execute action based on type
                    object result = null;
                    switch (actionType.ToLower())
                    {
                        case "click":
                            result = ClickUIElement(actionParams);
                            break;
                        case "setvalue":
                            result = SetUIElementValue(actionParams);
                            break;
                        default:
                            result = new { error = $"Unknown action type: {actionType}" };
                            break;
                    }

                    results.Add(result);

                    // Wait between actions if needed
                    if (waitBetween > 0 && inputSequence.IndexOf(action) < inputSequence.Count - 1)
                    {
                        // Note: In real implementation, this would need to be async
                        // For now, we're just recording the wait time
                        results.Add(new { wait = waitBetween });
                    }
                }

                return new
                {
                    success = true,
                    results = results,
                    totalActions = inputSequence.Count
                };
            }
            catch (Exception e)
            {
                Debug.LogError($"[UIInteractionHandler] Error in SimulateUIInput: {e.Message}");
                return new { error = $"Failed to simulate UI input: {e.Message}" };
            }
        }

        #region Helper Methods

        private static bool IsUIComponent(Component component)
        {
            // Check if component is a UI component
            return component is Graphic || 
                   component is Selectable || 
                   component is LayoutGroup ||
                   component is ContentSizeFitter ||
                   component is AspectRatioFitter ||
                   component is CanvasScaler ||
                   component is GraphicRaycaster;
        }

        private static bool PassesFilters(Component component, string elementType, string tagFilter, string namePattern)
        {
            // Check element type filter
            if (!string.IsNullOrEmpty(elementType))
            {
                string componentType = component.GetType().Name;
                if (!componentType.Equals(elementType, StringComparison.OrdinalIgnoreCase))
                    return false;
            }

            // Check tag filter
            if (!string.IsNullOrEmpty(tagFilter))
            {
                if (component.gameObject.tag != tagFilter)
                    return false;
            }

            // Check name pattern
            if (!string.IsNullOrEmpty(namePattern))
            {
                try
                {
                    Regex regex = new Regex(namePattern);
                    if (!regex.IsMatch(component.gameObject.name))
                        return false;
                }
                catch
                {
                    // If regex is invalid, do simple contains check
                    if (!component.gameObject.name.Contains(namePattern))
                        return false;
                }
            }

            return true;
        }

        private static bool GetInteractableStatus(Component component)
        {
            var selectable = component as Selectable;
            if (selectable != null)
                return selectable.interactable;

            var button = component as Button;
            if (button != null)
                return button.interactable;

            var toggle = component as Toggle;
            if (toggle != null)
                return toggle.interactable;

            var inputField = component as InputField;
            if (inputField != null)
                return inputField.interactable;

            var slider = component as Slider;
            if (slider != null)
                return slider.interactable;

            var dropdown = component as Dropdown;
            if (dropdown != null)
                return dropdown.interactable;

            // For non-selectable UI elements, consider them interactable if active
            return component.gameObject.activeInHierarchy;
        }

        private static string GetGameObjectPath(GameObject obj)
        {
            string path = "/" + obj.name;
            Transform parent = obj.transform.parent;
            
            while (parent != null)
            {
                path = "/" + parent.name + path;
                parent = parent.parent;
            }
            
            return path;
        }

        private static bool SimulateClick(GameObject target, string clickType, float holdDuration)
        {
            // Drive a REAL EventSystem pointer event (enter -> down -> up -> click) so every
            // handler runs exactly as for a user tap: IPointerClickHandler, EventTrigger, the
            // Selectable/Button state machine and EventSystem selection. A bare
            // button.onClick.Invoke() skips all of that and silently does nothing for UIs whose
            // logic isn't wired directly to Button.onClick.
            var eventSystem = EventSystem.current;
            var pointerData = new PointerEventData(eventSystem)
            {
                button = ParsePointerButton(clickType)
            };

            // Pointer position from the element's RectTransform, used as the pointer position so
            // handlers that read it behave correctly. We dispatch to the element directly (below),
            // so this does not need to drive a raycast.
            var rect = target.GetComponent<RectTransform>();
            if (rect != null)
            {
                var corners = new Vector3[4];
                rect.GetWorldCorners(corners);
                Vector3 worldCenter = (corners[0] + corners[2]) * 0.5f;
                pointerData.position = RectTransformUtility.WorldToScreenPoint(GetEventCamera(target), worldCenter);
            }
            else
            {
                pointerData.position = new Vector2(Screen.width * 0.5f, Screen.height * 0.5f);
            }
            pointerData.pressPosition = pointerData.position;

            // Dispatch the full pointer sequence DIRECTLY to the requested element (bubbling to its
            // nearest handler) so we click exactly what the caller named — not whatever a raycast
            // lands on (an overlay/occluder, or a mis-projected point on a non-overlay canvas).
            ExecuteEvents.Execute(target, pointerData, ExecuteEvents.pointerEnterHandler);
            var pressHandler = ExecuteEvents.ExecuteHierarchy(target, pointerData, ExecuteEvents.pointerDownHandler);
            var clickHandler = ExecuteEvents.GetEventHandler<IPointerClickHandler>(target);
            pointerData.pointerPress = pressHandler ?? clickHandler;
            pointerData.rawPointerPress = target;
            if (eventSystem != null)
            {
                var selectHandler = ExecuteEvents.GetEventHandler<ISelectHandler>(target);
                if (selectHandler != null)
                    eventSystem.SetSelectedGameObject(selectHandler, pointerData);
            }
            ExecuteEvents.Execute(pressHandler ?? target, pointerData, ExecuteEvents.pointerUpHandler);
            var clicked = ExecuteEvents.ExecuteHierarchy(target, pointerData, ExecuteEvents.pointerClickHandler);
            ExecuteEvents.Execute(target, pointerData, ExecuteEvents.pointerExitHandler);

            if (clicked != null)
                return true;

            // Fallback: nothing consumed the pointer click (no EventSystem / no GraphicRaycaster /
            // off-screen element). Fire the component handlers directly so the bridge still acts.
            var button = target.GetComponent<Button>();
            if (button != null && button.interactable)
            {
                button.onClick.Invoke();
                return true;
            }

            var toggle = target.GetComponent<Toggle>();
            if (toggle != null && toggle.interactable)
            {
                toggle.isOn = !toggle.isOn;
                return true;
            }

            var dropdown = target.GetComponent<Dropdown>();
            if (dropdown != null && dropdown.interactable)
            {
                dropdown.Show();
                return true;
            }

            var selectable = target.GetComponent<Selectable>();
            if (selectable != null && selectable.interactable)
            {
                ExecuteEvents.Execute(target, pointerData, ExecuteEvents.submitHandler);
                return true;
            }

            return false;
        }

        /// <summary>
        /// Maps a click-type string ("left"/"right"/"middle") to an EventSystems pointer button.
        /// </summary>
        private static PointerEventData.InputButton ParsePointerButton(string clickType)
        {
            switch ((clickType ?? "left").ToLowerInvariant())
            {
                case "right": return PointerEventData.InputButton.Right;
                case "middle": return PointerEventData.InputButton.Middle;
                default: return PointerEventData.InputButton.Left;
            }
        }

        /// <summary>
        /// Returns the camera to use for pointer math / raycasting on a UI element,
        /// or null for Screen Space - Overlay canvases.
        /// </summary>
        private static Camera GetEventCamera(GameObject target)
        {
            var canvas = target.GetComponentInParent<Canvas>();
            if (canvas == null) return null;
            var root = canvas.rootCanvas != null ? canvas.rootCanvas : canvas;
            if (root.renderMode == RenderMode.ScreenSpaceOverlay) return null;
            return root.worldCamera != null ? root.worldCamera : Camera.main;
        }

        private static object GetElementState(GameObject target, bool includeChildren, bool includeInteractableInfo)
        {
            var state = new Dictionary<string, object>
            {
                ["path"] = GetGameObjectPath(target),
                ["name"] = target.name,
                ["isActive"] = target.activeInHierarchy,
                ["tag"] = target.tag,
                ["layer"] = LayerMask.LayerToName(target.layer)
            };

            // Get component information
            var components = new List<string>();
            foreach (var component in target.GetComponents<Component>())
            {
                components.Add(component.GetType().Name);
            }
            state["components"] = components;

            // Get UI-specific state
            var graphic = target.GetComponent<Graphic>();
            if (graphic != null)
            {
                state["color"] = ColorToHex(graphic.color);
                state["raycastTarget"] = graphic.raycastTarget;
            }

            if (includeInteractableInfo)
            {
                state["isInteractable"] = GetInteractableStatus(target.GetComponent<Component>());
                
                // Get specific UI element values
                var inputField = target.GetComponent<InputField>();
                if (inputField != null)
                {
                    state["value"] = inputField.text;
                    state["placeholder"] = inputField.placeholder?.GetComponent<Text>()?.text;
                }

                var toggle = target.GetComponent<Toggle>();
                if (toggle != null)
                {
                    state["isOn"] = toggle.isOn;
                }

                var slider = target.GetComponent<Slider>();
                if (slider != null)
                {
                    state["value"] = slider.value;
                    state["minValue"] = slider.minValue;
                    state["maxValue"] = slider.maxValue;
                }

                var dropdown = target.GetComponent<Dropdown>();
                if (dropdown != null)
                {
                    state["value"] = dropdown.value;
                    state["options"] = dropdown.options.Select(o => o.text).ToList();
                }

                var text = target.GetComponent<Text>();
                if (text != null)
                {
                    state["text"] = text.text;
                    state["fontSize"] = text.fontSize;
                    state["font"] = text.font?.name;
                }
            }

            if (includeChildren)
            {
                var children = new List<object>();
                foreach (Transform child in target.transform)
                {
                    children.Add(GetElementState(child.gameObject, false, includeInteractableInfo));
                }
                state["children"] = children;
            }

            return state;
        }

        private static bool SetElementValue(GameObject target, JToken value, bool triggerEvents)
        {
            // Handle InputField
            var inputField = target.GetComponent<InputField>();
            if (inputField != null)
            {
                inputField.text = value.ToString();
                if (triggerEvents)
                {
                    inputField.onValueChanged.Invoke(inputField.text);
                    inputField.onEndEdit.Invoke(inputField.text);
                }
                return true;
            }

            // Handle Toggle
            var toggle = target.GetComponent<Toggle>();
            if (toggle != null)
            {
                toggle.isOn = value.ToObject<bool>();
                if (triggerEvents)
                {
                    toggle.onValueChanged.Invoke(toggle.isOn);
                }
                return true;
            }

            // Handle Slider
            var slider = target.GetComponent<Slider>();
            if (slider != null)
            {
                slider.value = value.ToObject<float>();
                if (triggerEvents)
                {
                    slider.onValueChanged.Invoke(slider.value);
                }
                return true;
            }

            // Handle Dropdown
            var dropdown = target.GetComponent<Dropdown>();
            if (dropdown != null)
            {
                dropdown.value = value.ToObject<int>();
                if (triggerEvents)
                {
                    dropdown.onValueChanged.Invoke(dropdown.value);
                }
                return true;
            }

            // Handle Text
            var text = target.GetComponent<Text>();
            if (text != null)
            {
                text.text = value.ToString();
                return true;
            }

            return false;
        }

        private static string ColorToHex(Color color)
        {
            return $"#{ColorUtility.ToHtmlStringRGBA(color)}";
        }

        #endregion
    }
}