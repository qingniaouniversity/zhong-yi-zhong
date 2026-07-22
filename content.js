(function initZhongYiZhong() {
  if (window.__zhongYiZhongLoaded) return;
  window.__zhongYiZhongLoaded = true;

  const ROOT_ID = "zhong-yi-zhong-root";
  const CHIP_ID = "zhong-yi-zhong-chip";
  const PANEL_ID = "zhong-yi-zhong-panel";
  const DEPTH_OPTIONS = [
    { value: "plain", label: "更白话" },
    { value: "standard", label: "标准" },
    { value: "deep", label: "稍深入" }
  ];
  const MAX_RECENT_ITEMS = 5;

  let pendingSelectionText = "";
  let activeText = "";
  let latestExplanation = "";
  let activeRequestId = 0;
  let panelState = "closed";
  let autoExplainTimer = 0;
  let streamBuffer = "";
  let streamPollTimer = 0;
  let streamPollStartTimer = 0;
  let streamEventOffset = 0;
  let streamStallTimer = 0;
  let fallbackInFlight = false;
  let streamStartedAt = 0;
  let activeStreamRequestId = 0;
  let streamDebug = "";
  let lastStreamWarning = "";
  let streamPort = null;
  let followUpPort = null;
  let activeFollowUpRequestId = 0;
  let explainDepth = "standard";
  let recentExplanations = [];

  document.addEventListener("mouseup", handleSelectionChange);
  document.addEventListener("keyup", handleSelectionChange);
  document.addEventListener("selectionchange", debounce(handleSelectionChange, 180));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ZZZ_ACTION_EXPLAIN") {
      const text = normalizeSelectedText(window.getSelection()?.toString());
      if (text) {
        pendingSelectionText = text;
        hideChip();
        explainText(text);
      } else {
        renderPanel({ state: "empty" });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "ZZZ_CONTEXT_MENU_EXPLAIN") {
      const text = normalizeSelectedText(message.payload?.selectedText || window.getSelection()?.toString());
      if (text) {
        pendingSelectionText = text;
        hideChip();
        explainText(text);
        sendResponse({ ok: true });
      } else {
        renderPanel({ state: "error", error: "请先选中一段需要解释的中文。" });
        sendResponse({ ok: false });
      }
      return true;
    }

    return false;
  });

  function handleSelectionChange() {
    const selection = window.getSelection();
    const text = normalizeSelectedText(selection?.toString());

    if (!text || text.length < 2 || isInsidePlugin(selection?.anchorNode)) {
      hideChip();
      return;
    }

    pendingSelectionText = text;
    showChip(getSelectionRect(selection));

    if (shouldAutoExplainSelection()) {
      scheduleAutoExplain(text);
      return;
    }

    if (panelState !== "loading" && panelState !== "streaming" && panelState !== "asking" && panelState !== "ready") {
      renderPanel({ state: "selected", selectedText: text });
    }
  }

  function showChip(rect) {
    if (!rect) return;

    const chip = getOrCreateChip();
    chip.style.top = `${Math.max(8, window.scrollY + rect.bottom + 8)}px`;
    chip.style.left = `${Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 96)}px`;
    chip.hidden = false;
  }

  function hideChip() {
    const chip = document.getElementById(CHIP_ID);
    if (chip) chip.hidden = true;
  }

  function getOrCreateChip() {
    let chip = document.getElementById(CHIP_ID);
    if (chip) return chip;

    chip = document.createElement("button");
    chip.id = CHIP_ID;
    chip.type = "button";
    chip.textContent = "中译中";
    chip.setAttribute("aria-label", "用中译中解释选中的文字");
    chip.addEventListener("mousedown", stopPluginMouseEvent);
    chip.addEventListener("click", () => {
      hideChip();
      explainText(pendingSelectionText);
    });
    document.documentElement.appendChild(chip);
    return chip;
  }

  async function explainText(text) {
    const textToExplain = normalizeSelectedText(text);
    if (!textToExplain) {
      renderPanel({ state: "empty" });
      return;
    }

    if (textToExplain === activeText && (panelState === "loading" || panelState === "streaming")) {
      return;
    }

    closeActiveStream();
    closeFollowUpStream();

    const requestId = ++activeRequestId;
    activeText = textToExplain;
    latestExplanation = "";
    streamBuffer = "";
    streamEventOffset = 0;
    renderPanel({ state: "streaming", activeText: textToExplain, streamedText: "" });

    startStreamRequest({
      requestId,
      selectedText: textToExplain,
      pageTitle: document.title,
      pageUrl: location.href,
      explainDepth
    });
  }

  function sendFollowUp(question, messages, sourceText) {
    const textForQuestion = normalizeSelectedText(sourceText || activeText);
    const nextMessages = [...messages, { role: "user", content: question }];
    const followUpRequestId = ++activeFollowUpRequestId;
    let answer = "";

    closeFollowUpStream();
    renderPanel({ state: "ready", activeText: textForQuestion, result: getCurrentResult(), messages: nextMessages, asking: true });

    try {
      const port = chrome.runtime.connect({ name: "ZZZ_FOLLOW_UP_STREAM" });
      followUpPort = port;

      port.onMessage.addListener((message) => {
        if (followUpRequestId !== activeFollowUpRequestId) return;

        if (message?.type === "ZZZ_FOLLOW_UP_DELTA") {
          answer += message.delta || "";
          renderPanel({
            state: "ready",
            activeText: textForQuestion,
            result: getCurrentResult(),
            messages: [...nextMessages, { role: "assistant", content: answer || "正在思考..." }],
            asking: true
          });
          return;
        }

        if (message?.type === "ZZZ_FOLLOW_UP_DONE") {
          closeFollowUpStream(false);
          try {
            port.disconnect();
          } catch (_error) {}
          renderPanel({
            state: "ready",
            activeText: textForQuestion,
            result: getCurrentResult(),
            messages: [...nextMessages, { role: "assistant", content: message.answer || answer || "没有拿到回答。" }]
          });
          return;
        }

        if (message?.type === "ZZZ_FOLLOW_UP_ERROR") {
          closeFollowUpStream(false);
          try {
            port.disconnect();
          } catch (_error) {}
          renderPanel({
            state: "ready",
            activeText: textForQuestion,
            result: getCurrentResult(),
            messages: [...nextMessages, { role: "assistant", content: message.error || "追问失败，请稍后再试。" }]
          });
        }
      });

      port.onDisconnect.addListener(() => {
        if (followUpPort === port) {
          followUpPort = null;
        }
        if (followUpRequestId === activeFollowUpRequestId && !answer) {
          renderPanel({
            state: "ready",
            activeText: textForQuestion,
            result: getCurrentResult(),
            messages: [...nextMessages, { role: "assistant", content: chrome.runtime.lastError?.message || "追问连接已断开。" }]
          });
        }
      });

      port.postMessage({
        type: "ZZZ_FOLLOW_UP_STREAM_START",
        payload: {
          selectedText: textForQuestion,
          previousAnswer: latestExplanation,
          question
        }
      });
    } catch (error) {
      renderPanel({
        state: "ready",
        activeText: textForQuestion,
        result: getCurrentResult(),
        messages: [...nextMessages, { role: "assistant", content: error?.message || "追问启动失败。" }]
      });
    }
  }

  function renderPanel(view) {
    const panel = getOrCreatePanel();
    panelState = view.state === "ready" && view.asking ? "asking" : view.state;
    panel.hidden = false;
    document.documentElement.classList.add("zzz-panel-open");
    panel.innerHTML = "";
    if (view.activeText) {
      panel.dataset.activeText = view.activeText;
    }

    const header = createElement("div", "zzz-panel-header");
    header.append(
      createElement("div", "zzz-title", "中译中"),
      renderDepthControl(),
      createIconButton("设置", "⚙", () => chrome.runtime.sendMessage({ type: "ZZZ_OPEN_OPTIONS" })),
      createIconButton("关闭", "×", () => {
        closeActiveStream();
        closeFollowUpStream();
        panel.hidden = true;
        document.documentElement.classList.remove("zzz-panel-open");
        panelState = "closed";
      })
    );
    panel.append(header);

    if (view.state === "loading" || view.state === "streaming") {
      const section = createElement("section", "zzz-section");
      section.append(
        createElement("div", "zzz-section-title", "正在解释"),
        createElement("div", "zzz-section-title zzz-stream-title", "白话解释"),
        createElement("p", "zzz-body-text zzz-streaming-text", view.streamedText || "正在连接模型..."),
        createElement("p", "zzz-muted zzz-loading-note", "内容会边生成边显示。你可以继续划其他文字，当前翻译不会被打断；要切换到新选区，请点选区旁的“中译中”。")
      );
      panel.append(section);
      return;
    }

    if (view.state === "selected") {
      const original = createElement("section", "zzz-section");
      original.append(createElement("div", "zzz-section-title", "已选中"), createElement("p", "zzz-original", view.selectedText || pendingSelectionText));
      panel.append(original);

      const action = createElement("section", "zzz-section");
      const explainButton = createElement("button", "zzz-primary-action", "解释这段话");
      explainButton.type = "button";
      explainButton.addEventListener("mousedown", stopPluginMouseEvent);
      explainButton.addEventListener("click", () => explainText(view.selectedText || pendingSelectionText));
      action.append(
        createElement("div", "zzz-section-title", "下一步"),
        createElement("p", "zzz-muted", "点击按钮生成白话解释、关键词和追问入口。"),
        explainButton
      );
      panel.append(action);
      return;
    }

    if (view.state === "error") {
      const section = createElement("section", "zzz-section");
      section.append(createElement("div", "zzz-section-title", "出错了"), createElement("p", "zzz-error", view.error || "解释失败，请稍后再试。"));
      const actions = createElement("div", "zzz-error-actions");
      const retry = createElement("button", "zzz-secondary-action", "重试");
      retry.type = "button";
      retry.addEventListener("mousedown", stopPluginMouseEvent);
      retry.addEventListener("click", () => explainText(activeText || pendingSelectionText));
      const settings = createElement("button", "zzz-secondary-action", "设置");
      settings.type = "button";
      settings.addEventListener("mousedown", stopPluginMouseEvent);
      settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "ZZZ_OPEN_OPTIONS" }));
      actions.append(retry, settings);
      section.append(actions);
      panel.append(section);
      return;
    }

    if (view.state === "empty") {
      const section = createElement("section", "zzz-section");
      section.append(
        createElement("div", "zzz-section-title", "还没有选中文本"),
        createElement("p", "zzz-muted", "先在网页上选中一段中文，再点插件图标、右键菜单，或选区旁边的“中译中”按钮。")
      );
      panel.append(section);
      return;
    }

    const shownActiveText = view.activeText || panel.dataset.activeText || activeText;
    const result = view.result || getCurrentResult();
    panel.dataset.currentResult = JSON.stringify(result);
    panel.dataset.activeText = shownActiveText;

    if (view.warning || lastStreamWarning) {
      const warning = createElement("section", "zzz-section");
      warning.append(
        createElement("div", "zzz-section-title", "流式状态"),
        createElement("p", "zzz-warning", view.warning || lastStreamWarning)
      );
      panel.append(warning);
    }

    if (result.mainPoint) {
      const overview = createElement("section", "zzz-section");
      overview.append(
        createElement("div", "zzz-section-title", "总览"),
        createElement("p", "zzz-main-point", `这段话主要想说明的是：${result.mainPoint}`)
      );
      panel.append(overview);
    }

    const explanation = createElement("section", "zzz-section");
    const explanationTitle = createElement("div", "zzz-section-title-row");
    explanationTitle.append(
      createElement("div", "zzz-section-title", "白话解释"),
      createCopyButton(result)
    );
    explanation.append(
      explanationTitle,
      createElement("p", "zzz-body-text", result.plainTextExplanation || "没有拿到解释内容。")
    );
    panel.append(explanation);

    const keywords = createElement("section", "zzz-section");
    keywords.append(createElement("div", "zzz-section-title", "关键词"));
    const keywordList = createElement("div", "zzz-keyword-list");
    if (result.keywords?.length) {
      result.keywords.forEach((keyword) => {
        const item = createElement("div", "zzz-keyword");
        item.append(createElement("strong", "", keyword.term), createElement("span", "", keyword.explanation));
        keywordList.append(item);
      });
    } else {
      keywordList.append(createElement("p", "zzz-muted", "这段话没有识别出明显关键词。"));
    }
    keywords.append(keywordList);
    panel.append(keywords);

    renderRecentExplanations(panel, shownActiveText);
    renderChat(panel, result, view.messages || [], Boolean(view.asking), shownActiveText);
  }

  function renderChat(panel, result, messages, asking, sourceText) {
    const chat = createElement("section", "zzz-section zzz-chat");
    chat.append(createElement("div", "zzz-section-title", "继续追问"));

    const suggestions = createElement("div", "zzz-suggestions");
    if (!messages.length) {
      (result.suggestedQuestions || []).forEach((question) => {
        const button = createElement("button", "zzz-suggestion", question);
        button.type = "button";
        button.addEventListener("mousedown", stopPluginMouseEvent);
        button.addEventListener("click", () => sendFollowUp(question, messages, sourceText));
        suggestions.append(button);
      });
      chat.append(suggestions);
    }

    const transcript = createElement("div", "zzz-transcript");
    messages.forEach((message) => {
      transcript.append(createElement("div", `zzz-message zzz-message-${message.role}`, message.content));
    });
    const hasStreamingAssistantMessage = messages[messages.length - 1]?.role === "assistant";
    if (asking && !hasStreamingAssistantMessage) {
      transcript.append(createElement("div", "zzz-message zzz-message-assistant", "正在思考..."));
    }
    chat.append(transcript);

    const form = createElement("form", "zzz-followup-form");
    const input = createElement("textarea", "zzz-followup-input");
    input.placeholder = "继续问一句，比如：这句话在今天怎么理解？";
    input.rows = 2;
    input.maxLength = 800;
    const submit = createElement("button", "zzz-submit", "发送");
    submit.type = "submit";
    submit.disabled = asking;
    submit.addEventListener("mousedown", stopPluginMouseEvent);
    form.append(input, submit);
    form.addEventListener("mousedown", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (question) sendFollowUp(question, messages, sourceText);
    });
    chat.append(form);
    panel.append(chat);
  }

  function renderRecentExplanations(panel, currentText) {
    const items = recentExplanations.filter((item) => item.selectedText !== currentText).slice(0, MAX_RECENT_ITEMS);
    if (!items.length) return;

    const section = createElement("section", "zzz-section zzz-recent");
    section.append(createElement("div", "zzz-section-title", "最近解释"));

    const list = createElement("div", "zzz-recent-list");
    items.forEach((item) => {
      const button = createElement("button", "zzz-recent-item");
      button.type = "button";
      button.addEventListener("mousedown", stopPluginMouseEvent);
      button.addEventListener("click", (event) => {
        stopPluginMouseEvent(event);
        closeActiveStream();
        closeFollowUpStream();
        activeText = item.selectedText;
        explainDepth = item.explainDepth || "standard";
        latestExplanation = item.result?.plainTextExplanation || "";
        renderPanel({ state: "ready", activeText: item.selectedText, result: item.result, messages: [] });
      });
      button.append(
        createElement("span", "zzz-recent-title", item.result?.mainPoint || item.result?.plainTextExplanation || "之前的解释"),
        createElement("span", "zzz-recent-source", item.selectedText)
      );
      list.append(button);
    });

    section.append(list);
    panel.append(section);
  }

  function getOrCreatePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "中译中解释面板");
    panel.addEventListener("mousedown", (event) => event.stopPropagation());
    panel.addEventListener("click", (event) => event.stopPropagation());
    root.append(panel);
    document.documentElement.append(root);
    return panel;
  }

  function getCurrentResult() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel?.dataset.currentResult) {
      return { mainPoint: "", plainTextExplanation: latestExplanation, keywords: [], suggestedQuestions: [] };
    }

    try {
      return JSON.parse(panel.dataset.currentResult);
    } catch (_error) {
      return { mainPoint: "", plainTextExplanation: latestExplanation, keywords: [], suggestedQuestions: [] };
    }
  }

  function rememberRecentExplanation(selectedText, result) {
    const text = normalizeSelectedText(selectedText);
    if (!text || !result?.plainTextExplanation) return;

    recentExplanations = recentExplanations.filter((item) => item.selectedText !== text);
    recentExplanations.unshift({
      selectedText: text,
      result,
      explainDepth,
      createdAt: Date.now()
    });
    recentExplanations = recentExplanations.slice(0, MAX_RECENT_ITEMS);
  }

  function getSelectionRect(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) return rect;
    const fallback = range.getClientRects()[0];
    return fallback || null;
  }

  function isInsidePlugin(node) {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest?.(`#${ROOT_ID}, #${CHIP_ID}, #${PANEL_ID}`));
  }

  function createIconButton(label, text, onClick) {
    const button = createElement("button", "zzz-icon-button", text);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", stopPluginMouseEvent);
    button.addEventListener("click", (event) => {
      stopPluginMouseEvent(event);
      onClick(event);
    });
    return button;
  }

  function renderDepthControl() {
    const control = createElement("div", "zzz-depth-control");
    const isBusy = panelState === "streaming" || panelState === "loading" || panelState === "asking";
    DEPTH_OPTIONS.forEach((option) => {
      const button = createElement("button", `zzz-depth-option${option.value === explainDepth ? " is-active" : ""}`, option.label);
      button.type = "button";
      button.disabled = isBusy;
      button.setAttribute("aria-pressed", String(option.value === explainDepth));
      button.addEventListener("mousedown", stopPluginMouseEvent);
      button.addEventListener("click", (event) => {
        stopPluginMouseEvent(event);
        if (explainDepth === option.value) return;
        explainDepth = option.value;
        if (activeText && panelState !== "streaming" && panelState !== "loading") {
          explainText(activeText);
          return;
        }
        renderPanel({ state: panelState || "empty", activeText, result: getCurrentResult(), messages: [] });
      });
      control.append(button);
    });
    return control;
  }

  function createCopyButton(result) {
    const button = createElement("button", "zzz-copy-button", "复制");
    button.type = "button";
    button.title = "复制总览和白话解释";
    button.addEventListener("mousedown", stopPluginMouseEvent);
    button.addEventListener("click", async (event) => {
      stopPluginMouseEvent(event);
      const text = buildCopyText(result);
      try {
        await copyText(text);
        button.textContent = "已复制";
      } catch (_error) {
        button.textContent = "复制失败";
      }
      window.setTimeout(() => {
        button.textContent = "复制";
      }, 1200);
    });
    return button;
  }

  function buildCopyText(result) {
    return [
      result.mainPoint ? `这段话主要想说明的是：${result.mainPoint}` : "",
      result.plainTextExplanation ? `白话解释：${result.plainTextExplanation}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.documentElement.append(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("复制失败");
    }
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function normalizeSelectedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 5000);
  }

  function shouldAutoExplainSelection() {
    return panelState === "closed" || panelState === "empty" || panelState === "selected" || panelState === "error";
  }

  function scheduleAutoExplain(text) {
    window.clearTimeout(autoExplainTimer);
    autoExplainTimer = window.setTimeout(() => {
      if (pendingSelectionText === text && shouldAutoExplainSelection()) {
        hideChip();
        explainText(text);
      }
    }, 260);
  }

  function updateStreamingText(text) {
    const output = document.querySelector(`#${PANEL_ID} .zzz-streaming-text`);
    if (output) {
      output.textContent = text || "正在连接模型...";
    }
  }

  function startStreamRequest(payload) {
    activeStreamRequestId = payload.requestId;
    streamEventOffset = 0;
    streamStartedAt = Date.now();
    streamDebug = `request=${payload.requestId}; port=opening`;
    resetStreamStallTimer();

    try {
      const port = chrome.runtime.connect({ name: "ZZZ_EXPLAIN_STREAM" });
      streamPort = port;
      streamDebug += "; port=connected";

      port.onMessage.addListener((message) => handleStreamPortMessage(payload.requestId, port, message));
      port.onDisconnect.addListener(() => {
        if (streamPort === port) {
          streamPort = null;
        }

        if (payload.requestId !== activeRequestId || activeStreamRequestId !== payload.requestId || panelState !== "streaming") {
          return;
        }

        const reason = chrome.runtime.lastError?.message || "后台长连接已断开";
        streamDebug += `; portDisconnect=${reason}`;
        if (!streamBuffer) {
          activeStreamRequestId = 0;
          runNonStreamingFallback(payload.requestId, `流式长连接已断开：${reason}\n调试：${streamDebug}`);
        }
      });

      port.postMessage({ type: "ZZZ_EXPLAIN_STREAM_START", payload });
      streamDebug += "; start=posted";
    } catch (error) {
      streamDebug += `; portException=${error?.message || "unknown"}`;
      runNonStreamingFallback(payload.requestId, `流式长连接启动失败：${error?.message || "未知错误"}\n调试：${streamDebug}`);
    }
  }

  function beginStreamPolling(requestId) {
    window.clearTimeout(streamPollStartTimer);
    streamPollStartTimer = window.setTimeout(() => {
      if (requestId !== activeRequestId) return;
      streamDebug += "; poll=started";
      pollStreamSession(requestId);
      streamPollTimer = window.setInterval(() => pollStreamSession(requestId), 180);
    }, 60);
  }

  function closeActiveStream(disconnect = true) {
    stopStreamPolling();
    if (disconnect && activeStreamRequestId && streamPort) {
      try {
        streamPort.postMessage({ type: "ZZZ_EXPLAIN_STREAM_CANCEL", payload: { requestId: activeStreamRequestId } });
        streamPort.disconnect();
      } catch (_error) {
        // The port may already be gone if the background worker was reloaded.
      }
    }
    streamPort = null;
    activeStreamRequestId = 0;
  }

  function closeFollowUpStream(disconnect = true) {
    if (disconnect && followUpPort) {
      try {
        followUpPort.postMessage({ type: "ZZZ_FOLLOW_UP_STREAM_CANCEL" });
        followUpPort.disconnect();
      } catch (_error) {
        // The port may already be gone if the background worker was reloaded.
      }
    }
    followUpPort = null;
  }

  function handleStreamPortMessage(requestId, port, message) {
    if (requestId !== activeRequestId || activeStreamRequestId !== requestId || panelState !== "streaming") return;

    if (message?.type === "ZZZ_STREAM_ACK") {
      streamDebug += "; ack=ok";
      return;
    }

    if (message?.type === "ZZZ_STREAM_DELTA") {
      streamBuffer += message.delta || "";
      updateStreamingText(streamBuffer);
      resetStreamStallTimer();
      return;
    }

    if (message?.type === "ZZZ_STREAM_ERROR") {
      stopStreamPolling();
      activeStreamRequestId = 0;
      if (streamPort === port) {
        streamPort = null;
      }
      try {
        port.disconnect();
      } catch (_error) {}

      if (!streamBuffer) {
        streamDebug += `; streamError=${message.error || "unknown"}`;
        runNonStreamingFallback(requestId, `${message.error || "流式解释失败"}\n调试：${streamDebug}`);
        return;
      }

      const result = {
        mainPoint: "",
        plainTextExplanation: streamBuffer,
        keywords: [],
        suggestedQuestions: []
      };
      latestExplanation = streamBuffer;
      rememberRecentExplanation(activeText, result);
      renderPanel({ state: "ready", activeText, result, messages: [], warning: message.error || "流式连接已断开，已保留部分内容。" });
      return;
    }

    if (message?.type === "ZZZ_STREAM_DONE") {
      stopStreamPolling();
      activeStreamRequestId = 0;
      if (streamPort === port) {
        streamPort = null;
      }
      try {
        port.disconnect();
      } catch (_error) {}

      const result = message.result || {
        mainPoint: "",
        plainTextExplanation: streamBuffer,
        keywords: [],
        suggestedQuestions: []
      };
      latestExplanation = result.plainTextExplanation || streamBuffer;
      rememberRecentExplanation(activeText, result);
      renderPanel({ state: "ready", activeText, result, messages: [], warning: message.warning || "" });
    }
  }

  function resetStreamStallTimer() {
    window.clearTimeout(streamStallTimer);
    streamStallTimer = window.setTimeout(() => {
      if (panelState === "streaming" && !streamBuffer) {
        closeActiveStream();
        runNonStreamingFallback(activeRequestId, "流式模式 12 秒内没有收到内容");
      }
    }, 12000);
  }

  async function runNonStreamingFallback(requestId, reason) {
    if (requestId !== activeRequestId || fallbackInFlight) return;
    stopStreamPolling();
    fallbackInFlight = true;
    activeStreamRequestId = 0;
    lastStreamWarning = reason;
    updateStreamingText(`${reason}，正在切换到普通模式...`);

    try {
      const response = await sendRuntimeMessage({
        type: "ZZZ_EXPLAIN",
        payload: {
          selectedText: activeText,
          pageTitle: document.title,
          pageUrl: location.href,
          explainDepth
        }
      });

      if (requestId !== activeRequestId) return;

      if (!response?.ok) {
        renderPanel({
          state: "error",
          error: `${reason}\n普通模式也失败：${response?.error || "后台没有返回具体错误。"}`
        });
        return;
      }

      latestExplanation = response.result?.plainTextExplanation || "";
      activeStreamRequestId = 0;
      rememberRecentExplanation(activeText, response.result);
      renderPanel({ state: "ready", activeText, result: response.result, messages: [], warning: reason });
    } catch (error) {
      if (requestId === activeRequestId) {
        renderPanel({
          state: "error",
          error: `${reason}\n普通模式也失败：${error?.message || "未知错误"}`
        });
      }
    } finally {
      fallbackInFlight = false;
    }
  }

  async function pollStreamSession(requestId) {
    if (requestId !== activeRequestId || activeStreamRequestId !== requestId || panelState !== "streaming") return;

    try {
      const response = await sendRuntimeMessage({
        type: "ZZZ_EXPLAIN_STREAM_POLL",
        payload: {
          requestId,
          offset: streamEventOffset
        }
      });

      if (requestId !== activeRequestId) return;
      if (activeStreamRequestId !== requestId || panelState !== "streaming") return;

      if (!response?.ok) {
        if (Date.now() - streamStartedAt < 2500) {
          return;
        }
        if (!streamBuffer) {
          const pollError = response?.error || "后台没有响应";
          streamDebug += `; pollFail=${pollError}`;
          runNonStreamingFallback(requestId, `${pollError || "流式轮询失败"}\n调试：${streamDebug}`);
        }
        return;
      }

      streamEventOffset = response.nextOffset || streamEventOffset;
      if ((response.events || []).length) {
        streamDebug += `; events+=${response.events.length}`;
      }
      (response.events || []).forEach((event) => {
        if (event.type === "delta") {
          streamBuffer += event.delta || "";
          updateStreamingText(streamBuffer);
          resetStreamStallTimer();
        }
      });

      if (response.done) {
        stopStreamPolling();
        activeStreamRequestId = 0;
        if (response.error) {
          if (!streamBuffer) {
            streamDebug += `; doneError=${response.error}`;
            runNonStreamingFallback(requestId, `${response.error}\n调试：${streamDebug}`);
          } else {
            const result = response.result || {
              mainPoint: "",
              plainTextExplanation: streamBuffer,
              keywords: [],
              suggestedQuestions: []
            };
            latestExplanation = result.plainTextExplanation || streamBuffer;
            rememberRecentExplanation(activeText, result);
            renderPanel({ state: "ready", activeText, result, messages: [] });
          }
          return;
        }

        latestExplanation = response.result?.plainTextExplanation || streamBuffer;
        activeStreamRequestId = 0;
        rememberRecentExplanation(activeText, response.result);
        renderPanel({ state: "ready", activeText, result: response.result, messages: [] });
      }
    } catch (error) {
      if (requestId === activeRequestId && !streamBuffer) {
        streamDebug += `; pollException=${error?.message || "unknown"}`;
        runNonStreamingFallback(requestId, `流式轮询失败：${error?.message || "未知错误"}\n调试：${streamDebug}`);
      }
    }
  }

  function stopStreamPolling() {
    window.clearTimeout(streamPollStartTimer);
    window.clearInterval(streamPollTimer);
    window.clearTimeout(streamStallTimer);
    streamPollStartTimer = 0;
    streamPollTimer = 0;
  }

  function sendRuntimeMessage(message, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`chrome.runtime.sendMessage 超时：${message?.type || "unknown"}`));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);

          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || "chrome.runtime.sendMessage 失败"));
            return;
          }

          resolve(response);
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      }
    });
  }

  function stopPluginMouseEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function debounce(fn, wait) {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), wait);
    };
  }
})();
