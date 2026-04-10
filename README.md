# BrowseFleetMCP

<p align="center">
  <img src=".github/images/browsefleetmcp-logo.png" alt="BrowseFleetMCP" width="420" />
</p>

## About

BrowseFleetMCP is a standalone MCP server and Chrome extension for parallel browser automation. It is designed around isolated tab-to-window sessions so multiple agents can control different windows without trampling each other.

## Features

- ⚡ Fast: Automation happens locally on your machine, resulting in better performance without network latency.
- 🔒 Private: Since automation happens locally, your browser activity stays on your device and isn't sent to remote servers.
- 👤 Logged In: Uses your existing browser profile, keeping you logged into all your services.
- 🥷🏼 Stealth: Avoids basic bot detection and CAPTCHAs by using your real browser fingerprint.

## Contributing

This repo now builds standalone. The root package provides the MCP server and CLI, and [`extension-v2/`](./extension-v2) contains the rebuilt Chrome extension.

## Local Rebuild Notes

This checkout also includes a clean Chrome extension implementation in [`extension-v2/`](./extension-v2). It keeps the existing MCP socket protocol, but removes the original single-tab runtime model:

- Each connected tab keeps its own WebSocket session to the local MCP server.
- Connecting a tab can move it into its own dedicated Chrome window for isolation.
- The local broker leases one browser session per MCP client, so concurrent agents do not contend for the same browser socket.
- Screenshot responses return full PNG image data instead of a resized preview image.
- A separate desktop screenshot tool can capture the current screen/window source through Chrome's picker.

## CLI

Install globally:

```bash
npm install -g browsefleetmcp
```

Run the stdio MCP server:

```bash
browsefleetmcp
```

Explicit subcommand form:

```bash
browsefleetmcp serve
```

## Credits

This project was originally adapted from the [Playwright MCP server](https://github.com/microsoft/playwright-mcp) so automation could run against the user's existing browser profile instead of spawning a separate browser instance.
