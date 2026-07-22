const DEFAULT_OPTIONS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  temperature: 0.2,
  maxTokens: 700
};

const form = document.getElementById("options-form");
const statusEl = document.getElementById("status");

document.addEventListener("DOMContentLoaded", restoreOptions);
form.addEventListener("submit", saveOptions);
document.getElementById("reset").addEventListener("click", resetOptions);

async function restoreOptions() {
  const options = await chrome.storage.local.get(DEFAULT_OPTIONS);
  setFieldValues(options);
}

async function saveOptions(event) {
  event.preventDefault();
  const options = {
    apiKey: document.getElementById("apiKey").value.trim(),
    baseUrl: trimTrailingSlash(document.getElementById("baseUrl").value.trim()),
    model: document.getElementById("model").value.trim(),
    temperature: Number(document.getElementById("temperature").value || DEFAULT_OPTIONS.temperature),
    maxTokens: Number(document.getElementById("maxTokens").value || DEFAULT_OPTIONS.maxTokens)
  };

  if (!options.baseUrl || !options.model) {
    showStatus("Base URL 和模型不能为空。", true);
    return;
  }

  await chrome.storage.local.set(options);
  showStatus("已保存。");
}

async function resetOptions() {
  const current = await chrome.storage.local.get(DEFAULT_OPTIONS);
  const next = { ...DEFAULT_OPTIONS, apiKey: current.apiKey || "" };
  await chrome.storage.local.set(next);
  setFieldValues(next);
  showStatus("已恢复默认模型设置，API Key 已保留。");
}

function setFieldValues(options) {
  document.getElementById("apiKey").value = options.apiKey || "";
  document.getElementById("baseUrl").value = options.baseUrl || DEFAULT_OPTIONS.baseUrl;
  document.getElementById("model").value = options.model || DEFAULT_OPTIONS.model;
  document.getElementById("temperature").value = options.temperature ?? DEFAULT_OPTIONS.temperature;
  document.getElementById("maxTokens").value = options.maxTokens ?? DEFAULT_OPTIONS.maxTokens;
}

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#991b1b" : "#166534";
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    statusEl.textContent = "";
  }, 2600);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
