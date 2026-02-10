(() => {
  const EVENT_NAME = '__CONSOLE_CAPTURE_EVENT__';
  const LOG_LIMIT = 5000;
  const CONTEXT_MAX_TEXT_CHARS = 12000;
  const CONTEXT_FULL_TEXT_LIMIT = 26000;
  const CONTEXT_RELEVANT_LINES = 18;
  const CONTEXT_MAX_INTERACTIVES = 36;
  const CONTEXT_MAX_HEADINGS = 20;
  const CONTEXT_MAX_LINKS = 20;
  const CONTEXT_MAX_SECTIONS = 8;
  const CONTEXT_OUTPUT_MAX_CHARS = 10000;
  const CONTEXT_NOISE_SELECTORS = ['script', 'style', 'noscript', 'template'];
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

  function isElementVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function getInteractiveLabel(element) {
    return (
      textFromNode(element) ||
      normalizeWhitespace(element.getAttribute('aria-label') || '') ||
      normalizeWhitespace(element.getAttribute('title') || '') ||
      normalizeWhitespace(element.getAttribute('placeholder') || '') ||
      normalizeWhitespace(element.getAttribute('name') || '') ||
      normalizeWhitespace(element.id || '')
    );
  }

  function collectHeadings() {
    const headings = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('h1, h2, h3');
    for (const node of nodes) {
      if (!isElementVisible(node)) {
        continue;
      }
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
      if (!isElementVisible(node)) {
        continue;
      }
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
        getInteractiveLabel(node);
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

  function pruneFullPageDom() {
    const root = document.body || document.documentElement;
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll(CONTEXT_NOISE_SELECTORS.join(','))
      .forEach((noiseNode) => noiseNode.remove());
    clone
      .querySelectorAll('[hidden], [aria-hidden="true"]')
      .forEach((hiddenNode) => hiddenNode.remove());
    return clone;
  }

  function collectFullPageText() {
    const source =
      document.body?.innerText ||
      document.documentElement?.innerText ||
      '';
    const lines = source
      .split('\n')
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    const fullText = lines.join('\n');
    return {
      sourceChars: source.length,
      fullText,
      lines,
    };
  }

  function scoreRelevantLine(line, index) {
    const hasKeyword = /(error|warning|failed|failure|critical|issue|problem|bug|exception|fix|payment|checkout|login|auth|order|total|price|api|token|required|important)/i.test(
      line
    );
    const navNoise = /^(home|menu|search|about|contact|privacy|terms|cookies?)$/i.test(
      line
    );
    let score = 0;
    if (line.length >= 35 && line.length <= 220) {
      score += 2;
    } else if (line.length > 220) {
      score += 1;
    }
    if (hasKeyword) {
      score += 3;
    }
    if (/\d/.test(line)) {
      score += 1;
    }
    if (/[$£€%]/.test(line)) {
      score += 1;
    }
    if (index < 120) {
      score += 1;
    }
    if (navNoise) {
      score -= 3;
    }
    return score;
  }

  function collectRelevantLines(lines) {
    const ranked = lines
      .map((line, index) => ({ line, index, score: scoreRelevantLine(line, index) }))
      .filter((item) => item.line.length >= 25 && item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const picked = [];
    const seen = new Set();
    for (const item of ranked) {
      const key = item.line.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      picked.push(item.line);
      if (picked.length >= CONTEXT_RELEVANT_LINES) {
        break;
      }
    }

    if (picked.length === 0) {
      return lines.slice(0, CONTEXT_RELEVANT_LINES).map((line) => truncateText(line, 240));
    }

    return picked.map((line) => truncateText(line, 240));
  }

  function collectSectionSnippets(lines) {
    const snippets = [];
    const seen = new Set();
    for (const line of lines) {
      const text = normalizeWhitespace(line);
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

  function collectInteractiveElements() {
    const interactives = [];
    const seen = new Set();
    const nodes = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]'
    );

    for (const node of nodes) {
      if (!isElementVisible(node)) {
        continue;
      }
      const label = truncateText(getInteractiveLabel(node), 140);
      if (!label) {
        continue;
      }
      const tag = node.tagName.toLowerCase();
      const type = normalizeWhitespace(node.getAttribute('type') || '');
      const destination =
        tag === 'a'
          ? node.href
          : normalizeWhitespace(node.getAttribute('action') || '');
      const key = `${tag}|${label}|${destination}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      interactives.push({
        element: type ? `${tag}[${type}]` : tag,
        label,
        destination: destination ? truncateText(destination, 220) : '',
      });
      if (interactives.length >= CONTEXT_MAX_INTERACTIVES) {
        break;
      }
    }

    return interactives;
  }

  function buildDomStats() {
    const allElements = document.querySelectorAll('*');
    const images = Array.from(document.images || []);
    const imagesWithoutAlt = images.filter((image) => {
      const alt = normalizeWhitespace(image.getAttribute('alt') || '');
      return !alt;
    });

    return {
      elementsScanned: allElements.length,
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

  function extractPageContext(options = {}) {
    const rootClone = pruneFullPageDom();
    const cleanedText = textFromNode(rootClone);
    const { sourceChars, fullText, lines } = collectFullPageText();
    const maxContextChars = Number.isFinite(options.maxContextChars)
      ? options.maxContextChars
      : CONTEXT_FULL_TEXT_LIMIT;
    const fullTextSample = truncateText(fullText, maxContextChars);
    const relevantLines = collectRelevantLines(lines);
    const snippets = collectSectionSnippets(lines);
    const truncated = fullTextSample.length < fullText.length;

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
        rootSelector: 'body',
        summaryText: truncateText(cleanedText, CONTEXT_MAX_TEXT_CHARS),
        fullTextSample,
        relevantLines,
        snippets,
        interactiveElements: collectInteractiveElements(),
        headings: collectHeadings(),
        keyLinks: collectKeyLinks(),
        textCharsOriginal: fullText.length,
        textCharsIncluded: fullTextSample.length,
        renderedTextChars: sourceChars,
        textWasTruncated: truncated,
      },
      structure: {
        domStats: buildDomStats(),
        timing: buildTimingSnapshot(),
      },
    };
  }

  function buildContextMarkdown(pageContext) {
    const lines = [];
    lines.push('# Page Context (Relevant From Full Page Capture)');
    lines.push(`- URL: ${pageContext.page.url}`);
    lines.push(`- Title: ${pageContext.page.title || '[none]'}`);
    lines.push('- Scan mode: full rendered DOM text (console excluded)');
    if (pageContext.meta.description) {
      lines.push(`- Description: ${pageContext.meta.description}`);
    }
    if (pageContext.meta.canonical) {
      lines.push(`- Canonical: ${pageContext.meta.canonical}`);
    }
    lines.push(`- Captured: ${pageContext.page.capturedAt}`);
    lines.push(
      `- Coverage: ${pageContext.content.renderedTextChars} rendered chars across ${pageContext.structure.domStats.elementsScanned || 0} DOM elements`
    );
    lines.push('');

    lines.push('## Most Relevant Content');
    if (pageContext.content.relevantLines.length > 0) {
      pageContext.content.relevantLines.forEach((line) => {
        lines.push(`- ${line}`);
      });
    } else {
      lines.push('- No high-signal lines detected; use supporting snippets below.');
    }
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

    if (pageContext.content.interactiveElements.length > 0) {
      lines.push('## Key UI Elements');
      pageContext.content.interactiveElements.forEach((item) => {
        if (item.destination) {
          lines.push(`- ${item.element}: ${item.label} -> ${item.destination}`);
        } else {
          lines.push(`- ${item.element}: ${item.label}`);
        }
      });
      lines.push('');
    }

    if (pageContext.content.keyLinks.length > 0) {
      lines.push('## Key Links');
      pageContext.content.keyLinks.forEach((link) => {
        const marker = link.external ? 'external' : 'internal';
        lines.push(`- [${marker}] ${link.text}: ${link.href}`);
      });
      lines.push('');
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
    const pageContext = extractPageContext({
      maxContextChars: options.maxContextChars,
    });
    const text = buildContextMarkdown(pageContext);

    return {
      text,
      pageUrl: pageContext.page.url,
      sourceTextChars: pageContext.content.renderedTextChars,
      elementsScanned: pageContext.structure.domStats.elementsScanned || 0,
      relevantCount: pageContext.content.relevantLines.length,
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

  // === SECTION: SEO Meta Extraction ===

  function extractSeoMeta() {
    const title = document.title || '';
    const titleLen = title.length;
    const titleStatus =
      titleLen >= 50 && titleLen <= 60
        ? 'pass'
        : titleLen >= 30 && titleLen <= 70
          ? 'warn'
          : titleLen === 0
            ? 'fail'
            : 'warn';

    const desc = getMetaContent('meta[name="description"]');
    const descLen = desc.length;
    const descStatus =
      descLen >= 120 && descLen <= 160
        ? 'pass'
        : descLen >= 70 && descLen <= 200
          ? 'warn'
          : descLen === 0
            ? 'fail'
            : 'warn';

    const canonical =
      document.querySelector('link[rel="canonical"]')?.href || '';
    const robots = getMetaContent('meta[name="robots"]');
    const viewport = getMetaContent('meta[name="viewport"]');

    const og = {
      title: getMetaContent('meta[property="og:title"]'),
      description: getMetaContent('meta[property="og:description"]'),
      image: getMetaContent('meta[property="og:image"]'),
      url: getMetaContent('meta[property="og:url"]'),
      type: getMetaContent('meta[property="og:type"]'),
      siteName: getMetaContent('meta[property="og:site_name"]'),
    };

    const twitter = {
      card: getMetaContent('meta[name="twitter:card"]'),
      title: getMetaContent('meta[name="twitter:title"]'),
      description: getMetaContent('meta[name="twitter:description"]'),
      image: getMetaContent('meta[name="twitter:image"]'),
      creator: getMetaContent('meta[name="twitter:creator"]'),
      site: getMetaContent('meta[name="twitter:site"]'),
    };

    const hreflangLinks = Array.from(
      document.querySelectorAll('link[rel="alternate"][hreflang]')
    );
    const hreflang = hreflangLinks.map((link) => ({
      lang: link.getAttribute('hreflang') || '',
      href: link.href || '',
    }));

    // Heading hierarchy
    const allHeadings = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6')
    );
    const h1Count = document.querySelectorAll('h1').length;
    const hierarchy = allHeadings.slice(0, 50).map((h) => ({
      level: parseInt(h.tagName.substring(1), 10),
      text: normalizeWhitespace(h.textContent || '').slice(0, 120),
    }));
    const headingIssues = [];
    if (h1Count === 0) headingIssues.push('No H1 tag found');
    if (h1Count > 1) headingIssues.push(`Multiple H1 tags (${h1Count})`);
    // Check nesting gaps
    for (let i = 1; i < hierarchy.length; i++) {
      if (hierarchy[i].level > hierarchy[i - 1].level + 1) {
        headingIssues.push(
          `Heading skip: H${hierarchy[i - 1].level} → H${hierarchy[i].level}`
        );
        break;
      }
    }

    // Image alt coverage
    const images = Array.from(document.images || []);
    const withAlt = images.filter(
      (img) => (img.getAttribute('alt') || '').trim().length > 0
    ).length;
    const withoutAlt = images.length - withAlt;
    const coverage =
      images.length > 0 ? Math.round((withAlt / images.length) * 100) : 100;
    const imgStatus =
      coverage >= 80 ? 'pass' : coverage >= 50 ? 'warn' : 'fail';

    return {
      title: { value: title, length: titleLen, status: titleStatus },
      metaDescription: { value: desc, length: descLen, status: descStatus },
      canonical,
      robots,
      viewport,
      og,
      twitter,
      hreflang,
      headings: {
        h1Count,
        hierarchy,
        issues: headingIssues,
        status: h1Count === 1 ? 'pass' : h1Count === 0 ? 'warn' : 'fail',
      },
      images: {
        total: images.length,
        withAlt,
        withoutAlt,
        coverage,
        status: imgStatus,
      },
    };
  }

  // === SECTION: Structured Data Extraction ===

  const SCHEMA_RULES = {
    Article: {
      required: ['headline', 'author', 'datePublished'],
      recommended: ['image', 'publisher'],
    },
    NewsArticle: {
      required: ['headline', 'datePublished'],
      recommended: ['author', 'image', 'publisher'],
    },
    BlogPosting: {
      required: ['headline', 'author', 'datePublished'],
      recommended: ['image'],
    },
    Product: {
      required: ['name'],
      recommended: ['image', 'description', 'offers'],
    },
    FAQPage: { required: ['mainEntity'], recommended: [] },
    BreadcrumbList: { required: ['itemListElement'], recommended: [] },
    Organization: { required: ['name'], recommended: ['url', 'logo'] },
    LocalBusiness: {
      required: ['name', 'address'],
      recommended: ['telephone', 'openingHoursSpecification'],
    },
    Event: {
      required: ['name', 'startDate'],
      recommended: ['location', 'image'],
    },
    Person: { required: ['name'], recommended: ['jobTitle'] },
    WebSite: { required: ['name', 'url'], recommended: ['potentialAction'] },
    Recipe: {
      required: ['name'],
      recommended: ['image', 'recipeIngredient', 'recipeInstructions'],
    },
    VideoObject: {
      required: ['name', 'uploadDate'],
      recommended: ['description', 'thumbnailUrl'],
    },
    HowTo: { required: ['name', 'step'], recommended: ['image'] },
  };

  function validateSchemaType(type, data) {
    const rules = SCHEMA_RULES[type];
    if (!rules) return { errors: [], warnings: [] };
    const errors = rules.required
      .filter((prop) => !data[prop])
      .map((prop) => `Missing required: ${prop}`);
    const warnings = rules.recommended
      .filter((prop) => !data[prop])
      .map((prop) => `Missing recommended: ${prop}`);
    return { errors, warnings };
  }

  function extractJsonLd() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    const results = [];
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data)
          ? data
          : data['@graph']
            ? data['@graph']
            : [data];
        for (const item of items) {
          const type = item['@type'] || 'Unknown';
          const validation = validateSchemaType(type, item);
          results.push({
            raw: item,
            type,
            errors: validation.errors,
            warnings: validation.warnings,
          });
        }
      } catch (e) {
        results.push({
          raw: null,
          type: 'ParseError',
          errors: [e.message],
          warnings: [],
        });
      }
    }
    return results;
  }

  function extractMicrodata() {
    const scopes = document.querySelectorAll('[itemscope]');
    return Array.from(scopes)
      .slice(0, 20)
      .map((scope) => {
        const type = scope.getAttribute('itemtype') || '';
        const shortType = type.split('/').pop() || type;
        const props = {};
        scope.querySelectorAll('[itemprop]').forEach((propEl) => {
          const name = propEl.getAttribute('itemprop');
          const value =
            propEl.getAttribute('content') ||
            propEl.textContent?.trim() ||
            propEl.getAttribute('href') ||
            '';
          props[name] = normalizeWhitespace(value).slice(0, 200);
        });
        return { type: shortType, fullType: type, properties: props };
      });
  }

  function extractRdfa() {
    const elements = document.querySelectorAll('[typeof]');
    return Array.from(elements)
      .slice(0, 20)
      .map((el) => {
        const type = el.getAttribute('typeof') || '';
        const about = el.getAttribute('about') || '';
        const props = {};
        el.querySelectorAll('[property]').forEach((propEl) => {
          const name = propEl.getAttribute('property') || '';
          const value =
            propEl.getAttribute('content') || propEl.textContent?.trim() || '';
          props[name] = normalizeWhitespace(value).slice(0, 200);
        });
        return { type, about, properties: props };
      });
  }

  function extractStructuredData() {
    const jsonLd = extractJsonLd();
    const microdata = extractMicrodata();
    const rdfa = extractRdfa();

    const allTypes = new Set();
    jsonLd.forEach((item) => allTypes.add(item.type));
    microdata.forEach((item) => allTypes.add(item.type));
    rdfa.forEach((item) => allTypes.add(item.type));

    let totalWarnings = 0;
    jsonLd.forEach((item) => {
      totalWarnings += item.errors.length + item.warnings.length;
    });

    return {
      jsonLd,
      microdata,
      rdfa,
      stats: {
        typesFound: allTypes.size,
        jsonLdCount: jsonLd.length,
        microdataCount: microdata.length,
        rdfaCount: rdfa.length,
        validationWarnings: totalWarnings,
      },
    };
  }

  // === SECTION: Message Handler ===

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
      return;
    }

    if (message.type === 'GET_SEO_META') {
      sendResponse({ ok: true, data: extractSeoMeta() });
      return;
    }

    if (message.type === 'GET_STRUCTURED_DATA') {
      sendResponse({ ok: true, data: extractStructuredData() });
      return;
    }

    if (message.type === 'GET_AI_CONTEXT') {
      const maxContextChars = Number(message.maxContextChars);
      const contextPayload = buildContextPayload({
        maxContextChars: Number.isFinite(maxContextChars)
          ? Math.min(60000, Math.max(6000, Math.floor(maxContextChars)))
          : CONTEXT_FULL_TEXT_LIMIT,
      });
      sendResponse({
        ok: true,
        format: 'ai-context-markdown',
        ...contextPayload,
      });
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
