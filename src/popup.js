const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_STORAGE_KEYS = {
  apiKey: 'deepseek_api_key',
  model: 'deepseek_model',
};

const statusEl = document.getElementById('status');
const aiStatusEl = document.getElementById('aiStatus');
const previewTextEl = document.getElementById('previewText');
const summaryTextEl = document.getElementById('summaryText');
const contextTextEl = document.getElementById('contextText');
const contextAiTextEl = document.getElementById('contextAiText');

const copyButton = document.getElementById('copyButton');
const refreshButton = document.getElementById('refreshButton');
const summarizeButton = document.getElementById('summarizeButton');
const copySummaryButton = document.getElementById('copySummaryButton');
const saveKeyButton = document.getElementById('saveKeyButton');
const clearKeyButton = document.getElementById('clearKeyButton');
const extractContextButton = document.getElementById('extractContextButton');
const condenseContextButton = document.getElementById('condenseContextButton');
const copyContextButton = document.getElementById('copyContextButton');

const formatSelect = document.getElementById('formatSelect');
const optimizeToggle = document.getElementById('optimizeToggle');
const maxEntriesInput = document.getElementById('maxEntriesInput');
const maxCharsInput = document.getElementById('maxCharsInput');
const modelSelect = document.getElementById('modelSelect');
const summaryStyleSelect = document.getElementById('summaryStyleSelect');
const apiKeyInput = document.getElementById('apiKeyInput');

const activeFormatEl = document.getElementById('activeFormat');
const apiKeyStateEl = document.getElementById('apiKeyState');
const contextStatusEl = document.getElementById('contextStatus');

const statTotalEl = document.getElementById('statTotal');
const statSelectedEl = document.getElementById('statSelected');
const statUniqueEl = document.getElementById('statUnique');
const statTokensEl = document.getElementById('statTokens');
const levelPresetButtons = Array.from(
  document.querySelectorAll('[data-level-preset]')
);
const panelTabButtons = Array.from(document.querySelectorAll('[data-view]'));
const viewMap = {
  logs: document.getElementById('logsView'),
  ai: document.getElementById('aiView'),
  labs: document.getElementById('labsView'),
};

const SETTINGS_KEY = 'console-copy-helper-settings-v4';
const DEFAULT_SETTINGS = {
  activeView: 'logs',
  format: 'ai',
  levelPreset: 'warnings',
  optimizeForAi: true,
  maxEntries: 500,
  maxCharsPerEntry: 700,
  model: 'deepseek-chat',
  summaryStyle: 'brief',
};

let lastReport = null;
let lastSettingsHash = '';
let refreshCounter = 0;
let inputDebounceTimer = null;

let lastGeneratedSummary = '';
let lastGeneratedContext = '';
let lastCondensedContext = '';

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.classList.remove('success', 'error');
  if (type) {
    statusEl.classList.add(type);
  }
}

function setAiStatus(message, type = '') {
  aiStatusEl.textContent = message;
  aiStatusEl.classList.remove('success', 'error');
  if (type) {
    aiStatusEl.classList.add(type);
  }
}

function setContextStatus(message, type = '') {
  contextStatusEl.textContent = message;
  contextStatusEl.classList.remove('success', 'error');
  if (type) {
    contextStatusEl.classList.add(type);
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Timed out while waiting for response.')),
        ms
      );
    }),
  ]);
}

function parseIntInRange(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function getFormatLabel(format) {
  if (format === 'xml') {
    return 'XML compact';
  }
  if (format === 'plain') {
    return 'Plain text';
  }
  return 'AI compact';
}

function getLevelPresetLabel(levelPreset) {
  if (levelPreset === 'errors') {
    return 'Errors';
  }
  if (levelPreset === 'warnings') {
    return 'Medium';
  }
  return 'Full';
}

function setBusy(isBusy) {
  const busyElements = [copyButton, refreshButton, summarizeButton];
  busyElements.forEach((element) => {
    element.disabled = isBusy;
  });
  levelPresetButtons.forEach((button) => {
    button.disabled = isBusy;
  });
}

function setActiveLevelPreset(levelPreset) {
  levelPresetButtons.forEach((button) => {
    const isActive = button.dataset.levelPreset === levelPreset;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function getActiveLevelPreset() {
  const activeButton = levelPresetButtons.find((button) =>
    button.classList.contains('is-active')
  );
  return activeButton
    ? activeButton.dataset.levelPreset
    : DEFAULT_SETTINGS.levelPreset;
}

function setActiveView(viewName) {
  const nextView = viewMap[viewName] ? viewName : 'logs';
  panelTabButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === nextView);
  });
  Object.entries(viewMap).forEach(([name, element]) => {
    element.classList.toggle('is-active', name === nextView);
  });
}

function getActiveView() {
  const activeButton = panelTabButtons.find((button) =>
    button.classList.contains('is-active')
  );
  return activeButton ? activeButton.dataset.view : 'logs';
}

function readSettingsFromUi() {
  return {
    activeView: getActiveView(),
    format: formatSelect.value,
    levelPreset: getActiveLevelPreset(),
    optimizeForAi: optimizeToggle.checked,
    maxEntries: parseIntInRange(
      maxEntriesInput.value,
      50,
      5000,
      DEFAULT_SETTINGS.maxEntries
    ),
    maxCharsPerEntry: parseIntInRange(
      maxCharsInput.value,
      200,
      3000,
      DEFAULT_SETTINGS.maxCharsPerEntry
    ),
    model: modelSelect.value || DEFAULT_SETTINGS.model,
    summaryStyle: summaryStyleSelect.value || DEFAULT_SETTINGS.summaryStyle,
  };
}

function writeSettingsToUi(settings) {
  setActiveView(settings.activeView);
  formatSelect.value = settings.format;
  setActiveLevelPreset(settings.levelPreset);
  optimizeToggle.checked = settings.optimizeForAi;
  maxEntriesInput.value = String(settings.maxEntries);
  maxCharsInput.value = String(settings.maxCharsPerEntry);
  modelSelect.value = settings.model;
  summaryStyleSelect.value = settings.summaryStyle;
}

function normalizeSettings(parsed) {
  return {
    activeView:
      parsed &&
      typeof parsed.activeView === 'string' &&
      ['logs', 'ai', 'labs'].includes(parsed.activeView)
        ? parsed.activeView
        : DEFAULT_SETTINGS.activeView,
    format:
      parsed &&
      typeof parsed.format === 'string' &&
      ['ai', 'xml', 'plain'].includes(parsed.format)
        ? parsed.format
        : DEFAULT_SETTINGS.format,
    levelPreset:
      parsed &&
      typeof parsed.levelPreset === 'string' &&
      ['errors', 'warnings', 'full'].includes(parsed.levelPreset)
        ? parsed.levelPreset
        : DEFAULT_SETTINGS.levelPreset,
    optimizeForAi:
      parsed && typeof parsed.optimizeForAi === 'boolean'
        ? parsed.optimizeForAi
        : DEFAULT_SETTINGS.optimizeForAi,
    maxEntries: parseIntInRange(
      parsed && parsed.maxEntries,
      50,
      5000,
      DEFAULT_SETTINGS.maxEntries
    ),
    maxCharsPerEntry: parseIntInRange(
      parsed && parsed.maxCharsPerEntry,
      200,
      3000,
      DEFAULT_SETTINGS.maxCharsPerEntry
    ),
    model:
      parsed &&
      typeof parsed.model === 'string' &&
      ['deepseek-chat', 'deepseek-reasoner'].includes(parsed.model)
        ? parsed.model
        : DEFAULT_SETTINGS.model,
    summaryStyle:
      parsed &&
      typeof parsed.summaryStyle === 'string' &&
      ['brief', 'steps', 'rootcause'].includes(parsed.summaryStyle)
        ? parsed.summaryStyle
        : DEFAULT_SETTINGS.summaryStyle,
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      writeSettingsToUi(DEFAULT_SETTINGS);
      return;
    }
    writeSettingsToUi(normalizeSettings(JSON.parse(raw)));
  } catch {
    writeSettingsToUi(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  const settings = readSettingsFromUi();
  writeSettingsToUi(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  updateFormatBadge(settings);
}

function updateFormatBadge(settings) {
  activeFormatEl.textContent = `${getFormatLabel(settings.format)} • ${getLevelPresetLabel(
    settings.levelPreset
  )}`;
}

function settingsHash(settings) {
  return JSON.stringify(settings);
}

function renderStats(report) {
  const totalCaptured =
    typeof report.totalCaptured === 'number' ? report.totalCaptured : 0;
  const selected = typeof report.count === 'number' ? report.count : 0;
  const unique =
    typeof report.uniqueCount === 'number' ? report.uniqueCount : 0;
  const estimatedTokens =
    typeof report.estimatedTokens === 'number' ? report.estimatedTokens : 0;

  statTotalEl.textContent = String(totalCaptured);
  statSelectedEl.textContent = String(selected);
  statUniqueEl.textContent = String(unique);
  statTokensEl.textContent = String(estimatedTokens);
}

function renderPreview(text) {
  previewTextEl.textContent = text || 'No logs captured yet.';
}

function setApiKeyState(configured) {
  if (configured) {
    apiKeyStateEl.textContent = 'Key configured';
    apiKeyStateEl.classList.remove('stateWarn');
    apiKeyStateEl.classList.add('stateOk');
    apiKeyInput.placeholder = 'Saved. Paste a new key to replace.';
  } else {
    apiKeyStateEl.textContent = 'Key missing';
    apiKeyStateEl.classList.remove('stateOk');
    apiKeyStateEl.classList.add('stateWarn');
    apiKeyInput.placeholder = 'Paste DeepSeek API key';
  }
}

async function getDeepSeekLocalConfig() {
  const stored = await chrome.storage.local.get([
    DEEPSEEK_STORAGE_KEYS.apiKey,
    DEEPSEEK_STORAGE_KEYS.model,
  ]);
  const apiKey =
    typeof stored[DEEPSEEK_STORAGE_KEYS.apiKey] === 'string'
      ? stored[DEEPSEEK_STORAGE_KEYS.apiKey]
      : '';
  const model =
    typeof stored[DEEPSEEK_STORAGE_KEYS.model] === 'string'
      ? stored[DEEPSEEK_STORAGE_KEYS.model]
      : DEFAULT_SETTINGS.model;
  return { apiKey, model };
}

async function saveDeepSeekLocalConfig({ apiKey, model }) {
  const updates = {};
  if (typeof apiKey === 'string') {
    const nextKey = apiKey.trim();
    if (!nextKey) {
      throw new Error('API key is empty.');
    }
    updates[DEEPSEEK_STORAGE_KEYS.apiKey] = nextKey;
  }
  if (typeof model === 'string' && model.trim()) {
    updates[DEEPSEEK_STORAGE_KEYS.model] = model.trim();
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
  return getDeepSeekLocalConfig();
}

async function clearDeepSeekLocalKey() {
  await chrome.storage.local.remove(DEEPSEEK_STORAGE_KEYS.apiKey);
  return getDeepSeekLocalConfig();
}

async function loadDeepSeekConfig() {
  try {
    const config = await getDeepSeekLocalConfig();
    setApiKeyState(Boolean(config.apiKey));
    if (
      config.model &&
      ['deepseek-chat', 'deepseek-reasoner'].includes(config.model)
    ) {
      modelSelect.value = config.model;
      saveSettings();
    }
    setAiStatus('DeepSeek status: ready', 'success');
  } catch (error) {
    setApiKeyState(false);
    setAiStatus(`DeepSeek status: ${error.message}`, 'error');
  }
}

function isUnsupportedTabUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return true;
  }
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('view-source:')
  );
}

function isNoReceiverError(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes('receiving end does not exist') ||
    msg.includes('could not establish connection') ||
    msg.includes('the message port closed')
  );
}

function buildRequestPayload(settings) {
  return {
    type: 'GET_CAPTURED_CONSOLE',
    format: settings.format,
    levelPreset: settings.levelPreset,
    optimizeForAi: settings.optimizeForAi,
    maxEntries: settings.maxEntries,
    maxCharsPerEntry: settings.maxCharsPerEntry,
  };
}

function buildContextRequestPayload(settings) {
  return {
    type: 'GET_AI_CONTEXT',
    levelPreset: settings.levelPreset,
    maxEntries: settings.maxEntries,
    maxCharsPerEntry: settings.maxCharsPerEntry,
  };
}

async function sendReportRequest(tabId, settings) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, buildRequestPayload(settings)),
    5000
  );
  if (!response || !response.ok || typeof response.text !== 'string') {
    throw new Error('Could not fetch logs from this page.');
  }
  return response;
}

async function sendContextRequest(tabId, settings) {
  return withTimeout(
    chrome.tabs.sendMessage(tabId, buildContextRequestPayload(settings)),
    7000
  );
}

function isValidContextResponse(response) {
  return Boolean(response && response.ok && typeof response.text === 'string');
}

async function ensureContentScriptLoaded(tabId) {
  const manifest = chrome.runtime.getManifest();
  const contentScriptPath = manifest.content_scripts?.[0]?.js?.[0];
  const fallbackPath = 'src/content-script.js';

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      typeof contentScriptPath === 'string' && contentScriptPath
        ? contentScriptPath
        : fallbackPath,
    ],
  });
  await wait(120);
}

async function getActiveTabOrThrow() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab || typeof activeTab.id !== 'number') {
    throw new Error('No active tab found.');
  }
  if (isUnsupportedTabUrl(activeTab.url)) {
    throw new Error('This tab is restricted. Use a normal http/https page.');
  }
  return activeTab;
}

async function fetchReportFromActiveTab(settings) {
  const activeTab = await getActiveTabOrThrow();
  try {
    return await sendReportRequest(activeTab.id, settings);
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw error;
    }
    try {
      await ensureContentScriptLoaded(activeTab.id);
      return await sendReportRequest(activeTab.id, settings);
    } catch (injectError) {
      throw new Error(
        'Could not connect to this tab. Reload the tab once and try again.',
        { cause: injectError }
      );
    }
  }
}

async function fetchContextFromActiveTab(settings) {
  const activeTab = await getActiveTabOrThrow();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await sendContextRequest(activeTab.id, settings);
      if (isValidContextResponse(response)) {
        return response;
      }
      // Old content scripts can ignore new message types; force refresh once.
      await ensureContentScriptLoaded(activeTab.id);
      continue;
    } catch (error) {
      if (!isNoReceiverError(error)) {
        throw error;
      }
      try {
        await ensureContentScriptLoaded(activeTab.id);
      } catch (injectError) {
        throw new Error(
          'Could not connect to this tab. Reload the tab once and try again.',
          { cause: injectError }
        );
      }
    }
  }

  throw new Error(
    'Could not extract page context from this tab. Reload the page once and try again.'
  );
}

async function refreshPreview(options = {}) {
  const settings = readSettingsFromUi();
  const currentRefreshId = ++refreshCounter;
  const silent = Boolean(options.silent);

  if (!silent) {
    setStatus('Refreshing preview...');
  }
  setBusy(true);
  updateFormatBadge(settings);

  try {
    const response = await fetchReportFromActiveTab(settings);
    if (currentRefreshId !== refreshCounter) {
      return;
    }
    lastReport = response;
    lastSettingsHash = settingsHash(settings);
    renderStats(response);
    renderPreview(response.text);
    setStatus(
      `Preview ready: ${response.count} selected (${response.uniqueCount} unique, ~${response.estimatedTokens} tokens).`,
      'success'
    );
  } catch (error) {
    if (currentRefreshId !== refreshCounter) {
      return;
    }
    const message =
      error && error.message
        ? error.message
        : 'Preview failed. Open a normal webpage tab and refresh.';
    setStatus(message, 'error');
    renderStats({
      totalCaptured: 0,
      count: 0,
      uniqueCount: 0,
      estimatedTokens: 0,
    });
    renderPreview(`Preview unavailable.
Reason: ${message}`);
    lastReport = null;
  } finally {
    if (currentRefreshId === refreshCounter) {
      setBusy(false);
    }
  }
}

function scheduleRefreshPreview() {
  clearTimeout(inputDebounceTimer);
  inputDebounceTimer = setTimeout(() => {
    refreshPreview({ silent: true });
  }, 260);
}

async function copyPreview() {
  const settings = readSettingsFromUi();
  const changed = settingsHash(settings) !== lastSettingsHash;
  if (!lastReport || changed) {
    await refreshPreview({ silent: true });
  }
  if (!lastReport || typeof lastReport.text !== 'string') {
    setStatus('Nothing to copy yet.', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(lastReport.text);
    setStatus(
      `Copied ${lastReport.count} selected entries (~${lastReport.estimatedTokens} tokens).`,
      'success'
    );
  } catch (e) {
    setStatus(`Clipboard write failed: ${e.message}`, 'error');
  }
}

async function generatePageContext() {
  const settings = readSettingsFromUi();
  extractContextButton.disabled = true;
  setContextStatus('Extracting page context...');

  try {
    const response = await fetchContextFromActiveTab(settings);
    contextTextEl.textContent = response.text;
    lastGeneratedContext = response.text;
    contextAiTextEl.textContent = 'AI condensed context will appear here after generation.';
    lastCondensedContext = '';
    setContextStatus(
      `Context ready (~${response.estimatedTokens} tokens).`,
      'success'
    );
    return response.text;
  } catch (error) {
    setContextStatus(`Context extraction failed: ${error.message}`, 'error');
    return null;
  } finally {
    extractContextButton.disabled = false;
  }
}

function buildContextCondenseSystemPrompt() {
  return [
    'You are an expert technical summarizer.',
    'Condense page context into a high-signal brief for another AI coding assistant.',
    'Preserve critical facts, remove noise, and keep it concise.',
  ].join(' ');
}

function buildContextCondenseUserPrompt({ pageUrl, contextText }) {
  return [
    'Return exactly this structure:',
    '',
    '## TL;DR',
    '- One sentence summary.',
    '',
    '## Key Context',
    '- 4 to 8 bullets with important facts, entities, and numbers.',
    '',
    '## What To Ignore',
    '- Up to 4 bullets for irrelevant/noisy content.',
    '',
    '## Suggested Next Prompt',
    '```text',
    'One concise prompt another AI can use with this context.',
    '```',
    '',
    'Keep output below 220 words.',
    '',
    `Page URL: ${pageUrl || ''}`,
    '',
    'Source Context:',
    contextText,
  ].join('\n');
}

async function condenseContextViaDirectDeepSeek({
  apiKey,
  model,
  contextText,
  pageUrl,
}) {
  const payload = trimToMaxChars(redactSensitiveText(contextText), 12000);
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      {
        role: 'system',
        content: buildContextCondenseSystemPrompt(),
      },
      {
        role: 'user',
        content: buildContextCondenseUserPrompt({
          pageUrl,
          contextText: payload,
        }),
      },
    ],
  };

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    let reason = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(raw);
      reason = parsed.error?.message || parsed.message || reason;
    } catch {
      if (raw) {
        reason = raw.slice(0, 300);
      }
    }
    throw new Error(`DeepSeek request failed: ${reason}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('DeepSeek returned non-JSON response.', { cause: error });
  }

  const summary = parsed?.choices?.[0]?.message?.content;
  if (!summary || typeof summary !== 'string') {
    throw new Error('DeepSeek response missing summary.');
  }

  return {
    summary,
    usage: parsed.usage || null,
    model: parsed.model || model,
  };
}

async function condensePageContextWithAi() {
  const placeholder = 'AI context will appear here after generation.';
  let contextPayload = lastGeneratedContext.trim();
  const currentRawContext = (contextTextEl.textContent || '').trim();
  if (!contextPayload && currentRawContext && currentRawContext !== placeholder) {
    contextPayload = currentRawContext;
    lastGeneratedContext = currentRawContext;
  }

  if (!contextPayload) {
    setContextStatus('No context yet. Generating now...');
    const generated = await generatePageContext();
    if (!generated) {
      return;
    }
    contextPayload = generated.trim();
  }

  const config = await getDeepSeekLocalConfig();
  if (!config.apiKey) {
    setApiKeyState(false);
    setContextStatus('Save DeepSeek key in DeepSeek tab first.', 'error');
    return;
  }

  condenseContextButton.disabled = true;
  setContextStatus('Condensing context with AI...');

  try {
    const result = await condenseContextViaDirectDeepSeek({
      apiKey: config.apiKey,
      model: readSettingsFromUi().model,
      contextText: contextPayload,
      pageUrl: lastReport?.pageUrl || '',
    });
    contextAiTextEl.textContent = result.summary;
    lastCondensedContext = result.summary;
    const tokenInfo =
      result.usage && result.usage.total_tokens
        ? ` tokens: ${result.usage.total_tokens}`
        : '';
    setContextStatus(
      `AI context condensed (${result.model}${tokenInfo}).`,
      'success'
    );
  } catch (error) {
    setContextStatus(`AI context condense failed: ${error.message}`, 'error');
  } finally {
    condenseContextButton.disabled = false;
  }
}

async function copyPageContext() {
  const placeholder = 'AI context will appear here after generation.';
  const aiPlaceholder = 'AI condensed context will appear here after generation.';
  const current = (contextTextEl.textContent || '').trim();
  const currentAi = (contextAiTextEl.textContent || '').trim();
  let payload = lastCondensedContext.trim() || lastGeneratedContext.trim();

  if (!payload && currentAi && currentAi !== aiPlaceholder) {
    payload = currentAi;
    lastCondensedContext = currentAi;
  }

  if (!payload && current && current !== placeholder) {
    payload = current;
    lastGeneratedContext = current;
  }

  if (!payload) {
    setContextStatus('No context yet. Generating now...');
    const generated = await generatePageContext();
    if (!generated) {
      return;
    }
    payload = generated.trim();
  }

  try {
    await navigator.clipboard.writeText(payload);
    if (lastCondensedContext && payload === lastCondensedContext) {
      setContextStatus('AI-condensed context copied to clipboard.', 'success');
    } else {
      setContextStatus('Context copied to clipboard.', 'success');
    }
  } catch (error) {
    setContextStatus(`Copy failed: ${error.message}`, 'error');
  }
}

function getSummaryInstruction(style) {
  if (style === 'steps') {
    return 'Focus more on actionable step-by-step fix instructions.';
  }
  if (style === 'rootcause') {
    return 'Focus more on likely root causes and confidence ranking.';
  }
  return 'Keep output concise with balanced causes and fixes.';
}

function redactSensitiveText(input) {
  if (typeof input !== 'string') {
    return '';
  }
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
    .replace(
      /(password|token|secret)\s*[:=]\s*["']?[^"'\s]+/gi,
      '$1=[REDACTED]'
    );
}

function trimToMaxChars(text, maxChars) {
  if (typeof text !== 'string') {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  const hidden = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n... [truncated ${hidden} chars before sending to AI]`
}

function buildSystemPrompt() {
  return [
    'You are an expert debugging assistant for web apps.',
    'Transform browser console logs into a concise engineering brief for an AI developer.',
    'Prioritize real errors over noisy warnings.',
    'Separate deprecations/noise from actionable failures.',
    'Be concrete and concise.',
  ].join(' ');
}

function buildUserPrompt({ logsText, context, styleInstruction }) {
  return [
    'Create a concise response with this exact structure:',
    '',
    '## TL;DR',
    '- One sentence summary.',
    '',
    '## Primary Failures',
    '- Up to 4 bullets (critical first).',
    '',
    '## Likely Root Causes',
    '- Up to 4 bullets with confidence (high/med/low).',
    '',
    '## Fix Plan',
    '1. Short numbered steps.',
    '',
    '## Verify',
    '- Up to 4 checks.',
    '',
    '## AI_DEV_INPUT_JSON',
    '```json',
    '{',
    '  "suspect_area": "...",',
    '  "top_errors": ["..."],',
    '  "likely_causes": ["..."],',
    '  "next_actions": ["..."]',
    '}',
    '```',
    '',
    'Keep output below ~350 words.',
    styleInstruction || '',
    '',
    'Context:',
    JSON.stringify(context, null, 2),
    '',
    'Logs:',
    logsText,
  ].join('\n');
}

async function summarizeViaDirectDeepSeek({ apiKey, model, report, settings }) {
  const logsText = trimToMaxChars(redactSensitiveText(report.text), 14000);
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(),
      },
      {
        role: 'user',
        content: buildUserPrompt({
          logsText,
          styleInstruction: getSummaryInstruction(settings.summaryStyle),
          context: {
            pageUrl: report.pageUrl || '',
            levelPreset: settings.levelPreset,
            format: settings.format,
            selectedCount: Number(report.count) || 0,
            uniqueCount: Number(report.uniqueCount) || 0,
          },
        }),
      },
    ],
  };

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    let reason = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(raw);
      reason = parsed.error?.message || parsed.message || reason;
    } catch (error) {
      if (raw) {
        reason = raw.slice(0, 300);
      }
      throw new Error(`DeepSeek request failed: ${reason}`, { cause: error });
    }
    throw new Error(`DeepSeek request failed: ${reason}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('DeepSeek returned non-JSON response.', { cause: error });
  }

  const summary = parsed?.choices?.[0]?.message?.content;
  if (!summary || typeof summary !== 'string') {
    throw new Error('DeepSeek response missing summary.');
  }

  return {
    summary,
    usage: parsed.usage || null,
    model: parsed.model || model,
  };
}

async function sendBackgroundMessage(message) {
  return withTimeout(chrome.runtime.sendMessage(message), 20000);
}

function isBackgroundUnavailableError(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes('receiving end does not exist') ||
    msg.includes('could not establish connection') ||
    msg.includes('port closed')
  );
}

async function saveDeepSeekKey() {
  const input = apiKeyInput.value.trim();
  if (!input) {
    setAiStatus('Please paste an API key first.', 'error');
    return;
  }

  try {
    const settings = readSettingsFromUi();
    await saveDeepSeekLocalConfig({
      apiKey: input,
      model: settings.model,
    });
    setApiKeyState(true);
    apiKeyInput.value = '';
    setAiStatus('API key saved locally.', 'success');
  } catch (error) {
    setAiStatus(`Save failed: ${error.message}`, 'error');
  }
}

async function clearDeepSeekKey() {
  try {
    await clearDeepSeekLocalKey();
    setApiKeyState(false);
    setAiStatus('API key cleared.', 'success');
  } catch (error) {
    setAiStatus(`Clear failed: ${error.message}`, 'error');
  }
}

async function generateAiBrief() {
  const settings = readSettingsFromUi();
  const changed = settingsHash(settings) !== lastSettingsHash;
  if (!lastReport || changed) {
    await refreshPreview({ silent: true });
  }
  if (!lastReport || !lastReport.text) {
    setAiStatus('No logs available. Refresh preview first.', 'error');
    return;
  }

  const config = await getDeepSeekLocalConfig();
  if (!config.apiKey) {
    setApiKeyState(false);
    setAiStatus('Save DeepSeek key first.', 'error');
    return;
  }
  setApiKeyState(true);

  summarizeButton.disabled = true;
  setAiStatus('Generating AI brief...');

  try {
    let result = null;
    try {
      const backgroundResp = await sendBackgroundMessage({
        type: 'DEEPSEEK_SUMMARIZE',
        model: settings.model,
        logsText: lastReport.text,
        pageUrl: lastReport.pageUrl,
        levelPreset: settings.levelPreset,
        format: settings.format,
        selectedCount: lastReport.count,
        uniqueCount: lastReport.uniqueCount,
        summaryStyle: settings.summaryStyle,
        styleInstruction: getSummaryInstruction(settings.summaryStyle),
      });

      if (backgroundResp && backgroundResp.ok) {
        result = {
          summary: backgroundResp.summary,
          usage: backgroundResp.usage,
          model: backgroundResp.model || settings.model,
        };
      } else if (backgroundResp && backgroundResp.error) {
        throw new Error(backgroundResp.error);
      }
    } catch (bgError) {
      if (!isBackgroundUnavailableError(bgError)) {
        // Use fallback anyway to keep flow resilient.
      }
      result = await summarizeViaDirectDeepSeek({
        apiKey: config.apiKey,
        model: settings.model,
        report: lastReport,
        settings,
      });
    }

    if (!result) {
      result = await summarizeViaDirectDeepSeek({
        apiKey: config.apiKey,
        model: settings.model,
        report: lastReport,
        settings,
      });
    }

    summaryTextEl.textContent = result.summary;
    lastGeneratedSummary = result.summary;
    const tokenInfo =
      result.usage && result.usage.total_tokens
        ? ` tokens: ${result.usage.total_tokens}`
        : '';
    setAiStatus(`AI brief generated (${result.model}${tokenInfo}).`, 'success');
    return result.summary;
  } catch (error) {
    setAiStatus(`AI generation failed: ${error.message}`, 'error');
    return null;
  } finally {
    summarizeButton.disabled = false;
  }
}

async function copySummary() {
  const placeholderText = 'AI brief will appear here after generation.';
  const currentText = (summaryTextEl.textContent || '').trim();
  let textToCopy = lastGeneratedSummary.trim();

  if (!textToCopy && currentText && currentText !== placeholderText) {
    textToCopy = currentText;
    lastGeneratedSummary = currentText;
  }

  if (!textToCopy) {
    setAiStatus('No brief yet. Generating now...');
    const generated = await generateAiBrief();
    if (!generated) {
      return;
    }
    textToCopy = generated.trim();
  }

  try {
    await navigator.clipboard.writeText(textToCopy);
    setAiStatus('AI brief copied to clipboard.', 'success');
  } catch (error) {
    setAiStatus(`Copy failed: ${error.message}`, 'error');
  }
}

async function syncSelectedModelToStorage() {
  try {
    await saveDeepSeekLocalConfig({
      model: modelSelect.value,
    });
  } catch {
    // Ignore model sync errors.
  }
}

function bindEvents() {
  panelTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveView(button.dataset.view);
      saveSettings();
    });
  });

  levelPresetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveLevelPreset(button.dataset.levelPreset);
      saveSettings();
      refreshPreview({ silent: true });
    });
  });

  [formatSelect, optimizeToggle].forEach((element) => {
    element.addEventListener('change', () => {
      saveSettings();
      refreshPreview({ silent: true });
    });
  });

  [modelSelect, summaryStyleSelect].forEach((element) => {
    element.addEventListener('change', () => {
      saveSettings();
      if (element === modelSelect) {
        syncSelectedModelToStorage();
      }
    });
  });

  [maxEntriesInput, maxCharsInput].forEach((element) => {
    element.addEventListener('input', () => {
      saveSettings();
      scheduleRefreshPreview();
    });
    element.addEventListener('change', () => {
      saveSettings();
      refreshPreview({ silent: true });
    });
  });

  refreshButton.addEventListener('click', () => {
    refreshPreview();
  });
  copyButton.addEventListener('click', copyPreview);
  summarizeButton.addEventListener('click', generateAiBrief);
  copySummaryButton.addEventListener('click', copySummary);
  extractContextButton.addEventListener('click', generatePageContext);
  condenseContextButton.addEventListener('click', condensePageContextWithAi);
  copyContextButton.addEventListener('click', copyPageContext);
  saveKeyButton.addEventListener('click', saveDeepSeekKey);
  clearKeyButton.addEventListener('click', clearDeepSeekKey);
}

async function initialize() {
  loadSettings();
  saveSettings();
  bindEvents();
  setContextStatus('Context status: idle');
  contextAiTextEl.textContent = 'AI condensed context will appear here after generation.';
  await Promise.all([refreshPreview(), loadDeepSeekConfig()]);
}

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch((error) => {
    setStatus(`Initialization failed: ${error.message}`, 'error');
  });
});
