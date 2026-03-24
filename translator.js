// ==UserScript==
// @name         English-Vietnamese Translation with AI
// @namespace    https://github.com/
// @version      1.0
// @description  Translate English ↔ Vietnamese with AI.
// @author       dmkt9
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @connect      localhost
// @connect      generativelanguage.googleapis.com
// @connect      api.openai.com
// @connect      openrouter.ai
// @run-at       document-end
// ==/UserScript==

const EDITABLE_MODEL_FIELDS = [
  "DISPLAY_NAME",
  "BASE_URL",
  "MODEL_NAME",
  "CONNECTION_ERROR",
  "HELP_LINES",
  "HEADERS",
];
const SUPPORTED_PROVIDER_TYPES = ["ollama", "openai-compatible", "gemini"];
const TARGET_LANGUAGES = {
  EN: { code: "EN", label: "English", shortLabel: "EN" },
  VI: { code: "VI", label: "Vietnamese", shortLabel: "VI" },
  FR: { code: "FR", label: "French", shortLabel: "FR" },
  DE: { code: "DE", label: "German", shortLabel: "DE" },
  JA: { code: "JA", label: "Japanese", shortLabel: "JA" },
  KO: { code: "KO", label: "Korean", shortLabel: "KO" },
  ZH: { code: "ZH", label: "Chinese", shortLabel: "ZH" },
};
const DEFAULT_TARGET_LANGUAGE = "VI";

function createModelStateHelpers({
  storageKey,
  defaultModelKey,
  modelKeys,
  getValue,
  isValidModelKey: customIsValidModelKey,
  setValue,
}) {
  async function isValidModelKey(modelKey) {
    if (customIsValidModelKey) {
      return customIsValidModelKey(modelKey);
    }

    return modelKeys.includes(modelKey);
  }

  async function getActiveModelKey() {
    const storedKey = await getValue(storageKey, defaultModelKey);
    return (await isValidModelKey(storedKey)) ? storedKey : defaultModelKey;
  }

  async function setActiveModelKey(modelKey) {
    if (!(await isValidModelKey(modelKey))) {
      return false;
    }

    await setValue(storageKey, modelKey);
    return true;
  }

  return {
    isValidModelKey,
    getActiveModelKey,
    setActiveModelKey,
  };
}

function resolveActiveModel(models, activeModelKey, defaultModelKey) {
  return models[activeModelKey] || models[defaultModelKey];
}

function resolveTargetLanguage(targetLanguageCode) {
  return (
    TARGET_LANGUAGES[targetLanguageCode] ||
    TARGET_LANGUAGES[DEFAULT_TARGET_LANGUAGE]
  );
}

function getTargetLanguageToolbarLabel(targetLanguageCode) {
  return resolveTargetLanguage(targetLanguageCode).shortLabel;
}

function buildTranslationMessages(selection, targetLanguageCode) {
  const targetLanguage = resolveTargetLanguage(targetLanguageCode);

  return [
    {
      role: "system",
      content:
        `You are a professional translator. Detect the source language automatically and translate into ${targetLanguage.label}. ` +
        "Preserve specialized terminology when appropriate. Return only the translation.",
    },
    {
      role: "user",
      content: `Translate this passage into ${targetLanguage.label}:\n\n${selection}`,
    },
  ];
}

function resolvePressAction({ durationMs, thresholdMs }) {
  return durationMs >= thresholdMs ? "long_press" : "click";
}

function getTargetLanguagePickerPosition({
  anchorRect,
  gap = 8,
  margin = 8,
  pickerWidth,
  scrollX,
  scrollY,
  viewportWidth,
}) {
  const maxLeft = scrollX + viewportWidth - pickerWidth - margin;

  return {
    left: Math.max(
      scrollX + margin,
      Math.min(anchorRect.left + scrollX, maxLeft),
    ),
    top: anchorRect.bottom + scrollY + gap,
  };
}

function formatModelOptionLabel(displayName, isActive) {
  return `${isActive ? "[x]" : "[ ]"} ${displayName}`;
}

function getModelMenuLabels(models, activeModelKey) {
  return Object.entries(models).map(([modelKey, model]) => ({
    modelKey,
    label: formatModelOptionLabel(
      model.DISPLAY_NAME,
      modelKey === activeModelKey,
    ),
  }));
}

function buildMergedBuiltinModel(baseModel, override = {}) {
  const merged = { ...baseModel };

  for (const field of EDITABLE_MODEL_FIELDS) {
    if (override[field] !== undefined) {
      merged[field] = override[field];
    }
  }

  return merged;
}

function buildModelRegistry({ builtinModels, modelOverrides, customModels }) {
  const registry = {};

  for (const [modelKey, model] of Object.entries(builtinModels)) {
    registry[modelKey] = {
      ...buildMergedBuiltinModel(model, modelOverrides[modelKey]),
      kind: "builtin",
      modelKey,
    };
  }

  for (const [modelKey, model] of Object.entries(customModels)) {
    if (!isValidCustomModelDefinition(model)) {
      continue;
    }

    registry[modelKey] = {
      ...model,
      kind: "custom",
      modelKey,
    };
  }

  return registry;
}

function isValidCustomModelDefinition(model) {
  return Boolean(
    model &&
    model.DISPLAY_NAME &&
    model.PROVIDER_TYPE &&
    SUPPORTED_PROVIDER_TYPES.includes(model.PROVIDER_TYPE) &&
    model.BASE_URL &&
    model.MODEL_NAME,
  );
}

function resolveRegistryActiveModel(registry, activeModelKey, defaultModelKey) {
  return registry[activeModelKey] || registry[defaultModelKey];
}

function isUniqueModelKey(
  modelKey,
  { builtinModels, customModels },
  currentModelKey = null,
) {
  if (modelKey === currentModelKey) {
    return true;
  }

  return !builtinModels[modelKey] && !customModels[modelKey];
}

function attachProviderRuntime(model) {
  const headers = {
    "Content-Type": "application/json",
    ...(model.HEADERS || {}),
  };

  if (model.PROVIDER_TYPE === "ollama") {
    return {
      ...model,
      HEADERS: headers,
      BODY_BUILDER(messages, temperature) {
        return JSON.stringify({
          messages,
          model: model.MODEL_NAME,
          stream: false,
          temperature: temperature ?? 0.2,
          ...(model.REQUEST_OPTIONS || {}),
        });
      },
      RESPONSE_PARSER: (data) => data.message?.content?.trim(),
    };
  }

  if (model.PROVIDER_TYPE === "openai-compatible") {
    return {
      ...model,
      HEADERS: headers,
      BODY_BUILDER(messages) {
        return JSON.stringify({
          messages,
          model: model.MODEL_NAME,
          stream: false,
          ...(model.REQUEST_OPTIONS || {}),
        });
      },
      RESPONSE_PARSER: (data) => data.choices?.[0]?.message?.content?.trim(),
    };
  }

  if (model.PROVIDER_TYPE === "gemini") {
    return {
      ...model,
      HEADERS: headers,
      BODY_BUILDER(messages, temperature) {
        let [system, user] = messages;
        if (system.role === "user") {
          [system, user] = [user, system];
        }

        return JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: user.content,
                },
              ],
            },
          ],
          system_instruction: {
            parts: [
              {
                text: system.content,
              },
            ],
          },
          generationConfig: {
            ...(model.REQUEST_OPTIONS?.generationConfig || {}),
            temperature:
              temperature ??
              model.REQUEST_OPTIONS?.generationConfig?.temperature ??
              0.2,
          },
        });
      },
      RESPONSE_PARSER: (data) =>
        data.candidates?.[0]?.content?.parts?.[0]?.text.trim(),
    };
  }

  throw new Error(`Unsupported provider type: ${model.PROVIDER_TYPE}`);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    attachProviderRuntime,
    buildMergedBuiltinModel,
    buildModelRegistry,
    createModelStateHelpers,
    formatModelOptionLabel,
    buildTranslationMessages,
    getModelMenuLabels,
    getTargetLanguagePickerPosition,
    getTargetLanguageToolbarLabel,
    isValidCustomModelDefinition,
    isUniqueModelKey,
    resolvePressAction,
    resolveTargetLanguage,
    resolveRegistryActiveModel,
    resolveActiveModel,
  };
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof GM_addStyle !== "undefined"
) {
  (function () {
    "use strict";

    const MODELS = {
      QWEN3: {
        DISPLAY_NAME: "Qwen3:8B",
        PROVIDER_TYPE: "ollama",
        BASE_URL: "http://localhost:11434/api/chat",
        MODEL_NAME: "qwen3:8b",
        CONNECTION_ERROR: "Could not connect to Ollama",
        HELP_LINES: [
          "Is Ollama running?",
          "Did you pull qwen3:8b?",
          "Is port 11434 correct?",
        ],
        HEADERS: {
          "Content-Type": "application/json",
        },
      },
      GPT: {
        DISPLAY_NAME: "GPT 5.4",
        PROVIDER_TYPE: "openai-compatible",
        BASE_URL: "http://localhost:20128/v1/chat/completions",
        MODEL_NAME: "cx/gpt-5.4",
        CONNECTION_ERROR: "Could not connect to the Codex server",
        HELP_LINES: [
          "Is the local server running?",
          "Is port 20128 correct?",
          "Is model cx/gpt-5.4 available?",
        ],
        REQUEST_OPTIONS: {
          reasoning: {
            effort: "medium",
            summary: "auto",
          },
        },
        HEADERS: {
          "Content-Type": "application/json",
        },
      },
      GEMINI: {
        DISPLAY_NAME: "Gemini Flash",
        PROVIDER_TYPE: "gemini",
        BASE_URL:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
        MODEL_NAME: "gemini-flash-latest",
        CONNECTION_ERROR: "Could not connect to the Gemini API",
        HELP_LINES: [
          "Is the API key still valid?",
          "Can the network reach the Google AI API?",
          "Is gemini-flash-latest still available?",
        ],
        REQUEST_OPTIONS: {
          generationConfig: {
            temperature: 0.2,
          },
        },
        HEADERS: {
          "Content-Type": "application/json",
        },
      },
    };

    const MODEL_STORAGE_KEY = "activeModelKey";
    const MODEL_OVERRIDES_STORAGE_KEY = "modelOverrides";
    const CUSTOM_MODELS_STORAGE_KEY = "customModels";
    const DEFAULT_MODEL_KEY = "GEMINI";
    const LONG_PRESS_THRESHOLD_MS = 350;
    const TARGET_LANGUAGE_PICKER_GAP = 8;
    const TARGET_LANGUAGE_PICKER_MARGIN = 8;
    const modelState = createModelStateHelpers({
      storageKey: MODEL_STORAGE_KEY,
      defaultModelKey: DEFAULT_MODEL_KEY,
      modelKeys: Object.keys(MODELS),
      getValue: (key, fallback) => GM_getValue(key, fallback),
      isValidModelKey: async (modelKey) => {
        const registry = await getResolvedModelRegistry();
        return Boolean(registry[modelKey]);
      },
      setValue: (key, value) => GM_setValue(key, value),
    });
    const FOOTER_BUTTON_BASE_STYLE =
      "padding:8px 16px; color:white; border:none; border-radius:6px; cursor:pointer;";
    const FOOTER_BUTTON_STYLES = {
      primary: `${FOOTER_BUTTON_BASE_STYLE} background:#22c55e;`,
      secondary: `${FOOTER_BUTTON_BASE_STYLE} background:#64748b;`,
      danger: `${FOOTER_BUTTON_BASE_STYLE} background:#ef4444;`,
    };
    const ACTIONS = {
      translate: {
        icon: "🌐",
        loadingTitle: (model) => `🔄 Translating with ${model.DISPLAY_NAME}...`,
        loadingMessage: () =>
          `Translating into ${resolveTargetLanguage(currentTargetLanguage).label}...`,
        resultTitle: (model) =>
          `✅ Translation complete - ${model.DISPLAY_NAME}`,
        temperature: 0.3,
        buildMessages(selection) {
          return buildTranslationMessages(selection, currentTargetLanguage);
        },
      },
      grammar: {
        icon: "✏️",
        loadingTitle: (model) =>
          `🔄 Correcting grammar with ${model.DISPLAY_NAME}...`,
        loadingMessage:
          "The model is checking spelling, grammar, and fluency...",
        resultTitle: (model) =>
          `✅ Grammar correction complete - ${model.DISPLAY_NAME}`,
        temperature: 0.2,
        buildMessages(selection) {
          return [
            {
              role: "system",
              content:
                "You are an expert English grammar editor. " +
                "Fix spelling, grammar, punctuation, and make the text more natural, coherent, and professional. " +
                "If the text is mixed-language, translate it fully into English first, then refine it while preserving specialized English terminology when appropriate. " +
                "Return only the corrected text. Do not add explanations or any extra words.",
            },
            {
              role: "user",
              content: `Correct the grammar in this passage:\n\n${selection}`,
            },
          ];
        },
      },
      settings: {
        icon: "⚙️",
        run: openModelSettingsPopup,
      },
    };

    GM_addStyle(`
        .qwen-toolbar {
            position: absolute;
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 6px 16px rgba(0,0,0,0.25);
            padding: 4px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            z-index: 2147483647;
            user-select: none;
        }
        .qwen-toolbar-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .qwen-small-btn {
            background: white;
            color: #666;
            border: none;
            padding: 2px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
            transition: all 0.2s;
        }
        .qwen-small-btn:hover {
            transform: scale(1.15);
        }
        .qwen-target-picker {
            position: absolute;
            display: inline-flex;
            gap: 4px;
            flex-wrap: wrap;
            padding: 6px;
            background: #fff;
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            box-shadow: 0 6px 16px rgba(0,0,0,0.18);
            z-index: 2147483647;
        }
        .qwen-target-option {
            border: 1px solid #cbd5e1;
            background: white;
            color: #334155;
            border-radius: 6px;
            padding: 3px 6px;
            cursor: pointer;
            font-size: 11px;
            line-height: 1.2;
        }
        .qwen-target-option.active {
            background: #dcfce7;
            border-color: #22c55e;
            color: #166534;
        }
        .qwen-popup { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 520px; max-height: 80vh; background: #fff; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); z-index: 2147483647; font-family: system-ui, sans-serif; overflow: hidden; }
        .qwen-popup-header { background: #22c55e; color: white; padding: 14px 20px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
        .qwen-popup-body { color: #666; padding: 20px; max-height: 60vh; overflow-y: auto; line-height: 1.5; white-space: pre-wrap; }
        .qwen-popup-footer { padding: 12px 20px; display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid #eee; }
        .qwen-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 40px 20px; color: #666; }
        .close-btn { cursor: pointer; font-size: 20px; padding: 4px 8px; }
        .qwen-settings-popup { width: min(900px, calc(100vw - 32px)); }
        .qwen-settings-layout { display: grid; grid-template-columns: 220px 1fr; gap: 18px; align-items: start; }
        .qwen-settings-sidebar { display: flex; flex-direction: column; gap: 8px; }
        .qwen-settings-section-title { font-size: 12px; font-weight: 700; color: #0f172a; text-transform: uppercase; letter-spacing: 0.08em; margin: 6px 0 2px; }
        .qwen-settings-list-btn { width: 100%; text-align: left; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; cursor: pointer; color: #0f172a; }
        .qwen-settings-list-btn.active { background: #dcfce7; border-color: #22c55e; }
        .qwen-settings-add-btn { width: 100%; text-align: left; background: transparent; color: #0f172a; border: solid 1px #0f172a; border-radius: 10px; padding: 10px 12px; cursor: pointer; margin-top: 8px; }
        .qwen-settings-add-btn:hover { background: #0f172a; color: white; }
        .qwen-settings-form { display: grid; gap: 12px; }
        .qwen-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .qwen-settings-field { display: grid; gap: 6px; }
        .qwen-settings-field.full { grid-column: 1 / -1; }
        .qwen-settings-field label { color: #0f172a; font-size: 13px; font-weight: 600; }
        .qwen-settings-field input, .qwen-settings-field select, .qwen-settings-field textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; font: inherit; color: #0f172a; background: white; }
        .qwen-settings-field textarea { min-height: 104px; resize: vertical; }
        .qwen-settings-hint { font-size: 12px; color: #64748b; line-height: 1.5; }
        .qwen-settings-badge { display: inline-block; background: #e2e8f0; color: #334155; border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
        @media (max-width: 720px) {
            .qwen-settings-layout { grid-template-columns: 1fr; }
            .qwen-settings-grid { grid-template-columns: 1fr; }
        }
    `);

    let toolbar = null;
    let currentSelection = "";
    let currentTargetLanguage = DEFAULT_TARGET_LANGUAGE;
    let targetLanguagePicker = null;
    let targetLanguagePickerCloseHandler = null;
    let activeTranslatePointerId = null;
    let translatePressStartedAt = 0;
    let translatePressTimer = null;
    let translateLongPressActive = false;

    function removeToolbar() {
      resetTranslatePressState();
      closeTargetLanguagePicker();
      if (!toolbar) return;
      toolbar.remove();
      toolbar = null;
    }

    function getSelectedText() {
      return window.getSelection()?.toString().trim() ?? "";
    }

    function createFooterButton(text, variant, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.style.cssText = FOOTER_BUTTON_STYLES[variant];
      button.addEventListener("click", onClick);
      return button;
    }

    function createToolbarButton(action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "qwen-small-btn";
      button.textContent = action.icon;
      button.addEventListener("click", (event) => {
        event.stopImmediatePropagation();
        removeToolbar();
        if (action.run) {
          action.run();
          return;
        }

        runSelectionAction(action);
      });
      return button;
    }

    function clearTranslatePressTimer() {
      if (translatePressTimer !== null) {
        window.clearTimeout(translatePressTimer);
        translatePressTimer = null;
      }
    }

    function resetTranslatePressState(button) {
      clearTranslatePressTimer();
      if (
        button &&
        activeTranslatePointerId !== null &&
        typeof button.hasPointerCapture === "function" &&
        button.hasPointerCapture(activeTranslatePointerId)
      ) {
        button.releasePointerCapture(activeTranslatePointerId);
      }
      activeTranslatePointerId = null;
      translatePressStartedAt = 0;
      translateLongPressActive = false;
    }

    function closeTargetLanguagePicker() {
      if (targetLanguagePickerCloseHandler) {
        document.removeEventListener(
          "mousedown",
          targetLanguagePickerCloseHandler,
          true,
        );
        targetLanguagePickerCloseHandler = null;
      }

      if (!targetLanguagePicker) {
        return;
      }

      targetLanguagePicker.remove();
      targetLanguagePicker = null;
    }

    function openTargetLanguagePicker(anchorElement) {
      closeTargetLanguagePicker();

      const picker = createTargetLanguagePicker();
      picker.style.visibility = "hidden";
      picker.style.left = "0px";
      picker.style.top = "0px";
      document.body.appendChild(picker);

      const { left, top } = getTargetLanguagePickerPosition({
        anchorRect: anchorElement.getBoundingClientRect(),
        gap: TARGET_LANGUAGE_PICKER_GAP,
        margin: TARGET_LANGUAGE_PICKER_MARGIN,
        pickerWidth: picker.offsetWidth || 180,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
      });

      picker.style.left = `${left}px`;
      picker.style.top = `${top}px`;
      picker.style.visibility = "visible";
      targetLanguagePicker = picker;
      targetLanguagePickerCloseHandler = (event) => {
        if (
          picker.contains(event.target) ||
          anchorElement.contains(event.target)
        ) {
          return;
        }

        closeTargetLanguagePicker();
      };
      document.addEventListener(
        "mousedown",
        targetLanguagePickerCloseHandler,
        true,
      );
    }

    function createTranslateButton() {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "qwen-small-btn";
      button.textContent = ACTIONS.translate.icon;

      button.addEventListener("pointerdown", (event) => {
        if (
          !event.isPrimary ||
          (event.pointerType === "mouse" && event.button !== 0)
        ) {
          return;
        }

        event.stopImmediatePropagation();
        closeTargetLanguagePicker();
        activeTranslatePointerId = event.pointerId;
        translatePressStartedAt = Date.now();
        translateLongPressActive = false;
        clearTranslatePressTimer();
        translatePressTimer = window.setTimeout(() => {
          translateLongPressActive = true;
          openTargetLanguagePicker(button);
        }, LONG_PRESS_THRESHOLD_MS);

        if (typeof button.setPointerCapture === "function") {
          button.setPointerCapture(event.pointerId);
        }
      });

      button.addEventListener("pointerup", (event) => {
        if (event.pointerId !== activeTranslatePointerId) {
          return;
        }

        event.stopImmediatePropagation();
        const pressAction = translateLongPressActive
          ? "long_press"
          : resolvePressAction({
              durationMs: Date.now() - translatePressStartedAt,
              thresholdMs: LONG_PRESS_THRESHOLD_MS,
            });

        resetTranslatePressState(button);

        if (pressAction !== "click") {
          return;
        }

        closeTargetLanguagePicker();
        removeToolbar();
        runSelectionAction(ACTIONS.translate);
      });

      button.addEventListener("pointercancel", (event) => {
        if (event.pointerId !== activeTranslatePointerId) {
          return;
        }

        event.stopImmediatePropagation();
        resetTranslatePressState(button);
      });

      button.addEventListener("contextmenu", (event) => {
        if (translateLongPressActive) {
          event.preventDefault();
        }
      });

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      });

      return button;
    }

    function createTargetLanguagePicker() {
      const picker = document.createElement("div");
      picker.className = "qwen-target-picker";

      Object.values(TARGET_LANGUAGES).forEach((language) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = `qwen-target-option${
          language.code === currentTargetLanguage ? " active" : ""
        }`;
        option.textContent = language.shortLabel;
        option.title = language.label;
        option.addEventListener("click", (event) => {
          event.stopImmediatePropagation();
          currentTargetLanguage = language.code;
          closeTargetLanguagePicker();
        });
        picker.appendChild(option);
      });

      return picker;
    }

    function getProviderApiKeyHeader(providerType) {
      return providerType === "gemini" ? "X-goog-api-key" : "Authorization";
    }

    function getApiKeyValue(model) {
      const headerName = getProviderApiKeyHeader(model.PROVIDER_TYPE);
      const headerValue = model.HEADERS?.[headerName] ?? "";

      if (
        headerName === "Authorization" &&
        typeof headerValue === "string" &&
        headerValue.startsWith("Bearer ")
      ) {
        return headerValue.slice(7);
      }

      return headerValue;
    }

    function applyApiKeyToHeaders(providerType, headers, apiKey) {
      const nextHeaders = { ...(headers || {}) };
      delete nextHeaders.Authorization;
      delete nextHeaders["X-goog-api-key"];

      const normalizedApiKey = apiKey.trim();
      if (!normalizedApiKey) {
        return nextHeaders;
      }

      if (providerType === "gemini") {
        nextHeaders["X-goog-api-key"] = normalizedApiKey;
      } else {
        nextHeaders.Authorization = `Bearer ${normalizedApiKey}`;
      }

      return nextHeaders;
    }

    function serializeHelpLines(helpLines) {
      return (helpLines || []).join("\n");
    }

    function parseHelpLines(value) {
      return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }

    function isDeepEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    function createDraftCustomModel(customModels) {
      let counter = 1;
      let nextModelKey = `CUSTOM_${counter}`;

      while (
        !isUniqueModelKey(nextModelKey, {
          builtinModels: MODELS,
          customModels,
        })
      ) {
        counter += 1;
        nextModelKey = `CUSTOM_${counter}`;
      }

      return {
        modelKey: nextModelKey,
        kind: "custom",
        isDraft: true,
        DISPLAY_NAME: "",
        PROVIDER_TYPE: "openai-compatible",
        BASE_URL: "",
        MODEL_NAME: "",
        CONNECTION_ERROR: "Could not connect to the custom model",
        HELP_LINES: [],
        HEADERS: {
          "Content-Type": "application/json",
        },
      };
    }

    function buildModelFormData(model) {
      return {
        modelKey: model.modelKey,
        displayName: model.DISPLAY_NAME || "",
        providerType: model.PROVIDER_TYPE || "openai-compatible",
        baseUrl: model.BASE_URL || "",
        modelName: model.MODEL_NAME || "",
        apiKey: getApiKeyValue(model),
        connectionError: model.CONNECTION_ERROR || "",
        helpLines: serializeHelpLines(model.HELP_LINES),
      };
    }

    function readModelFormData(formElement) {
      const formData = new FormData(formElement);
      return {
        modelKey: String(formData.get("modelKey") || "").trim(),
        displayName: String(formData.get("displayName") || "").trim(),
        providerType: String(formData.get("providerType") || "").trim(),
        baseUrl: String(formData.get("baseUrl") || "").trim(),
        modelName: String(formData.get("modelName") || "").trim(),
        apiKey: String(formData.get("apiKey") || "").trim(),
        connectionError: String(formData.get("connectionError") || "").trim(),
        helpLines: parseHelpLines(String(formData.get("helpLines") || "")),
      };
    }

    function buildBuiltinOverride(baseModel, formValues) {
      const effectiveDisplayName =
        formValues.displayName || baseModel.DISPLAY_NAME;
      const effectiveBaseUrl = formValues.baseUrl || baseModel.BASE_URL;
      const effectiveModelName = formValues.modelName || baseModel.MODEL_NAME;
      const effectiveConnectionError =
        formValues.connectionError || baseModel.CONNECTION_ERROR;
      const effectiveHelpLines = formValues.helpLines.length
        ? formValues.helpLines
        : baseModel.HELP_LINES;
      const effectiveHeaders = applyApiKeyToHeaders(
        baseModel.PROVIDER_TYPE,
        baseModel.HEADERS,
        formValues.apiKey,
      );

      const override = {};

      if (effectiveDisplayName !== baseModel.DISPLAY_NAME) {
        override.DISPLAY_NAME = effectiveDisplayName;
      }
      if (effectiveBaseUrl !== baseModel.BASE_URL) {
        override.BASE_URL = effectiveBaseUrl;
      }
      if (effectiveModelName !== baseModel.MODEL_NAME) {
        override.MODEL_NAME = effectiveModelName;
      }
      if (effectiveConnectionError !== baseModel.CONNECTION_ERROR) {
        override.CONNECTION_ERROR = effectiveConnectionError;
      }
      if (!isDeepEqual(effectiveHelpLines, baseModel.HELP_LINES)) {
        override.HELP_LINES = effectiveHelpLines;
      }
      if (!isDeepEqual(effectiveHeaders, baseModel.HEADERS)) {
        override.HEADERS = effectiveHeaders;
      }

      return override;
    }

    function buildCustomModelDefinition(formValues) {
      return {
        DISPLAY_NAME: formValues.displayName,
        PROVIDER_TYPE: formValues.providerType,
        BASE_URL: formValues.baseUrl,
        MODEL_NAME: formValues.modelName,
        CONNECTION_ERROR:
          formValues.connectionError || "Could not connect to the custom model",
        HELP_LINES: formValues.helpLines,
        HEADERS: applyApiKeyToHeaders(
          formValues.providerType,
          {
            "Content-Type": "application/json",
          },
          formValues.apiKey,
        ),
      };
    }

    async function getModelOverrides() {
      const overrides = await GM_getValue(MODEL_OVERRIDES_STORAGE_KEY, {});
      return overrides && typeof overrides === "object" ? overrides : {};
    }

    async function setModelOverrides(value) {
      return GM_setValue(MODEL_OVERRIDES_STORAGE_KEY, value);
    }

    async function getCustomModels() {
      const customModels = await GM_getValue(CUSTOM_MODELS_STORAGE_KEY, {});
      return customModels && typeof customModels === "object"
        ? customModels
        : {};
    }

    async function setCustomModels(value) {
      return GM_setValue(CUSTOM_MODELS_STORAGE_KEY, value);
    }

    async function getResolvedModelRegistry() {
      return buildModelRegistry({
        builtinModels: MODELS,
        modelOverrides: await getModelOverrides(),
        customModels: await getCustomModels(),
      });
    }

    async function getActiveModel() {
      const registry = await getResolvedModelRegistry();
      const modelKey = await modelState.getActiveModelKey();
      return attachProviderRuntime(
        resolveRegistryActiveModel(registry, modelKey, DEFAULT_MODEL_KEY),
      );
    }

    function requestModel(model, messages, temperature) {
      const body = model.BODY_BUILDER(messages, temperature);

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: model.BASE_URL,
          headers: model.HEADERS,
          data: body,
          timeout: 60000,
          onload: (response) => {
            if (response.status !== 200) {
              reject(new Error(`HTTP ${response.status}`));
              return;
            }

            resolve({
              model,
              payload: JSON.parse(response.responseText),
            });
          },
          onerror: () => reject(new Error(model.CONNECTION_ERROR)),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    function showToolbar() {
      const selection = window.getSelection();

      if (
        !selection ||
        !selection.rangeCount ||
        document.querySelector(".qwen-popup") ||
        document.querySelector(".qwen-toolbar")
      ) {
        return;
      }

      const text = getSelectedText();
      if (text.length < 4) {
        removeToolbar();
        return;
      }

      currentSelection = text;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      removeToolbar();

      toolbar = document.createElement("div");
      toolbar.className = "qwen-toolbar";

      const toolbarRow = document.createElement("div");
      toolbarRow.className = "qwen-toolbar-row";

      toolbarRow.appendChild(createTranslateButton());
      toolbarRow.appendChild(createToolbarButton(ACTIONS.grammar));
      toolbarRow.appendChild(createToolbarButton(ACTIONS.settings));
      toolbar.appendChild(toolbarRow);

      let x = rect.right + window.scrollX + 12;
      let y = rect.top + window.scrollY - 8;

      if (x + 280 > window.innerWidth + window.scrollX) {
        x = rect.left + window.scrollX - 290;
      }

      toolbar.style.left = `${x}px`;
      toolbar.style.top = `${y}px`;

      document.body.appendChild(toolbar);
    }

    function createPopup(title, content, options = {}) {
      const { isLoading = false, allowHTML = false } = options;
      const popup = document.createElement("div");
      popup.className = "qwen-popup";

      const header = document.createElement("div");
      header.className = "qwen-popup-header";
      header.innerHTML = `<span>${title}</span><span class="close-btn">✕</span>`;

      const body = document.createElement("div");
      body.className = isLoading ? "qwen-loading" : "qwen-popup-body";
      if (allowHTML) {
        body.innerHTML = content;
      } else {
        body.textContent = content;
      }

      const footer = document.createElement("div");
      footer.className = "qwen-popup-footer";

      popup.appendChild(header);
      popup.appendChild(body);
      if (!isLoading) popup.appendChild(footer);

      document.body.appendChild(popup);

      header
        .querySelector(".close-btn")
        .addEventListener("click", () => popup.remove());

      return { popup, body, footer };
    }

    function showResultPopup(title, result) {
      const { popup, footer } = createPopup(title, result);
      const copyBtn = createFooterButton("📋 Copy", "primary", () => {
        navigator.clipboard.writeText(result).then(() => {
          copyBtn.textContent = "✅ Copied!";
          setTimeout(() => {
            copyBtn.textContent = "📋 Copy";
          }, 1500);
        });
      });
      const closeBtn = createFooterButton("Close", "danger", () =>
        popup.remove(),
      );

      footer.appendChild(copyBtn);
      footer.appendChild(closeBtn);
    }

    async function openModelSettingsPopup() {
      const popupState = {
        activeModelKey: await modelState.getActiveModelKey(),
        customModels: await getCustomModels(),
        footerButtons: null,
        modelOverrides: await getModelOverrides(),
        popup: null,
        body: null,
        footer: null,
        selectedModelKey: null,
        draftCustomModel: null,
      };
      popupState.selectedModelKey = popupState.activeModelKey;
      popupState.registry = buildModelRegistry({
        builtinModels: MODELS,
        modelOverrides: popupState.modelOverrides,
        customModels: popupState.customModels,
      });
      if (!popupState.registry[popupState.selectedModelKey]) {
        popupState.selectedModelKey = DEFAULT_MODEL_KEY;
      }

      const { popup, body, footer } = createPopup("⚙️ Manage Models", "");
      popup.classList.add("qwen-settings-popup");
      popupState.popup = popup;
      popupState.body = body;
      popupState.footer = footer;

      async function saveCurrentModel() {
        const formElement = popupState.body.querySelector(
          ".qwen-settings-form",
        );
        if (!formElement) return;

        const formValues = readModelFormData(formElement);
        const selectedModel =
          popupState.selectedModelKey === "__new__"
            ? popupState.draftCustomModel
            : popupState.registry[popupState.selectedModelKey];

        if (!selectedModel) {
          return;
        }

        if (selectedModel.kind === "builtin") {
          const override = buildBuiltinOverride(
            MODELS[selectedModel.modelKey],
            formValues,
          );

          if (Object.keys(override).length === 0) {
            delete popupState.modelOverrides[selectedModel.modelKey];
          } else {
            popupState.modelOverrides[selectedModel.modelKey] = override;
          }

          await setModelOverrides(popupState.modelOverrides);
        } else {
          if (
            !isUniqueModelKey(
              formValues.modelKey,
              {
                builtinModels: MODELS,
                customModels: popupState.customModels,
              },
              selectedModel.isDraft ? null : selectedModel.modelKey,
            )
          ) {
            alert("❌ That model key already exists.");
            return;
          }

          const customModel = buildCustomModelDefinition(formValues);
          if (!isValidCustomModelDefinition(customModel)) {
            alert("❌ Please enter a key, provider, URL, and model.");
            return;
          }

          if (
            !selectedModel.isDraft &&
            selectedModel.modelKey !== formValues.modelKey
          ) {
            delete popupState.customModels[selectedModel.modelKey];
          }

          popupState.customModels[formValues.modelKey] = customModel;
          await setCustomModels(popupState.customModels);

          if (popupState.activeModelKey === selectedModel.modelKey) {
            popupState.activeModelKey = formValues.modelKey;
            await modelState.setActiveModelKey(formValues.modelKey);
          }

          popupState.selectedModelKey = formValues.modelKey;
          popupState.draftCustomModel = null;
        }

        popupState.registry = buildModelRegistry({
          builtinModels: MODELS,
          modelOverrides: popupState.modelOverrides,
          customModels: popupState.customModels,
        });
        renderEditor();
      }

      async function useSelectedModel() {
        if (popupState.selectedModelKey === "__new__") {
          alert("❌ Save the custom model before selecting it.");
          return;
        }

        popupState.activeModelKey = popupState.selectedModelKey;
        await modelState.setActiveModelKey(popupState.selectedModelKey);
        renderEditor();
      }

      async function resetBuiltinModel() {
        const modelKey = popupState.selectedModelKey;
        delete popupState.modelOverrides[modelKey];
        await setModelOverrides(popupState.modelOverrides);
        popupState.registry = buildModelRegistry({
          builtinModels: MODELS,
          modelOverrides: popupState.modelOverrides,
          customModels: popupState.customModels,
        });
        renderEditor();
      }

      async function deleteCustomModel() {
        const modelKey = popupState.selectedModelKey;
        delete popupState.customModels[modelKey];
        await setCustomModels(popupState.customModels);

        if (popupState.activeModelKey === modelKey) {
          popupState.activeModelKey = DEFAULT_MODEL_KEY;
          await modelState.setActiveModelKey(DEFAULT_MODEL_KEY);
        }

        popupState.selectedModelKey = popupState.activeModelKey;
        popupState.registry = buildModelRegistry({
          builtinModels: MODELS,
          modelOverrides: popupState.modelOverrides,
          customModels: popupState.customModels,
        });
        renderEditor();
      }

      function renderFooter(selectedModel) {
        popupState.footer.innerHTML = "";
        popupState.footer.appendChild(
          createFooterButton("Save", "primary", () => {
            saveCurrentModel();
          }),
        );

        if (popupState.selectedModelKey !== "__new__") {
          popupState.footer.appendChild(
            createFooterButton("Use This Model", "secondary", () => {
              useSelectedModel();
            }),
          );
        }

        if (selectedModel.kind === "builtin") {
          popupState.footer.appendChild(
            createFooterButton("Reset to Default", "secondary", () => {
              resetBuiltinModel();
            }),
          );
        }

        if (selectedModel.kind === "custom" && !selectedModel.isDraft) {
          popupState.footer.appendChild(
            createFooterButton("Delete", "danger", () => {
              deleteCustomModel();
            }),
          );
        }
      }

      function renderEditor() {
        const selectedModel =
          popupState.selectedModelKey === "__new__"
            ? popupState.draftCustomModel
            : popupState.registry[popupState.selectedModelKey];
        const formModel =
          selectedModel ||
          popupState.registry[popupState.activeModelKey] ||
          popupState.registry[DEFAULT_MODEL_KEY];
        const formData = buildModelFormData(formModel);
        const builtinButtons = Object.values(popupState.registry)
          .filter((model) => model.kind === "builtin")
          .map(
            (model) => `
              <button type="button" class="qwen-settings-list-btn ${
                popupState.selectedModelKey === model.modelKey ? "active" : ""
              }" data-select-model="${model.modelKey}">
                ${formatModelOptionLabel(
                  model.DISPLAY_NAME,
                  popupState.activeModelKey === model.modelKey,
                )}
              </button>
            `,
          )
          .join("");
        const customButtons = Object.values(popupState.registry)
          .filter((model) => model.kind === "custom")
          .map(
            (model) => `
              <button type="button" class="qwen-settings-list-btn ${
                popupState.selectedModelKey === model.modelKey ? "active" : ""
              }" data-select-model="${model.modelKey}">
                ${formatModelOptionLabel(
                  model.DISPLAY_NAME,
                  popupState.activeModelKey === model.modelKey,
                )}
              </button>
            `,
          )
          .join("");
        const customKeyReadonly =
          formModel.kind === "builtin" || !formModel.isDraft ? "readonly" : "";
        const providerReadonly = formModel.kind === "builtin" ? "disabled" : "";

        popupState.body.innerHTML = `
          <div class="qwen-settings-layout">
            <div class="qwen-settings-sidebar">
              <div class="qwen-settings-section-title">Built-in Models</div>
              ${builtinButtons}
              <div class="qwen-settings-section-title">Custom Models</div>
              ${customButtons || '<div class="qwen-settings-hint">No custom models yet.</div>'}
              <button type="button" class="qwen-settings-add-btn" data-add-custom="true">+ Add Custom Model</button>
            </div>
            <form class="qwen-settings-form">
              <div class="qwen-settings-hint">
                <span class="qwen-settings-badge">${formModel.kind === "builtin" ? "Built-in" : formModel.isDraft ? "Draft" : "Custom"}</span>
                ${
                  formModel.kind === "builtin"
                    ? "Blank values fall back to MODELS."
                    : "Custom models use runtime behavior fixed by the selected provider type."
                }
              </div>
              <div class="qwen-settings-grid">
                <div class="qwen-settings-field">
                  <label for="modelKey">Model Key</label>
                  <input id="modelKey" name="modelKey" value="${formData.modelKey}" ${customKeyReadonly}>
                </div>
                <div class="qwen-settings-field">
                  <label for="displayName">Display Name</label>
                  <input id="displayName" name="displayName" value="${formData.displayName}">
                </div>
                <div class="qwen-settings-field">
                  <label for="providerType">Provider</label>
                  <select id="providerType" name="providerType" ${providerReadonly}>
                    ${SUPPORTED_PROVIDER_TYPES.map(
                      (providerType) => `
                        <option value="${providerType}" ${
                          formData.providerType === providerType
                            ? "selected"
                            : ""
                        }>${providerType}</option>
                      `,
                    ).join("")}
                  </select>
                </div>
                <div class="qwen-settings-field">
                  <label for="modelName">Model</label>
                  <input id="modelName" name="modelName" value="${formData.modelName}">
                </div>
                <div class="qwen-settings-field full">
                  <label for="baseUrl">URL</label>
                  <input id="baseUrl" name="baseUrl" value="${formData.baseUrl}">
                </div>
                <div class="qwen-settings-field full">
                  <label for="apiKey">API Key</label>
                  <input id="apiKey" name="apiKey" value="${formData.apiKey}">
                </div>
                <div class="qwen-settings-field full">
                  <label for="connectionError">Connection Error</label>
                  <input id="connectionError" name="connectionError" value="${formData.connectionError}">
                </div>
                <div class="qwen-settings-field full">
                  <label for="helpLines">Help Lines</label>
                  <textarea id="helpLines" name="helpLines">${formData.helpLines}</textarea>
                </div>
              </div>
            </form>
          </div>
        `;

        popupState.body
          .querySelectorAll("[data-select-model]")
          .forEach((button) => {
            button.addEventListener("click", () => {
              popupState.selectedModelKey = button.dataset.selectModel;
              popupState.draftCustomModel = null;
              renderEditor();
            });
          });

        popupState.body
          .querySelector("[data-add-custom]")
          .addEventListener("click", () => {
            popupState.selectedModelKey = "__new__";
            popupState.draftCustomModel = createDraftCustomModel(
              popupState.customModels,
            );
            renderEditor();
          });

        renderFooter(formModel);
      }

      renderEditor();
    }

    async function registerModelMenuCommands() {
      const activeModelKey = await modelState.getActiveModelKey();
      const registry = await getResolvedModelRegistry();
      const menuLabels = getModelMenuLabels(registry, activeModelKey);

      menuLabels.forEach(({ modelKey, label }) => {
        GM_registerMenuCommand(label, () => {
          modelState.setActiveModelKey(modelKey);
        });
      });
    }

    async function runSelectionAction(action) {
      if (!currentSelection) return;

      let loadingPopup = null;

      try {
        const model = await getActiveModel();
        ({ popup: loadingPopup } = createPopup(
          action.loadingTitle(model),
          typeof action.loadingMessage === "function"
            ? action.loadingMessage(model)
            : action.loadingMessage,
          { isLoading: true },
        ));
        const { payload } = await requestModel(
          model,
          action.buildMessages(currentSelection),
          action.temperature,
        );
        const result = model.RESPONSE_PARSER(payload) || "No result received.";

        loadingPopup.remove();
        showResultPopup(action.resultTitle(model), result);
      } catch (error) {
        if (loadingPopup) {
          loadingPopup.remove();
        }
        const model = await getActiveModel();
        showErrorPopup(
          error instanceof Error ? error.message : String(error),
          model,
        );
      }
    }

    function showErrorPopup(message, model) {
      const helpMarkup = model.HELP_LINES.map((line) => `• ${line}`).join(
        "<br>",
      );
      const { popup, footer } = createPopup(
        "❌ Error",
        `<div style="color:#ef4444; text-align:center;">
                ${message}<br><br>
                <small>Check:<br>${helpMarkup}<br>• Current model: <strong>${model.MODEL_NAME}</strong></small>
            </div>`,
        { allowHTML: true },
      );
      footer.appendChild(
        createFooterButton("Close", "danger", () => popup.remove()),
      );
    }

    document.addEventListener("mouseup", () => setTimeout(showToolbar, 80));

    document.addEventListener("mousedown", (event) => {
      if (
        toolbar &&
        !toolbar.contains(event.target) &&
        (!targetLanguagePicker || !targetLanguagePicker.contains(event.target))
      ) {
        removeToolbar();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        const text = getSelectedText();
        if (text) {
          currentSelection = text;
          runSelectionAction(ACTIONS.translate);
        } else {
          alert("❗ Please select some text first");
        }
      }
    });

    registerModelMenuCommands();

    getActiveModel().then((model) => {
      console.log(
        `%c✅ Script ${model.DISPLAY_NAME} version 1.3 is ready!\nSelect text → the toolbar will show 3 buttons: translate, fix grammar, or open the model editor`,
        "color:#22c55e; font-weight:600",
      );
    });
  })();
}
