# BrowseFleetMCP Config Examples

These files are ready-to-copy starting points for MCP clients that can run a local stdio server.

Published package examples:

- `codex/config.toml`
- `cursor/mcp.json`
- `claude-code/mcp.json`
- `generic/stdio.json`
- `generic/stdio.windows.json`
- `cli/basic.txt`
- `cli/custom-ports.txt`
- `cli/auth-token.txt`

Local checkout examples:

- `codex/config.local.toml`
- `cursor/mcp.local.json`
- `claude-code/mcp.local.json`
- `generic/stdio.local.json`

Use the published package files when you want your client to launch the npm release with `npx -y browsefleetmcp`.

Use the local checkout files when you want your client to launch this repo directly with:

```bash
node /absolute/path/to/browsermcp/dist/index.js
```

Important:

- Build the root server first with `npm install && npm run build`.
- Build and load the Chrome extension from `extension-v2/`.
- Connect a tab from the extension popup before calling browser tools.
- Replace `/absolute/path/to/browsermcp/dist/index.js` with the real absolute path on your machine.

Claude Desktop is handled differently. For that client, package the repo as an `.mcpb` bundle using the root `manifest.json` and `.mcpbignore`.
