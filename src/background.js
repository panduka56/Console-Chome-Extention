const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const STORAGE_KEYS = {
  apiKey: 'deepseek_api_key',
  model: 'deepseek_model',
};
const DEFAULT_MODEL = 'deepseek-chat';

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

async function getConfigFromStorage() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
  ]);
  const apiKey =
    typeof stored[STORAGE_KEYS.apiKey] === 'string'
      ? stored[STORAGE_KEYS.apiKey]
      : '';
  const model =
    typeof stored[STORAGE_KEYS.model] === 'string'
      ? stored[STORAGE_KEYS.model]
      : DEFAULT_MODEL;
  return {
    apiKey,
    model,
  };
}

async function saveConfigToStorage({ apiKey, model }) {
  const update = {};

  if (typeof apiKey === 'string') {
    const normalizedKey = apiKey.trim();
    if (!normalizedKey) {
      throw new Error('API key is empty.');
    }
    update[STORAGE_KEYS.apiKey] = normalizedKey;
  }

  if (typeof model === 'string' && model.trim()) {
    update[STORAGE_KEYS.model] = model.trim();
  }

  if (Object.keys(update).length > 0) {
    await chrome.storage.local.set(update);
  }

  const config = await getConfigFromStorage();
  return {
    hasApiKey: Boolean(config.apiKey),
    model: config.model,
  };
}

async function clearApiKey() {
  await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
  const config = await getConfigFromStorage();
  return {
    hasApiKey: Boolean(config.apiKey),
    model: config.model,
  };
}

async function callDeepSeek({ model, apiKey, logsText, context }) {
  const clippedLogs = trimToMaxChars(redactSensitiveText(logsText), 14000);
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
          logsText: clippedLogs,
          context,
          styleInstruction: context.styleInstruction,
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
      throw new Error(`DeepSeek request failed: ${errorReason}`, { cause: error });
    }
    throw new Error(`DeepSeek request failed: ${errorReason}`);
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(rawText);
  } catch (error) {
    throw new Error('DeepSeek returned a non-JSON response.', { cause: error });
  }

  const summary = parsedResponse?.choices?.[0]?.message?.content;
  if (!summary || typeof summary !== 'string') {
    throw new Error('DeepSeek response did not contain summary text.');
  }

  return {
    summary,
    usage: parsedResponse.usage || null,
    model: parsedResponse.model || model,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || typeof message.type !== 'string') {
        throw new Error('Invalid message.');
      }

      if (message.type === 'DEEPSEEK_GET_CONFIG') {
        const config = await getConfigFromStorage();
        sendResponse({
          ok: true,
          hasApiKey: Boolean(config.apiKey),
          model: config.model,
        });
        return;
      }

      if (message.type === 'DEEPSEEK_SAVE_CONFIG') {
        const saved = await saveConfigToStorage({
          apiKey: message.apiKey,
          model: message.model,
        });
        sendResponse({
          ok: true,
          ...saved,
        });
        return;
      }

      if (message.type === 'DEEPSEEK_CLEAR_KEY') {
        const cleared = await clearApiKey();
        sendResponse({
          ok: true,
          ...cleared,
        });
        return;
      }

      if (message.type === 'DEEPSEEK_SUMMARIZE') {
        const config = await getConfigFromStorage();
        const apiKey = config.apiKey;
        const model =
          typeof message.model === 'string' && message.model.trim()
            ? message.model.trim()
            : config.model;

        if (!apiKey) {
          throw new Error('No DeepSeek API key saved.');
        }
        if (!message.logsText || typeof message.logsText !== 'string') {
          throw new Error('No logs available for summarization.');
        }

        const summaryResult = await callDeepSeek({
          model,
          apiKey,
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
