# BrowseFleetMCP Extension

<p align="center">
  <img src="../.github/images/browsefleetmcp-logo.png" alt="BrowseFleetMCP" width="360" />
</p>

This is the TypeScript Chrome extension for BrowseFleetMCP.

## Runtime Model

This extension keeps the same browser tool surface, but changes the runtime model:

- Each connected tab gets its own local WebSocket session.
- Each connected tab is moved into its own Chrome window when you connect it.
- The background worker manages multiple tab sessions at the same time.
- The MCP server can lease different browser sessions to different agents.
- Screenshots return full PNG data instead of the shipped bundle's resized preview path.
- A separate screen-capture path can capture the current desktop source through Chrome's picker.
- Popup state is plain HTML and TypeScript instead of a bundled React app.

## Protocol Surface

- Socket request types: `getTitle`, `getUrl`, and the `browser_*` tool calls.
- Socket response envelope type: `messageResponse`.
- DOM operations still go through a content script.
- Input automation still uses `chrome.debugger`.
- Inactive-tab screenshots still fall back to `Page.captureScreenshot`.

## Build

```bash
npm install
npm run build
```

Then load `extension-v2/` as an unpacked extension in Chrome.

## Current scope

This project is meant to be inspectable and patchable. It focuses on the MCP-facing protocol, multi-session stability, and screenshot fidelity.
