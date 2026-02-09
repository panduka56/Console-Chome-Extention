(() => {
  const EVENT_NAME = '__CONSOLE_CAPTURE_EVENT__';
  const LOG_LIMIT = 5000;
  const CONTEXT_MAX_TEXT_CHARS = 4500;
  const CONTEXT_MAX_HEADINGS = 10;
  const CONTEXT_MAX_LINKS = 10;
  const CONTEXT_MAX_SECTIONS = 8;
  const CONTEXT_MAX_LOG_ENTRIES = 25;
  const CONTEXT_OUTPUT_MAX_CHARS = 7000;
  const CONTEXT_NOISE_SELECTORS = [
    'script',
    'style',
    'noscript',
    'svg',
    'canvas',
    'iframe',
    'template',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'input',
    'select',
    'option',
    'button',
    '[role="navigation"]',
    '[role="complementary"]',
    '[aria-label*="cookie" i]',
    '[id*="cookie" i]',
    '[class*="cookie" i]',
    '[id*="consent" i]',
    '[class*="consent" i]',
    '[id*="newsletter" i]',
    '[class*="newsletter" i]',
    '[id*="subscribe" i]',
    '[class*="subscribe" i]',
    '[data-testid*="cookie" i]',
    '[data-testid*="consent" i]',
  ];
  const logs = [];

  function injectPageLogger() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/page-logger.js');
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function stringifyArg(arg, options = {}) {
    const pretty = Boolean(options.pretty);

    if (arg === null || arg === undefined) {
      return String(arg);
    }
    if (
      typeof arg === 'string' ||
      typeof arg === 'number' ||
      typeof arg === 'boolean'
    ) {
      return String(arg);
    }
    try {
      return JSON.stringify(arg, null, pretty ? 2 : 0);
    } catch {
      return '[Unserializable value]';
    }
  }

  function formatWithPlaceholders(args) {
    if (!Array.isArray(args) || args.length === 0) {
      return '';
    }

    const first = args[0];
    if (typeof first !== 'string') {
      return '';
    }

    let argIndex = 1;
    const text = first.replace(/%%|%[sdifoOc]/g, (token) => {
      if (token === '%%') {
        return '%';
      }

      if (token === '%c') {
        argIndex += 1;
        return '';
      }

      const value = args[argIndex];
      argIndex += 1;

      if (value === undefined) {
        return token;
      }

      if (token === '%d' || token === '%i') {
        const nextValue = Number.parseInt(value, 10);
        return Number.isNaN(nextValue) ? 'NaN' : String(nextValue);
      }
      if (token === '%f') {
        const nextValue = Number(value);
        return Number.isNaN(nextValue) ? 'NaN' : String(nextValue);
      }
      return stringifyArg(value, { pretty: false });
    });

    const remaining = args
      .slice(argIndex)
      .map((arg) => stringifyArg(arg, { pretty: false }));
    return [text, ...remaining].filter(Boolean).join(' ').trim();
  }

  function formatArgsPlain(args) {
    return args
      .map((arg) => {
        if (typeof arg === 'string') {
          return arg;
        }
        return stringifyArg(arg, { pretty: true });
      })
      .join(' ');
  }

  function formatArgsCompact(args) {
    const formatted = formatWithPlaceholders(args);
    if (formatted) {
      return formatted;
    }
    return args.map((arg) => stringifyArg(arg, { pretty: false })).join(' ');
  }

  function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function compressStack(text, maxStackLines) {
    const lines = text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    if (lines.length <= 1) {
      return text;
    }

    const stackStart = lines.findIndex((line) =>
      line.trimStart().startsWith('at ')
    );
    if (stackStart === -1) {
      return lines.join(' | ');
    }

    const head = lines.slice(0, stackStart);
    const stack = lines.slice(stackStart);
    const keptStack = stack.slice(0, maxStackLines);
    const hiddenStackFrames = stack.length - keptStack.length;

    const compressed = head.concat(keptStack);
    if (hiddenStackFrames > 0) {
      compressed.push(`... +${hiddenStackFrames} stack frames`);
    }

    return compressed.join(' | ');
  }

  function truncateText(text, maxCharsPerEntry) {
    if (text.length <= maxCharsPerEntry) {
      return text;
    }
    const remaining = text.length - maxCharsPerEntry;
    return `${text.slice(0, maxCharsPerEntry)} ... [truncated ${remaining} chars]`;
  }

  function textFromNode(node) {
    if (!node) {
      return '';
    }
    return normalizeWhitespace(node.textContent || '');
  }

  function optimizeMessageForAi(message, options) {
    let text = message || '[empty log]';
    text = compressStack(text, options.maxStackLines);
    text = normalizeWhitespace(text);
    text = truncateText(text, options.maxCharsPerEntry);
    return text || '[empty log]';
  }

  function dedupeEntries(entries) {
    const byKey = new Map();
    const ordered = [];

    for (const entry of entries) {
      const key = `${entry.level}|${entry.source}|${entry.message}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastTimestamp = entry.timestamp;
        continue;
      }

      const nextEntry = {
        ...entry,
        count: 1,
        lastTimestamp: entry.timestamp,
      };
      byKey.set(key, nextEntry);
      ordered.push(nextEntry);
    }

    return ordered;
  }

  function summarizeLevelCounts(entries) {
    const levelCounts = {};
    for (const entry of entries) {
      const key = typeof entry.level === 'string' ? entry.level : 'log';
      levelCounts[key] = (levelCounts[key] || 0) + (entry.count || 1);
    }
    return levelCounts;
  }

  function includeByLevelPreset(level, levelPreset) {
    if (levelPreset === 'errors') {
      return level === 'error';
    }
    if (levelPreset === 'warnings') {
      return level === 'error' || level === 'warn';
    }
    return true;
  }

  function buildEntries(options) {
    const maxEntries = Number.isFinite(options.maxEntries)
      ? Math.min(LOG_LIMIT, Math.max(1, Math.floor(options.maxEntries)))
      : logs.length;

    const selectedLogs = logs.slice(Math.max(0, logs.length - maxEntries));
    const normalized = selectedLogs
      .map((entry) => {
        const level = typeof entry.level === 'string' ? entry.level : 'log';
        const source =
          typeof entry.source === 'string' ? entry.source : 'console';
        if (!includeByLevelPreset(level, options.levelPreset)) {
          return null;
        }

        const baseMessage =
          options.format === 'plain'
            ? formatArgsPlain(entry.args || [])
            : formatArgsCompact(entry.args || []);

        const message = options.optimizeForAi
          ? optimizeMessageForAi(baseMessage, options)
          : baseMessage || '[empty log]';

        return {
          timestamp: entry.timestamp || new Date().toISOString(),
          level,
          source,
          message,
        };
      })
      .filter(Boolean);

    const dedupe = options.optimizeForAi || options.format === 'ai';
    const entries = dedupe
      ? dedupeEntries(normalized)
      : normalized.map((entry) => ({
          ...entry,
          count: 1,
          lastTimestamp: entry.timestamp,
        }));

    return {
      totalCaptured: logs.length,
      totalCount: normalized.length,
      uniqueCount: entries.length,
      entries,
      levelCounts: summarizeLevelCounts(entries),
    };
  }

  function escapeXml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  function toSingleLine(text) {
    return String(text).replaceAll('\n', '\\n');
  }

  function buildPlainReport(report) {
    if (report.totalCount === 0) {
      return [
        `URL: ${window.location.href}`,
        'Captured console logs: 0',
        '',
        'No console logs captured yet.',
      ].join('\n');
    }

    const header = [
      `URL: ${window.location.href}`,
      `Captured at: ${new Date().toISOString()}`,
      `Captured console logs: ${report.totalCount}`,
      `Unique after dedupe: ${report.uniqueCount}`,
      '',
    ];

    const lines = report.entries.map((entry, index) => {
      const source = entry.source ? ` [${entry.source}]` : '';
      const repeat = entry.count > 1 ? ` x${entry.count}` : '';
      return `${index + 1}. ${entry.timestamp} [${entry.level}]${source}${repeat} ${entry.message}`;
    });

    return header.concat(lines).join('\n');
  }

  function buildAiCompactReport(report) {
    const header = [
      'AI_LOGS_V1',
      `url=${window.location.href}`,
      `captured=${new Date().toISOString()}`,
      `preset=${report.levelPreset}`,
      `total=${report.totalCount}`,
      `unique=${report.uniqueCount}`,
      `levels=${JSON.stringify(report.levelCounts)}`,
    ];

    const lines = report.entries.map(
      (entry, index) =>
        `${index + 1}|${entry.timestamp}|${entry.level}|${entry.count}|${entry.source}|${toSingleLine(
          entry.message
        )}`
    );

    return header.concat(lines).join('\n');
  }

  function buildXmlReport(report) {
    const rows = report.entries
      .map((entry, index) => {
        return `<e i="${index + 1}" t="${escapeXml(entry.timestamp)}" l="${escapeXml(
          entry.level
        )}" s="${escapeXml(entry.source)}" c="${entry.count}">${escapeXml(entry.message)}</e>`;
      })
      .join('\n');

    return `<logs url="${escapeXml(window.location.href)}" captured="${escapeXml(
      new Date().toISOString()
    )}" preset="${escapeXml(report.levelPreset)}" total="${report.totalCount}" unique="${
      report.uniqueCount
    }">
${rows}
</logs>`;
  }

  function getMetaContent(selector) {
    const value = document.querySelector(selector)?.getAttribute('content');
    if (typeof value !== 'string') {
      return '';
    }
    return normalizeWhitespace(value);
  }

  function collectHeadings() {
    const headings = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('h1, h2, h3');
    for (const node of nodes) {
      const text = textFromNode(node);
      if (!text) {
        continue;
      }
      if (seen.has(text)) {
        continue;
      }
      seen.add(text);
      headings.push({
        level: node.tagName.toLowerCase(),
        text: truncateText(text, 240),
      });
      if (headings.length >= CONTEXT_MAX_HEADINGS) {
        break;
      }
    }
    return headings;
  }

  function collectKeyLinks() {
    const links = [];
    const seen = new Set();
    const allLinks = document.querySelectorAll('a[href]');
    for (const node of allLinks) {
      const href = node.href;
      if (
        !href ||
        href.startsWith('javascript:') ||
        href.endsWith('#') ||
        href.startsWith(`${window.location.href}#`)
      ) {
        continue;
      }
      const label =
        textFromNode(node) ||
        normalizeWhitespace(node.getAttribute('aria-label') || '') ||
        normalizeWhitespace(node.getAttribute('title') || '');
      const cleanedLabel = truncateText(label, 140);
      if (!cleanedLabel) {
        continue;
      }
      const key = href;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      links.push({
        text: cleanedLabel,
        href: truncateText(href, 240),
        external: !href.startsWith(window.location.origin),
      });
      if (links.length >= CONTEXT_MAX_LINKS) {
        break;
      }
    }
    return links;
  }

  function pickContentRoot() {
    const candidates = [
      ['main', document.querySelector('main')],
      ['article', document.querySelector('article')],
      ['[role="main"]', document.querySelector('[role="main"]')],
      ['#main', document.querySelector('#main')],
      ['.main', document.querySelector('.main')],
      ['#content', document.querySelector('#content')],
      ['.content', document.querySelector('.content')],
      ['body', document.body],
      ['documentElement', document.documentElement],
    ];

    for (const [selector, node] of candidates) {
      if (!node) {
        continue;
      }
      if (textFromNode(node).length >= 240) {
        return {
          selector,
          node,
        };
      }
    }

    return {
      selector: 'documentElement',
      node: document.documentElement,
    };
  }

  function pruneContentRoot(node) {
    const clone = node.cloneNode(true);
    clone
      .querySelectorAll(CONTEXT_NOISE_SELECTORS.join(','))
      .forEach((noiseNode) => noiseNode.remove());
    clone
      .querySelectorAll('[hidden], [aria-hidden="true"]')
      .forEach((hiddenNode) => hiddenNode.remove());
    return clone;
  }

  function collectSectionSnippets(rootClone) {
    const snippets = [];
    const seen = new Set();
    const nodes = rootClone.querySelectorAll('h1, h2, h3, p, li, blockquote');
    for (const node of nodes) {
      const text = textFromNode(node);
      if (text.length < 45) {
        continue;
      }
      const dedupeKey = text.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      snippets.push(truncateText(text, 220));
      if (snippets.length >= CONTEXT_MAX_SECTIONS) {
        break;
      }
    }
    return snippets;
  }

  function buildDomStats() {
    const images = Array.from(document.images || []);
    const imagesWithoutAlt = images.filter((image) => {
      const alt = normalizeWhitespace(image.getAttribute('alt') || '');
      return !alt;
    });

    return {
      links: document.querySelectorAll('a[href]').length,
      headings: document.querySelectorAll('h1, h2, h3').length,
      paragraphs: document.querySelectorAll('p').length,
      lists: document.querySelectorAll('ul, ol').length,
      tables: document.querySelectorAll('table').length,
      forms: document.querySelectorAll('form').length,
      images: images.length,
      imagesWithoutAlt: imagesWithoutAlt.length,
    };
  }

  function buildTimingSnapshot() {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav) {
      return null;
    }
    return {
      type: nav.type || '',
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEventMs: Math.round(nav.loadEventEnd || 0),
      transferSize: Number(nav.transferSize) || 0,
      encodedBodySize: Number(nav.encodedBodySize) || 0,
    };
  }

  function extractPageContext() {
    const root = pickContentRoot();
    const rootClone = pruneContentRoot(root.node);
    const cleanedText = textFromNode(rootClone);
    const summaryText = truncateText(cleanedText, CONTEXT_MAX_TEXT_CHARS);
    const snippets = collectSectionSnippets(rootClone);
    const truncated = summaryText.length < cleanedText.length;

    return {
      page: {
        url: window.location.href,
        title: document.title || '',
        lang:
          document.documentElement?.getAttribute('lang') ||
          document.documentElement?.lang ||
          '',
        contentType: document.contentType || '',
        readyState: document.readyState || '',
        referrer: document.referrer || '',
        capturedAt: new Date().toISOString(),
        lastModified: document.lastModified || '',
      },
      meta: {
        description: truncateText(getMetaContent('meta[name="description"]'), 220),
        keywords: truncateText(getMetaContent('meta[name="keywords"]'), 220),
        canonical: truncateText(
          document.querySelector('link[rel="canonical"]')?.href || '',
          240
        ),
        ogTitle: truncateText(getMetaContent('meta[property="og:title"]'), 220),
        ogDescription: truncateText(
          getMetaContent('meta[property="og:description"]'),
          220
        ),
      },
      content: {
        rootSelector: root.selector,
        summaryText,
        snippets,
        headings: collectHeadings(),
        keyLinks: collectKeyLinks(),
        textCharsOriginal: cleanedText.length,
        textCharsIncluded: summaryText.length,
        textWasTruncated: truncated,
      },
      structure: {
        domStats: buildDomStats(),
        timing: buildTimingSnapshot(),
      },
    };
  }

  function buildContextMarkdown(pageContext, consoleReport) {
    const lines = [];
    lines.push('# AI Context');
    lines.push(`- URL: ${pageContext.page.url}`);
    lines.push(`- Title: ${pageContext.page.title || '[none]'}`);
    if (pageContext.meta.description) {
      lines.push(`- Description: ${pageContext.meta.description}`);
    }
    if (pageContext.meta.canonical) {
      lines.push(`- Canonical: ${pageContext.meta.canonical}`);
    }
    lines.push(`- Captured: ${pageContext.page.capturedAt}`);
    lines.push('');

    if (pageContext.content.headings.length > 0) {
      lines.push('## Page Headings');
      pageContext.content.headings.forEach((heading) => {
        lines.push(`- ${heading.level.toUpperCase()}: ${heading.text}`);
      });
      lines.push('');
    }

    lines.push('## Key Page Content');
    if (pageContext.content.snippets.length > 0) {
      pageContext.content.snippets.forEach((snippet) => {
        lines.push(`- ${snippet}`);
      });
    } else if (pageContext.content.summaryText) {
      lines.push(`- ${truncateText(pageContext.content.summaryText, 900)}`);
    } else {
      lines.push('- No meaningful page text detected.');
    }
    lines.push('');

    if (pageContext.content.keyLinks.length > 0) {
      lines.push('## Key Links');
      pageContext.content.keyLinks.forEach((link) => {
        const marker = link.external ? 'external' : 'internal';
        lines.push(`- [${marker}] ${link.text}: ${link.href}`);
      });
      lines.push('');
    }

    const consoleEntries = consoleReport.entries
      .slice(0, CONTEXT_MAX_LOG_ENTRIES)
      .map((entry, index) => ({
        index: index + 1,
        timestamp: entry.timestamp,
        level: entry.level,
        source: entry.source,
        count: entry.count,
        message: entry.message,
      }));
    lines.push('## Console Signals');
    if (consoleEntries.length === 0) {
      lines.push('- No console entries captured in current page session.');
    } else {
      lines.push(
        `- Captured ${consoleReport.totalCount} selected entries (${consoleReport.uniqueCount} unique).`
      );
      consoleEntries.forEach((entry) => {
        lines.push(
          `- [${entry.level}] ${truncateText(entry.message, 220)}`
        );
      });
      if (consoleReport.entries.length > consoleEntries.length) {
        lines.push(
          `- ... ${consoleReport.entries.length - consoleEntries.length} additional entries omitted`
        );
      }
    }

    lines.push('');
    lines.push('## Context Stats');
    lines.push(
      `- Text included: ${pageContext.content.textCharsIncluded}/${pageContext.content.textCharsOriginal} chars`
    );
    lines.push(`- DOM links: ${pageContext.structure.domStats.links}`);
    lines.push(`- DOM headings: ${pageContext.structure.domStats.headings}`);
    lines.push(`- DOM forms: ${pageContext.structure.domStats.forms}`);

    const raw = lines.join('\n').trim();
    if (raw.length <= CONTEXT_OUTPUT_MAX_CHARS) {
      return raw;
    }

    const hidden = raw.length - CONTEXT_OUTPUT_MAX_CHARS;
    return `${raw.slice(0, CONTEXT_OUTPUT_MAX_CHARS)}\n\n... [truncated ${hidden} chars for prompt efficiency]`;
  }

  function buildContextPayload(options) {
    const consoleReport = buildEntries({
      format: 'ai',
      levelPreset: options.levelPreset,
      optimizeForAi: true,
      maxEntries: options.maxEntries,
      maxCharsPerEntry: options.maxCharsPerEntry,
      maxStackLines: options.maxStackLines,
    });

    const pageContext = extractPageContext();
    const text = buildContextMarkdown(pageContext, consoleReport);

    return {
      text,
      pageUrl: pageContext.page.url,
      count: consoleReport.totalCount,
      uniqueCount: consoleReport.uniqueCount,
      totalCaptured: consoleReport.totalCaptured,
      estimatedTokens: estimateTokenCount(text),
    };
  }

  function estimateTokenCount(text) {
    return Math.ceil(text.length / 4);
  }

  function buildReportText(options) {
    const report = buildEntries(options);
    const reportWithPreset = {
      ...report,
      levelPreset: options.levelPreset,
    };
    const builder =
      options.format === 'xml'
        ? buildXmlReport
        : options.format === 'plain'
          ? buildPlainReport
          : buildAiCompactReport;

    const text = builder(reportWithPreset, options);
    return {
      ...reportWithPreset,
      text,
      estimatedTokens: estimateTokenCount(text),
    };
  }

  window.addEventListener(
    EVENT_NAME,
    (event) => {
      if (!event.detail) {
        return;
      }
      logs.push(event.detail);
      if (logs.length > LOG_LIMIT) {
        logs.shift();
      }
    },
    { passive: true }
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    const requestedLevelPreset =
      typeof message.levelPreset === 'string' ? message.levelPreset : 'full';
    const levelPreset = ['errors', 'warnings', 'full'].includes(
      requestedLevelPreset
    )
      ? requestedLevelPreset
      : 'full';
    const maxEntries = Number(message.maxEntries);
    const maxCharsPerEntry = Number(message.maxCharsPerEntry);
    const maxStackLines = Number(message.maxStackLines);
    const commonOptions = {
      levelPreset,
      maxEntries: Number.isFinite(maxEntries) ? maxEntries : logs.length,
      maxCharsPerEntry: Number.isFinite(maxCharsPerEntry)
        ? maxCharsPerEntry
        : 700,
      maxStackLines: Number.isFinite(maxStackLines) ? maxStackLines : 6,
    };

    if (message.type === 'GET_AI_CONTEXT') {
      const contextPayload = buildContextPayload(commonOptions);
      sendResponse({
        ok: true,
        format: 'ai-context-markdown',
        ...contextPayload,
      });
      return;
    }

    if (message.type !== 'GET_CAPTURED_CONSOLE') {
      return;
    }

    const requestedFormat =
      typeof message.format === 'string' ? message.format : 'ai';
    const format = ['ai', 'xml', 'plain'].includes(requestedFormat)
      ? requestedFormat
      : 'ai';

    const options = {
      format,
      ...commonOptions,
      optimizeForAi: message.optimizeForAi !== false,
    };

    const report = buildReportText(options);

    sendResponse({
      ok: true,
      totalCaptured: report.totalCaptured,
      count: report.totalCount,
      uniqueCount: report.uniqueCount,
      levelCounts: report.levelCounts,
      format,
      levelPreset,
      estimatedTokens: report.estimatedTokens,
      pageUrl: window.location.href,
      text: report.text,
    });
  });

  injectPageLogger();
})();
