const DEFAULT_OPTIONS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  temperature: 0.2,
  maxTokens: 700
};

const explainCache = new Map();
const MAX_CACHE_ITEMS = 80;
const streamSessions = new Map();
const STREAM_SESSION_TTL_MS = 2 * 60 * 1000;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await ensureContentScript(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: "ZZZ_ACTION_EXPLAIN" });
  } catch (_error) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "zzz-explain-selection",
      title: "用中译中解释",
      contexts: ["selection"]
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "zzz-explain-selection" || !tab?.id) return;
  ensureContentScript(tab.id)
    .then(() => {
      chrome.tabs.sendMessage(tab.id, {
        type: "ZZZ_CONTEXT_MENU_EXPLAIN",
        payload: {
          selectedText: info.selectionText || ""
        }
      });
    })
    .catch(() => {});
});

async function ensureContentScript(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ZZZ_EXPLAIN_STREAM_START") {
    try {
      startExplainStreamSession(message.payload);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: getUserFacingError(error) });
    }
    return false;
  }

  if (message?.type === "ZZZ_EXPLAIN_STREAM_POLL") {
    sendResponse(pollExplainStreamSession(message.payload));
    return false;
  }

  if (message?.type === "ZZZ_EXPLAIN_STREAM_CANCEL") {
    streamSessions.delete(message.payload?.requestId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "ZZZ_EXPLAIN") {
    handleExplain(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: getUserFacingError(error) }));
    return true;
  }

  if (message?.type === "ZZZ_FOLLOW_UP") {
    handleFollowUp(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: getUserFacingError(error) }));
    return true;
  }

  if (message?.type === "ZZZ_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ZZZ_EXPLAIN_STREAM" && port.name !== "ZZZ_FOLLOW_UP_STREAM") return;

  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });

  port.onMessage.addListener((message) => {
    if (port.name === "ZZZ_FOLLOW_UP_STREAM") {
      if (message?.type === "ZZZ_FOLLOW_UP_STREAM_CANCEL") {
        disconnected = true;
        try {
          port.disconnect();
        } catch (_error) {}
        return;
      }

      if (message?.type !== "ZZZ_FOLLOW_UP_STREAM_START") return;

      const postToPort = (payload) => {
        if (disconnected) return;
        try {
          port.postMessage(payload);
        } catch (_error) {
          disconnected = true;
        }
      };

      handleFollowUpStream(message.payload, postToPort).catch((error) => {
        postToPort({
          type: "ZZZ_FOLLOW_UP_ERROR",
          error: `追问流式请求失败：${getUserFacingError(error)}`
        });
      });
      return;
    }

    if (message?.type === "ZZZ_EXPLAIN_STREAM_CANCEL") {
      disconnected = true;
      try {
        port.disconnect();
      } catch (_error) {}
      return;
    }

    if (message?.type !== "ZZZ_EXPLAIN_STREAM_START") return;

    const postToPort = (payload) => {
      if (disconnected) return;
      try {
        port.postMessage(payload);
      } catch (_error) {
        disconnected = true;
      }
    };

    postToPort({ type: "ZZZ_STREAM_ACK", requestId: message.payload?.requestId });
    handleExplainStream(message.payload, { postMessage: postToPort }).catch((error) => {
      postToPort({
        type: "ZZZ_STREAM_ERROR",
        requestId: message.payload?.requestId,
        error: `后台流式请求失败：${getUserFacingError(error)}`
      });
    });
  });
});

function startExplainStreamSession(payload) {
  cleanupStreamSessions();

  const requestId = payload?.requestId;
  if (!requestId) {
    throw new Error("缺少流式输出目标。");
  }

  const session = {
    events: [],
    done: false,
    error: "",
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  streamSessions.set(requestId, session);

  handleExplainStream(payload, {
    postMessage(message) {
      session.updatedAt = Date.now();
      if (message.type === "ZZZ_STREAM_DELTA") {
        session.events.push({ type: "delta", delta: message.delta || "" });
      }
      if (message.type === "ZZZ_STREAM_DONE") {
        session.done = true;
        session.result = message.result;
        session.cached = Boolean(message.cached);
        session.warning = message.warning || "";
      }
      if (message.type === "ZZZ_STREAM_ERROR") {
        session.done = true;
        session.error = message.error || "流式解释失败。";
      }
    }
  })
    .then(() => {
    session.done = true;
    session.updatedAt = Date.now();
    })
    .catch((error) => {
    session.done = true;
    session.updatedAt = Date.now();
    session.error = `后台流式启动/请求失败：${getUserFacingError(error)}`;
    });

  return { ok: true };
}

function pollExplainStreamSession(payload) {
  const requestId = payload?.requestId;
  const offset = Number(payload?.offset || 0);
  const session = streamSessions.get(requestId);

  if (!session) {
    return {
      ok: false,
      error: `找不到当前流式会话 request=${requestId}，可能是扩展后台已重启或会话被取消。`
    };
  }

  session.updatedAt = Date.now();
  return {
    ok: true,
    events: session.events.slice(offset),
    nextOffset: session.events.length,
    done: session.done,
    error: session.error,
    result: session.result,
    warning: session.warning || ""
  };
}

function cleanupStreamSessions() {
  const now = Date.now();
  for (const [requestId, session] of streamSessions.entries()) {
    if (now - session.updatedAt > STREAM_SESSION_TTL_MS) {
      streamSessions.delete(requestId);
    }
  }
}

async function handleExplainStream(payload, streamTarget) {
  const options = await getOptions();
  ensureConfigured(options);

  const requestId = payload?.requestId;
  const selectedText = normalizeText(payload?.selectedText);
  const pageTitle = normalizeText(payload?.pageTitle);
  const pageUrl = normalizeText(payload?.pageUrl);
  const depthSpec = getDepthSpec(payload?.explainDepth);

  if (!requestId) {
    throw new Error("缺少流式输出目标。");
  }

  if (!selectedText) {
    throw new Error("请先选中一段需要解释的中文。");
  }

  const cacheKey = buildCacheKey(options, selectedText, depthSpec.value);
  if (explainCache.has(cacheKey)) {
    streamTarget.postMessage({
      type: "ZZZ_STREAM_DONE",
      requestId,
      result: explainCache.get(cacheKey),
      cached: true
    });
    return;
  }

  const messages = buildStreamExplainMessages(selectedText, pageTitle, pageUrl, depthSpec);
  let fullContent = "";

  try {
    fullContent = await requestChatCompletionStream(options, messages, (delta) => {
      streamTarget.postMessage({
        type: "ZZZ_STREAM_DELTA",
        requestId,
        delta
      });
    });
  } catch (error) {
    if (normalizeText(fullContent)) {
      const partialResult = parseStreamExplainResult(fullContent);
      rememberCache(cacheKey, partialResult);
      streamTarget.postMessage({
        type: "ZZZ_STREAM_DONE",
        requestId,
        result: partialResult,
        warning: `流式连接中断，已保留部分结果：${getUserFacingError(error)}`
      });
      return;
    }

    if (!shouldFallbackToNonStreaming(error)) {
      throw error;
    }

    fullContent = await requestChatCompletion(options, messages, { json: false });
    streamTarget.postMessage({
      type: "ZZZ_STREAM_DELTA",
      requestId,
      delta: fullContent
    });
  }

  if (!normalizeText(fullContent)) {
    fullContent = await requestChatCompletion(options, messages, { json: false });
    streamTarget.postMessage({
      type: "ZZZ_STREAM_DELTA",
      requestId,
      delta: fullContent
    });
  }

  const result = parseStreamExplainResult(fullContent);
  rememberCache(cacheKey, result);
  streamTarget.postMessage({
    type: "ZZZ_STREAM_DONE",
    requestId,
    result
  });
}

async function handleExplain(payload) {
  const options = await getOptions();
  ensureConfigured(options);

  const selectedText = normalizeText(payload?.selectedText);
  const pageTitle = normalizeText(payload?.pageTitle);
  const pageUrl = normalizeText(payload?.pageUrl);
  const depthSpec = getDepthSpec(payload?.explainDepth);

  if (!selectedText) {
    throw new Error("请先选中一段需要解释的中文。");
  }

  const cacheKey = buildCacheKey(options, selectedText, depthSpec.value);
  if (explainCache.has(cacheKey)) {
    return explainCache.get(cacheKey);
  }

  const messages = [
    {
      role: "system",
      content:
        "你是“中译中”中文深阅读助手。把晦涩中文解释成现代普通读者能读懂的中文。只输出紧凑 JSON，不要 Markdown。字段：mainPoint 字符串，用一句话概括这段话主要想说明什么，35 字以内；plainTextExplanation 字符串；keywords 数组，每项包含 term 和 explanation；suggestedQuestions 数组。不要编造出处。"
    },
    {
      role: "user",
      content: [
        "请解释这段中文。",
        pageTitle ? `网页标题：${pageTitle}` : "",
        pageUrl ? `网页地址：${pageUrl}` : "",
        `原文：${selectedText}`,
        `解释深浅：${depthSpec.label}。${depthSpec.instruction}`,
        `要求：先用 mainPoint 给总视角；白话解释控制在 ${depthSpec.lengthRange}；关键词选 3 到 5 个；每个关键词解释不超过 60 字；建议追问给 2 到 3 个。`
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];

  const content = await requestChatCompletion(options, messages, { json: true });
  const result = parseExplainResult(content);
  rememberCache(cacheKey, result);
  return result;
}

function buildStreamExplainMessages(selectedText, pageTitle, pageUrl, depthSpec = getDepthSpec()) {
  return [
    {
      role: "system",
      content:
        "你是“中译中”中文深阅读助手。把晦涩中文解释成现代普通读者能读懂的中文。直接输出内容，不要 Markdown 代码块，不要编造出处。必须先输出一句总览，再按三个标题输出：白话解释、关键词、继续追问。第一行必须是：这段话主要想说明的是：xxx。"
    },
    {
      role: "user",
      content: [
        "请解释这段中文。",
        pageTitle ? `网页标题：${pageTitle}` : "",
        pageUrl ? `网页地址：${pageUrl}` : "",
        `原文：${selectedText}`,
        `解释深浅：${depthSpec.label}。${depthSpec.instruction}`,
        "格式：",
        "这段话主要想说明的是：用 35 字以内概括核心意思。",
        "白话解释",
        `用 ${depthSpec.lengthRange} 自然解释。`,
        "关键词",
        "列 3 到 5 条，格式为：词语：解释。每条不超过 60 字。",
        "继续追问",
        "列 2 到 3 个可继续追问的问题。"
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];
}

async function handleFollowUp(payload) {
  const options = await getOptions();
  ensureConfigured(options);

  const messages = buildFollowUpMessages(payload);
  return {
    answer: await requestChatCompletion(options, messages, { json: false, maxTokens: Math.min(Number(options.maxTokens) || DEFAULT_OPTIONS.maxTokens, 500) })
  };
}

async function handleFollowUpStream(payload, postToPort) {
  const options = await getOptions();
  ensureConfigured(options);

  const messages = buildFollowUpMessages(payload);
  let fullContent = "";
  try {
    fullContent = await requestChatCompletionStream(
      options,
      messages,
      (delta) => {
        fullContent += delta || "";
        postToPort({ type: "ZZZ_FOLLOW_UP_DELTA", delta });
      },
      { maxTokens: Math.min(Number(options.maxTokens) || DEFAULT_OPTIONS.maxTokens, 500) }
    );
  } catch (error) {
    if (normalizeText(fullContent)) {
      postToPort({ type: "ZZZ_FOLLOW_UP_DONE", answer: fullContent, warning: `追问连接中断，已保留部分回答：${getUserFacingError(error)}` });
      return;
    }

    if (!shouldFallbackToNonStreaming(error)) {
      throw error;
    }

    fullContent = await requestChatCompletion(options, messages, { json: false, maxTokens: Math.min(Number(options.maxTokens) || DEFAULT_OPTIONS.maxTokens, 500) });
    postToPort({ type: "ZZZ_FOLLOW_UP_DELTA", delta: fullContent });
  }

  postToPort({ type: "ZZZ_FOLLOW_UP_DONE", answer: fullContent });
}

function buildFollowUpMessages(payload) {
  const selectedText = normalizeText(payload?.selectedText);
  const previousAnswer = normalizeText(payload?.previousAnswer);
  const question = normalizeText(payload?.question);

  if (!selectedText || !question) {
    throw new Error("缺少原文或追问内容。");
  }

  return [
    {
      role: "system",
      content:
        "你是“中译中”中文深阅读助手。围绕用户选中的原文继续解释。回答要短、清楚、口语化，但保留必要的概念精度。不要编造出处。"
    },
    {
      role: "user",
      content: [
        `原文：${selectedText}`,
        previousAnswer ? `上一轮解释摘要：${previousAnswer}` : "",
        `追问：${question}`
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];
}

async function getOptions() {
  const stored = await chrome.storage.local.get(DEFAULT_OPTIONS);
  return {
    ...DEFAULT_OPTIONS,
    ...stored,
    baseUrl: trimTrailingSlash(stored.baseUrl || DEFAULT_OPTIONS.baseUrl)
  };
}

function ensureConfigured(options) {
  if (!options.apiKey) {
    throw new Error("还没有配置大语言模型 API Key。请在扩展详情页打开“扩展程序选项”，或点击面板里的“S”设置按钮完成设置。");
  }
}

async function requestChatCompletion(options, messages, requestOptions = {}) {
  const body = {
    model: options.model,
    messages,
    temperature: Number(options.temperature) || DEFAULT_OPTIONS.temperature,
    max_tokens: Number(requestOptions.maxTokens || options.maxTokens) || DEFAULT_OPTIONS.maxTokens
  };

  if (requestOptions.json) {
    body.response_format = { type: "json_object" };
  }

  const url = `${trimTrailingSlash(options.baseUrl)}/chat/completions`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`网络请求失败：无法连接到 ${url}。${error?.message || ""}`.trim());
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = extractApiError(payload, response);
    if (requestOptions.json && response.status < 500 && /response_format|json/i.test(detail)) {
      return requestChatCompletion(options, messages, { ...requestOptions, json: false });
    }
    throw new Error(`模型请求失败（HTTP ${response.status}）：${detail}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`模型没有返回可用内容。响应结构：${safeStringify(payload).slice(0, 300)}`);
  }

  return content.trim();
}

async function requestChatCompletionStream(options, messages, onDelta, requestOptions = {}) {
  const url = `${trimTrailingSlash(options.baseUrl)}/chat/completions`;
  let response;
  try {
    response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.model,
      messages,
      temperature: Number(options.temperature) || DEFAULT_OPTIONS.temperature,
      max_tokens: Number(requestOptions.maxTokens || options.maxTokens) || DEFAULT_OPTIONS.maxTokens,
      stream: true
    })
    });
  } catch (error) {
    throw new Error(`流式网络请求失败：无法连接到 ${url}。${error?.message || ""}`.trim());
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = extractApiError(payload, response);
    throw new Error(`流式模型请求失败（HTTP ${response.status}）：${detail}`);
  }

  if (!response.body) {
    throw new Error("当前接口没有返回可流式读取的响应。");
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || "";
      if (content) {
      await onDelta(content);
      return content;
    }
    throw new Error(`模型没有返回可用内容。响应结构：${safeStringify(payload).slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        return fullContent;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch (_error) {
        continue;
      }
      const delta = parsed?.choices?.[0]?.delta?.content || "";
      if (!delta) continue;

      fullContent += delta;
      await onDelta(delta);
    }
  }

  return fullContent;
}

function parseExplainResult(content) {
  const parsed = parseJsonContent(content);
  if (!parsed) {
    return {
      plainTextExplanation: content,
      mainPoint: inferMainPoint(content),
      keywords: [],
      suggestedQuestions: ["这段话的核心意思是什么？", "有哪些关键词需要注意？"]
    };
  }

  return {
    mainPoint: normalizeText(parsed.mainPoint || parsed.summary || parsed.coreIdea || inferMainPoint(parsed.plainTextExplanation || parsed.explanation || content)),
    plainTextExplanation: normalizeText(parsed.plainTextExplanation || parsed.explanation),
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords
          .map((item) => ({
            term: normalizeText(item?.term),
            explanation: normalizeText(item?.explanation)
          }))
          .filter((item) => item.term && item.explanation)
      : [],
    suggestedQuestions: Array.isArray(parsed.suggestedQuestions)
      ? parsed.suggestedQuestions.map(normalizeText).filter(Boolean).slice(0, 4)
      : []
  };
}

function parseStreamExplainResult(content) {
  const text = String(content || "").trim();
  const mainPointMatch = text.match(/这段话主要想说明的是\s*[:：]\s*([^\n]+)/);
  const explanationMatch = text.match(/白话解释\s*([\s\S]*?)(?:\n\s*关键词|$)/);
  const keywordsMatch = text.match(/关键词\s*([\s\S]*?)(?:\n\s*继续追问|$)/);
  const questionsMatch = text.match(/继续追问\s*([\s\S]*)$/);

  const plainTextExplanation = normalizeText((explanationMatch?.[1] || text).replace(/^[:：]\s*/, ""));
  const keywords = parseLooseList(keywordsMatch?.[1] || "")
    .map((line) => {
      const cleaned = line.replace(/^[\-*\d.、\s]+/, "");
      const parts = cleaned.split(/[:：]/);
      return {
        term: normalizeText(parts.shift()),
        explanation: normalizeText(parts.join("："))
      };
    })
    .filter((item) => item.term && item.explanation)
    .slice(0, 6);
  const suggestedQuestions = parseLooseList(questionsMatch?.[1] || "").slice(0, 4);

  return {
    mainPoint: normalizeText(mainPointMatch?.[1] || inferMainPoint(plainTextExplanation)),
    plainTextExplanation,
    keywords,
    suggestedQuestions
  };
}

function parseLooseList(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => normalizeText(line.replace(/^[\-*\d.、\s]+/, "")))
    .filter(Boolean);
}

function inferMainPoint(content) {
  const text = normalizeText(content);
  if (!text) return "";
  const sentence = text.split(/[。！？!?；;]/).find(Boolean) || text;
  return sentence.slice(0, 35);
}

function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch (_error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_nestedError) {
      return null;
    }
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getDepthSpec(value = "standard") {
  const normalized = normalizeText(value) || "standard";
  if (normalized === "plain") {
    return {
      value: "plain",
      label: "更白话",
      lengthRange: "120 到 220 字",
      instruction: "尽量用日常口语解释，少用抽象词；遇到概念先打比方，再说明意思。"
    };
  }
  if (normalized === "deep") {
    return {
      value: "deep",
      label: "稍深入",
      lengthRange: "240 到 420 字",
      instruction: "在白话说明基础上补充概念关系、语境和细微差别，但不要堆砌术语。"
    };
  }
  return {
    value: "standard",
    label: "标准",
    lengthRange: "180 到 320 字",
    instruction: "用现代中文自然解释，兼顾易懂和必要的概念精度。"
  };
}

function buildCacheKey(options, selectedText, explainDepth = "standard") {
  return [options.baseUrl, options.model, explainDepth, selectedText].join("\n");
}

function rememberCache(cacheKey, result) {
  if (explainCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = explainCache.keys().next().value;
    explainCache.delete(oldestKey);
  }
  explainCache.set(cacheKey, result);
}

function shouldFallbackToNonStreaming(error) {
  const message = getUserFacingError(error);
  if (/401|403|unauthorized|forbidden|api key|apikey|认证|鉴权|余额|quota|insufficient/i.test(message)) {
    return false;
  }
  return true;
}

function extractApiError(payload, response) {
  return (
    payload?.error?.message ||
    payload?.error?.code ||
    payload?.message ||
    payload?.detail ||
    response.statusText ||
    safeStringify(payload).slice(0, 300) ||
    "未知错误"
  );
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function getUserFacingError(error) {
  return error?.message || "中译中暂时没有成功，请稍后再试。";
}
