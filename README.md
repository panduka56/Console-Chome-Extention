# Console Signal (Chrome Extension)

Console Signal is a Chrome MV3 extension for capturing page console output, filtering it, previewing exactly what will be copied, and optionally generating a condensed AI debugging brief using DeepSeek.

UI brand: **Console Signal**  
Manifest name: **Console Copy Helper**

## What This Solves

- Chrome console output is noisy and hard to share.
- Error stacks are often too large for AI prompts.
- Teams need a fast way to copy only useful logs.

This extension gives you:

- Scope presets: `Errors`, `Medium`, `Full`
- Copy formats: `AI compact`, `XML compact`, `Plain`
- Live payload preview (copy exactly what you see)
- Token-saving transforms (dedupe + stack trimming)
- Optional DeepSeek summarization for concise developer briefs
- Context tab for full-page extraction and AI-ready context packaging
- Separate Settings tab for API key/model/output-style configuration

## Install (Unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project root folder (uses `manifest.json`), or select `dist/` after `npm run build`.
5. Click **Reload** whenever files change.

## How To Use

1. Open a target web page (`http/https`) and reproduce the issue.
2. Click the extension icon.
3. In `Main` tab:
   - choose scope (`Errors`, `Medium`, `Full`)
   - choose format (`AI compact`, `XML compact`, `Plain`)
   - tune token controls if needed
4. Verify in **Payload Preview**.
5. Click **Copy Preview**.

## AI Brief (Console)

1. Go to `AI Brief` tab.
2. Click **Generate AI Brief**.
3. Click **Copy Brief**.

This uses the console payload from Main and is focused on debugging failures.

## Context: Page Context Pack

1. Go to `Context` tab.
2. Click **Extract Full Page**.
3. Optional: click **Generate AI Context Brief** (uses saved DeepSeek key).
4. Click **Copy Context Pack**.
5. Paste into your AI tool.

This mode scans rendered page text and key UI elements, filters high-signal content, and does not depend on console logs.

## Settings (DeepSeek)

1. Go to `Settings` tab.
2. Paste your DeepSeek key and click **Save**.
3. Pick model and output style.
4. These settings are used by `AI Brief` and `Context` AI condense.

## Tabs Overview

- `Main`: log filters, stats, preview, copy (console-focused)
- `AI Brief`: generate/copy concise debugging brief from console payload
- `Context`: page context extraction + optional AI condense
- `Settings`: DeepSeek key/model/style configuration

## Security Notes

- API key is stored in `chrome.storage.local` (extension storage).
- Key is never included in copied payloads.
- DeepSeek requests run only on explicit user action.
- DeepSeek endpoint:
  - `https://api.deepseek.com/chat/completions`

## Local Validation

```bash
npm run lint
npm run build
node --check src/popup.js
node --check src/background.js
node --check src/content-script.js
python3 -m json.tool manifest.json >/dev/null
```

## Contributing

See `src/CONTRIBUTING.md` for workflow and architecture notes.
