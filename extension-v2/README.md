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
- `browser_screenshot` returns the rendered browser page as a full PNG.
- `browser_snapshot` returns the simplified accessibility view for navigation.
- Popup state is plain HTML and TypeScript instead of a bundled React app.

## Protocol Surface

- Socket request types: `getTitle`, `getUrl`, and the `browser_*` tool calls.
- Socket response envelope type: `messageResponse`.
- DOM operations still go through a content script.
- Input automation still uses `chrome.debugger`.
- Focus-sensitive actions (`browser_click`, `browser_drag`, `browser_hover`, `browser_press_key`, `browser_select_option`, and `browser_type`) are serialized behind one global focus lock and bring the target session window to the front first.
- Inactive-tab screenshots still fall back to `Page.captureScreenshot`.

## Build

```bash
npm install
npm run build
```

Then load `extension-v2/` as an unpacked extension in Chrome.

## Testing

```bash
npm test
npm run test:e2e
```

To rerun just one classified action in the headed E2E, set `BROWSEFLEET_E2E_ACTION` to the socket request type you want to exercise, for example `browser_click` or `browser_drag`.

## Ports

The extension defaults to BrowseFleetMCP on port `9150`, with backup ports `9152` and `9154`. You can change the primary port and backup ports from the popup UI, and the session controller will try each configured port until it finds a running local server.

If the MCP server is started with `--auth-token` or `BROWSEFLEETMCP_AUTH_TOKEN`, enter the same token in the popup before connecting a tab.

## Current scope

This project is meant to be inspectable and patchable. It focuses on the MCP-facing protocol, multi-session stability, and screenshot fidelity.
