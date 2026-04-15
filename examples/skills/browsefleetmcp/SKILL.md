---
name: browsefleetmcp
description: Use when working with BrowseFleetMCP to control Chrome through the local MCP server and extension, especially for session management, browser automation, extension reloads, transport recovery, or validating BrowseFleet behavior itself.
---

# BrowseFleetMCP

Use this skill when:

- the task is specifically about controlling Chrome through BrowseFleetMCP
- the task involves the local BrowseFleetMCP extension, broker, or session pool
- the task needs real browser interaction through the existing BrowseFleet MCP tools
- the task is debugging BrowseFleet rather than replacing it with another browser tool

## Core workflow

1. Start with `browser_health`.
2. If no session is selected, call `browser_list_sessions`.
3. If no usable session exists, create one with `browser_create_session` or connect a tab from the extension popup.
4. Use the normal BrowseFleet tools for live work: `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_screenshot`, `browser_evaluate`, and the session-management tools.
5. If the browser side looks stale or broken, recover in this order:
   - `browser_prune_sessions`
   - `browser_reconnect_session`
   - `browser_reload_extension`
   - `browser_restart_transport`

## Working rules

- Prefer BrowseFleet MCP tools over fallback browser automation when BrowseFleet is the system under test or already configured.
- Treat sessions as explicit state. Use `browser_get_current_session` and `browser_switch_session` instead of assuming the current tab.
- Remember that focus-sensitive actions are serialized. `browser_click`, `browser_drag`, `browser_hover`, `browser_press_key`, `browser_select_option`, and `browser_type` may wait behind another focused action.
- If the extension was rebuilt locally, rebuild `extension-v2/` and reload the unpacked extension before blaming the broker.
- When a page behaves strangely, compare `browser_snapshot` and `browser_screenshot`. Snapshot is for navigation structure; screenshot is for rendered output.
- BrowseFleet stays local. The extension talks to `127.0.0.1`; do not describe it as a hosted browser service.

## Good defaults

- Use `browser_create_session` with a stable URL such as `https://example.com` for smoke checks.
- Use labels when creating sessions so multi-client work stays readable.
- Use `browser_health` again after recovery commands to confirm the extension and session pool state actually changed.
