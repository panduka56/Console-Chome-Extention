# Privacy Policy for Console Copy Helper

Last updated: February 10, 2026

Console Copy Helper is a Chrome extension for capturing developer diagnostics (console output and page analysis) and generating optional AI summaries.

## Single Purpose
The extension's single purpose is to help users capture, structure, copy, and optionally summarize troubleshooting/context information from the active tab.

## Data We Process
The extension can process the following categories of data when the user explicitly triggers features:

- **Website content**
  - Console entries, page text, metadata, structured data, links, and sitemap content from the active tab.
- **Web history**
  - Active tab URL, page title, and related page metadata needed for reports.
- **Authentication information**
  - User-entered API keys for supported AI providers (for example, DeepSeek/OpenAI/Anthropic) when configured by the user.

The extension does **not** collect health data, financial/payment data, location data, or background keystroke/mouse tracking.

## How Data Is Used
Data is used only to:

- Build on-device reports in the popup UI.
- Copy user-requested report output to clipboard.
- Send selected report/context text to a user-selected AI provider **only when the user clicks an AI generation action**.

## Data Sharing
- We do **not** sell user data.
- We do **not** transfer user data for unrelated purposes.
- We do **not** use or transfer user data to determine creditworthiness or for lending.
- If the user enables AI generation, relevant report text is sent to the selected AI provider endpoint to produce the requested summary.

## Storage and Retention
- Settings and API keys are stored locally using `chrome.storage.local`.
- Diagnostic/page data is processed in-session and not operated as a developer-controlled analytics backend.

## Security
- API keys are stored locally in extension storage and are not intentionally included in copied report payloads.
- Network calls are made only to endpoints required by user-triggered features (for example, selected AI provider APIs, sitemap fetch targets).

## User Controls
Users can:

- Clear API keys in Settings.
- Use non-AI features without any API key.
- Avoid sending content externally by not using AI generation actions.

## Changes to This Policy
We may update this policy to reflect feature or compliance changes. Updates will be posted at this URL.

## Contact
For support or privacy questions:

- Repository: https://github.com/panduka56/Console-Chome-Extention
- Issues: https://github.com/panduka56/Console-Chome-Extention/issues
