# BrowseFleetMCP Config Examples

These files are ready-to-copy starting points for MCP clients that can run a local stdio server.

You still need this repo checkout for the unpacked Chrome extension in `extension-v2/`, even when your MCP client launches the published npm package.

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
node /absolute/path/to/browsefleetmcp/dist/index.js
```

Important:

- Build `extension-v2/` and load it in Chrome before you try any browser tools.
- Only build the root server first with `npm install && npm run build` if you are using the local checkout examples.
- Connect a tab from the extension popup before calling browser tools.
- Replace `/absolute/path/to/browsefleetmcp/dist/index.js` with the real absolute path on your machine.

Claude Desktop is handled differently. For that client, package the repo as an `.mcpb` bundle using the root `manifest.json` and `.mcpbignore`.
