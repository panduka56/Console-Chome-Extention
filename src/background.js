import {
  AI_PROVIDERS,
  PROVIDER_STORAGE_KEYS,
  buildFetchOptions,
  parseAiResponse,
} from './lib/ai-providers.js';

function trimToMaxChars(text, maxChars) {
  if (typeof text !== 'string') {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  const hiddenChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}

... [truncated ${hiddenChars} chars before sending to AI]`;
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
    '- Up to 4 bullets (most critical first).',
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
    styleInstruction || 'Keep output concise.',
    '',
    'Context:',
    JSON.stringify(context, null, 2),
    '',
    'Logs:',
    logsText,
  ].join('\n');
}

// --- Unified AI config helpers ---

async function getActiveProvider() {
  const stored = await chrome.storage.local.get([
    PROVIDER_STORAGE_KEYS.activeProvider,
  ]);
  const provider = stored[PROVIDER_STORAGE_KEYS.activeProvider];
  return typeof provider === 'string' && AI_PROVIDERS[provider]
    ? provider
    : 'deepseek';
}

async function getProviderConfig(provider) {
  const p = provider || (await getActiveProvider());
  const config = AI_PROVIDERS[p];
  if (!config) throw new Error(`Unknown provider: ${p}`);

  const keyField = PROVIDER_STORAGE_KEYS[`${p}_apiKey`];
  const modelField = PROVIDER_STORAGE_KEYS[`${p}_model`];
  const baseUrlField = PROVIDER_STORAGE_KEYS[`${p}_baseUrl`];

  const keys = [keyField, modelField, baseUrlField].filter(Boolean);
  const stored = await chrome.storage.local.get(keys);

  return {
    provider: p,
    apiKey: keyField ? (stored[keyField] || '') : '',
    model: modelField ? (stored[modelField] || config.defaultModel) : config.defaultModel,
    baseUrl: baseUrlField ? (stored[baseUrlField] || '') : '',
  };
}

async function saveProviderConfig({ provider, apiKey, model, baseUrl }) {
  const p = provider || (await getActiveProvider());
  const update = {};

  if (typeof apiKey === 'string') {
    const normalizedKey = apiKey.trim();
    if (!normalizedKey) throw new Error('API key is empty.');
    const keyField = PROVIDER_STORAGE_KEYS[`${p}_apiKey`];
    if (keyField) update[keyField] = normalizedKey;
  }

  if (typeof model === 'string' && model.trim()) {
    const modelField = PROVIDER_STORAGE_KEYS[`${p}_model`];
    if (modelField) update[modelField] = model.trim();
  }

  if (typeof baseUrl === 'string') {
    const baseUrlField = PROVIDER_STORAGE_KEYS[`${p}_baseUrl`];
    if (baseUrlField) update[baseUrlField] = baseUrl.trim();
  }

  if (Object.keys(update).length > 0) {
    await chrome.storage.local.set(update);
  }

  const config = await getProviderConfig(p);
  return {
    provider: p,
    hasApiKey: Boolean(config.apiKey),
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

async function setActiveProviderStorage(provider) {
  if (!AI_PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}`);
  await chrome.storage.local.set({
    [PROVIDER_STORAGE_KEYS.activeProvider]: provider,
  });
}

async function clearProviderKey(provider) {
  const p = provider || (await getActiveProvider());
  const keyField = PROVIDER_STORAGE_KEYS[`${p}_apiKey`];
  if (keyField) {
    await chrome.storage.local.remove(keyField);
  }
  const config = await getProviderConfig(p);
  return {
    provider: p,
    hasApiKey: Boolean(config.apiKey),
    model: config.model,
  };
}

// --- Unified AI call ---

async function callAiProvider({ provider, apiKey, model, baseUrl, logsText, context }) {
  const clippedLogs = trimToMaxChars(redactSensitiveText(logsText), 14000);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    logsText: clippedLogs,
    context,
    styleInstruction: context.styleInstruction,
  });

  const { endpoint, headers, body } = buildFetchOptions({
    provider,
    apiKey,
    model,
    systemPrompt,
    userPrompt,
    baseUrl,
  });

  const providerLabel = AI_PROVIDERS[provider]?.label || provider;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  if (!response.ok) {
    let errorReason = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(rawText);
      errorReason = parsed.error?.message || parsed.message || errorReason;
    } catch (error) {
      if (rawText) {
        errorReason = rawText.slice(0, 300);
      }
      throw new Error(`${providerLabel} request failed: ${errorReason}`, { cause: error });
    }
    throw new Error(`${providerLabel} request failed: ${errorReason}`);
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`${providerLabel} returned a non-JSON response.`, { cause: error });
  }

  const { summary, usage, model: respModel } = parseAiResponse(provider, parsedResponse);
  if (!summary || typeof summary !== 'string') {
    throw new Error(`${providerLabel} response did not contain summary text.`);
  }

  return {
    summary,
    usage: usage || null,
    model: respModel || model,
  };
}

// --- Message listener ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || typeof message.type !== 'string') {
        throw new Error('Invalid message.');
      }

      // --- Sitemap fetch ---
      if (message.type === 'FETCH_SITEMAP') {
        if (!message.url || typeof message.url !== 'string') {
          throw new Error('No URL provided for sitemap fetch.');
        }
        const sitemapResp = await fetch(message.url, {
          headers: { Accept: 'application/xml, text/xml, text/plain' },
        });
        if (!sitemapResp.ok) {
          throw new Error(
            `Sitemap fetch failed: ${sitemapResp.status} ${sitemapResp.statusText}`
          );
        }
        const xml = await sitemapResp.text();
        sendResponse({
          ok: true,
          xml,
          contentType: sitemapResp.headers.get('content-type') || '',
        });
        return;
      }

      // --- AI config: get (unified + legacy alias) ---
      if (message.type === 'AI_GET_CONFIG' || message.type === 'DEEPSEEK_GET_CONFIG') {
        const provider = message.provider || (await getActiveProvider());
        const config = await getProviderConfig(provider);
        sendResponse({
          ok: true,
          provider: config.provider,
          hasApiKey: Boolean(config.apiKey),
          model: config.model,
          baseUrl: config.baseUrl,
          activeProvider: await getActiveProvider(),
        });
        return;
      }

      // --- AI config: save (unified + legacy alias) ---
      if (message.type === 'AI_SAVE_CONFIG' || message.type === 'DEEPSEEK_SAVE_CONFIG') {
        const provider = message.provider || (await getActiveProvider());
        const saved = await saveProviderConfig({
          provider,
          apiKey: message.apiKey,
          model: message.model,
          baseUrl: message.baseUrl,
        });
        sendResponse({ ok: true, ...saved });
        return;
      }

      // --- AI config: clear key (unified + legacy alias) ---
      if (message.type === 'AI_CLEAR_KEY' || message.type === 'DEEPSEEK_CLEAR_KEY') {
        const provider = message.provider || (await getActiveProvider());
        const cleared = await clearProviderKey(provider);
        sendResponse({ ok: true, ...cleared });
        return;
      }

      // --- AI config: set active provider ---
      if (message.type === 'AI_SET_PROVIDER') {
        await setActiveProviderStorage(message.provider);
        const config = await getProviderConfig(message.provider);
        sendResponse({
          ok: true,
          provider: message.provider,
          hasApiKey: Boolean(config.apiKey),
          model: config.model,
          baseUrl: config.baseUrl,
        });
        return;
      }

      // --- AI summarize (unified + legacy alias) ---
      if (message.type === 'AI_SUMMARIZE' || message.type === 'DEEPSEEK_SUMMARIZE') {
        const provider = message.provider || (await getActiveProvider());
        const config = await getProviderConfig(provider);
        const apiKey = config.apiKey;
        const model =
          typeof message.model === 'string' && message.model.trim()
            ? message.model.trim()
            : config.model;

        if (AI_PROVIDERS[provider]?.authType !== 'none' && !apiKey) {
          throw new Error(`No API key saved for ${AI_PROVIDERS[provider]?.label || provider}.`);
        }
        if (!message.logsText || typeof message.logsText !== 'string') {
          throw new Error('No logs available for summarization.');
        }

        const summaryResult = await callAiProvider({
          provider,
          apiKey,
          model,
          baseUrl: config.baseUrl,
          logsText: message.logsText,
          context: {
            pageUrl: message.pageUrl || sender.tab?.url || '',
            levelPreset: message.levelPreset || 'full',
            format: message.format || 'ai',
            selectedCount: Number(message.selectedCount) || 0,
            uniqueCount: Number(message.uniqueCount) || 0,
            summaryStyle: message.summaryStyle || 'brief',
            styleInstruction:
              typeof message.styleInstruction === 'string'
                ? message.styleInstruction
                : '',
          },
        });

        sendResponse({
          ok: true,
          summary: summaryResult.summary,
          usage: summaryResult.usage,
          model: summaryResult.model,
        });
        return;
      }

      throw new Error(`Unknown message type: ${message.type}`);
    } catch (error) {
      sendResponse({
        ok: false,
        error:
          error instanceof Error ? error.message : 'Unknown background error',
      });
    }
  })();

  return true;
});
