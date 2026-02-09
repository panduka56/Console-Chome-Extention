# Contributing Guide

This project is a Chrome MV3 extension. Keep changes small, testable, and easy for the next person to continue.

## 1) Setup

1. Clone/open project:
   - `/Users/panduka/Sites/Chome-Extention`
2. Load unpacked extension in Chrome:
   - `chrome://extensions` -> **Developer mode** -> **Load unpacked**
3. Reload extension after every code change.

## 2) Development Workflow

1. Make changes in small focused commits.
2. Validate syntax locally:

```bash
npm run lint
npm run build
node --check src/popup.js
node --check src/background.js
node --check src/content-script.js
python3 -m json.tool manifest.json >/dev/null
```

3. Reload extension in Chrome.
4. Test end-to-end on a real page (`http://localhost:*` preferred).

## 3) Architecture (High Level)

### Capture pipeline

- `page-logger.js` (page context):
  - wraps `console.log/info/warn/error/debug`
  - captures `window.error` and `unhandledrejection`
  - emits normalized events
- `content-script.js` (extension context in tab):
  - stores captured entries
  - builds filtered/export payload (`ai`, `xml`, `plain`) for Main
  - builds page context markdown payload for Labs (`GET_AI_CONTEXT`)
  - returns responses via `chrome.runtime.onMessage`

### Popup pipeline

- `popup.js`:
  - reads popup controls
  - requests report from active tab
  - renders stats + preview
  - handles copy actions
  - handles Labs context extract + optional AI condense
  - stores UI settings in `localStorage`
  - stores DeepSeek key/model in `chrome.storage.local`

### AI pipeline

- `background.js` service worker:
  - handles DeepSeek summarize message
  - calls `https://api.deepseek.com/chat/completions`
- `popup.js` fallback:
  - if background is unavailable, calls DeepSeek directly with stored key

## 4) UX Rules

- Preview must match copied output exactly.
- Avoid cramped UI; maintain section spacing.
- New features should fit tab model:
  - `Main` for log capture/export
  - `DeepSeek` for AI functions
  - `Labs` for experimental tools like context extraction

## 5) Security Rules

- Never log or display full API keys in UI.
- Never include keys in copied payload text.
- Keep AI calls explicit user actions (no auto-send).
- Redact obvious secrets before external requests where possible.

## 6) Adding A New Feature Tab

1. Add tab button in `popup.html` with `data-view="<name>"`.
2. Add view section with `id="<name>View"` and class `view`.
3. Ensure `popup.js` `viewMap` includes the new view.
4. Add styles in `popup.css`.
5. Verify state persists through `localStorage` settings.

## 7) Release Checklist

- [ ] Bump `version` in `manifest.json`
- [ ] Run syntax/manifest validation commands
- [ ] Reload extension and smoke test:
  - [ ] Preview loads
  - [ ] Copy Preview works
  - [ ] Key save/clear works
  - [ ] Generate AI Brief works
  - [ ] Copy Brief works
  - [ ] Generate Context works (Labs)
  - [ ] Condense with AI works (Labs)
  - [ ] Copy Context works (Labs)
- [ ] Update `README.md` if behavior changed

## 8) Common Pitfalls

- `Preview unavailable` on restricted pages (`chrome://`, `devtools://`)
- Missing content script receiver on first load (page refresh usually fixes)
- Extension not reloaded after manifest changes

## 9) Suggested Next Features

- Per-project presets for prompt templates
- Issue export (`Markdown`, `Jira`, `Linear`)
- Grouped error timeline for long sessions
- Optional local-only summarizer mode
