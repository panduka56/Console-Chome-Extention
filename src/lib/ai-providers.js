export const AI_PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    authType: 'bearer',
    responseParser: 'openai',
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini',
    authType: 'bearer',
    responseParser: 'openai',
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
    ],
    defaultModel: 'claude-sonnet-4-20250514',
    authType: 'anthropic',
    responseParser: 'anthropic',
  },
  ollama: {
    label: 'Ollama (Local)',
    endpoint: 'http://localhost:11434/api/chat',
    models: [],
    defaultModel: '',
    authType: 'none',
    responseParser: 'ollama',
  },
};

export const PROVIDER_STORAGE_KEYS = {
  activeProvider: 'ai_active_provider',
  deepseek_apiKey: 'deepseek_api_key',
  deepseek_model: 'deepseek_model',
  openai_apiKey: 'openai_api_key',
  openai_model: 'openai_model',
  anthropic_apiKey: 'anthropic_api_key',
  anthropic_model: 'anthropic_model',
  ollama_baseUrl: 'ollama_base_url',
  ollama_model: 'ollama_model',
};

export function buildFetchOptions({
  provider,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  baseUrl,
  temperature = 0.2,
  maxTokens = 900,
}) {
  const config = AI_PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const endpoint =
    provider === 'ollama' && baseUrl
      ? `${baseUrl.replace(/\/+$/, '')}/api/chat`
      : config.endpoint;

  const headers = { 'Content-Type': 'application/json' };
  if (config.authType === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (config.authType === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  let body;
  if (config.responseParser === 'anthropic') {
    body = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };
  } else if (config.responseParser === 'ollama') {
    body = {
      model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
  } else {
    body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  return { endpoint, headers, body };
}

export function parseAiResponse(provider, parsed) {
  const config = AI_PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  let summary;
  let usage;

  if (config.responseParser === 'anthropic') {
    summary = parsed?.content?.[0]?.text;
    usage = parsed.usage
      ? {
          total_tokens:
            (parsed.usage.input_tokens || 0) +
            (parsed.usage.output_tokens || 0),
        }
      : null;
  } else if (config.responseParser === 'ollama') {
    summary = parsed?.message?.content;
    usage = parsed.eval_count ? { total_tokens: parsed.eval_count } : null;
  } else {
    summary = parsed?.choices?.[0]?.message?.content;
    usage = parsed.usage || null;
  }

  return { summary, usage, model: parsed.model || '' };
}
