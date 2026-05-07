import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AdminControls } from "@/admin-controls";
import type { Tool, ToolResult, ToolSchema } from "@/tools/tool";
import type {
  BrowserTabInfo,
  ExtensionControl,
} from "@/extension-control";
import type { BrowserSessionSummary, SessionPool } from "@/session-pool";
import { classifyToolError } from "@/tool-errors";

const emptyArguments = z.object({}).strict();

const ListSessionsTool = z.object({
  name: z.literal("browser_list_sessions"),
  description: z.literal(
    "List connected browser sessions, show which session is currently selected for this MCP client, and include how many MCP clients touched each session in the last 5 minutes.",
  ),
  arguments: emptyArguments,
});

const GetCurrentSessionTool = z.object({
  name: z.literal("browser_get_current_session"),
  description: z.literal(
    "Show which browser session is currently selected for this MCP client.",
  ),
  arguments: emptyArguments,
});

const SwitchSessionTool = z.object({
  name: z.literal("browser_switch_session"),
  description: z.literal(
    "Switch this MCP client to a specific connected browser session. Use browser_list_sessions first to discover session IDs. Set takeOver only after explicit user authorization to claim a session currently leased by another client.",
  ),
  arguments: z.object({
    sessionId: z.string(),
    takeOver: z.boolean().optional().default(false),
  }),
});

const ListTabsTool = z.object({
  name: z.literal("browser_list_tabs"),
  description: z.literal(
    "List browser tabs with titles, URLs, tab IDs, window IDs, and connected BrowseFleetMCP session IDs when available.",
  ),
  arguments: emptyArguments,
});

const SwitchTabTool = z.object({
  name: z.literal("browser_switch_tab"),
  description: z.literal(
    "Switch this MCP client to a browser tab by tabId, sessionId, title, or URL. A matching unconnected tab is connected first. Set takeOver only after explicit user authorization to claim a leased session.",
  ),
  arguments: z.object({
    tabId: z.number().optional(),
    sessionId: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    exact: z.boolean().optional().default(false),
    takeOver: z.boolean().optional().default(false),
  }).strict(),
});

const CreateSessionTool = z.object({
  name: z.literal("browser_create_session"),
  description: z.literal(
    "Create a new isolated browser session in a fresh window, connect it through the extension, and switch this MCP client to it. If connection is briefly disrupted, recover by reconnecting the created session or reattaching a matching tab.",
  ),
  arguments: z.object({
    url: z.string().optional(),
    label: z.string().optional(),
    takeOver: z.boolean().optional().default(false),
    recoverExisting: z.boolean().optional().default(true),
  }).strict(),
});

const ReloadExtensionTool = z.object({
  name: z.literal("browser_reload_extension"),
  description: z.literal(
    "Ask the BrowseFleetMCP Chrome extension to reload itself. Use this after rebuilding the unpacked extension or when the extension control channel needs a clean restart.",
  ),
  arguments: emptyArguments,
});

const RestartTransportTool = z.object({
  name: z.literal("browser_restart_transport"),
  description: z.literal(
    "Restart the local BrowseFleetMCP broker and browser WebSocket transport stack owned by this server. Existing broker clients and browser sessions will reconnect.",
  ),
  arguments: emptyArguments,
});

const HealthTool = z.object({
  name: z.literal("browser_health"),
  description: z.literal(
    "Report BrowseFleetMCP server, extension, session, and focus-lock health for debugging and operational checks.",
  ),
  arguments: emptyArguments,
});

const PruneSessionsTool = z.object({
  name: z.literal("browser_prune_sessions"),
  description: z.literal(
    "Remove stale BrowseFleetMCP sessions from the extension and broker state when their tabs, windows, or sockets no longer exist.",
  ),
  arguments: emptyArguments,
});

const ReconnectSessionTool = z.object({
  name: z.literal("browser_reconnect_session"),
  description: z.literal(
    "Force one browser session to reconnect its transport without restarting the whole BrowseFleetMCP stack.",
  ),
  arguments: z.object({
    sessionId: z.string(),
  }).strict(),
});

const DestroySessionTool = z.object({
  name: z.literal("browser_destroy_session"),
  description: z.literal(
    "Disconnect and close one BrowseFleetMCP browser session by session id.",
  ),
  arguments: z.object({
    sessionId: z.string(),
  }).strict(),
});

const SelfTestTool = z.object({
  name: z.literal("browser_self_test"),
  description: z.literal(
    "Run a full BrowseFleetMCP smoke test by creating a temporary session, snapshotting it, and cleaning it up again.",
  ),
  arguments: emptyArguments,
});

export const sessionToolSchemas: ToolSchema[] = [
  ListSessionsTool,
  GetCurrentSessionTool,
  SwitchSessionTool,
  ListTabsTool,
  SwitchTabTool,
  CreateSessionTool,
  ReloadExtensionTool,
  RestartTransportTool,
  HealthTool,
  PruneSessionsTool,
  ReconnectSessionTool,
  DestroySessionTool,
  SelfTestTool,
].map((schema) => ({
  name: schema.shape.name.value,
  description: schema.shape.description.value,
  inputSchema: zodToJsonSchema(schema.shape.arguments),
}));

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

async function switchToCreatedSession(
  sessionPool: SessionPool,
  clientId: string,
  sessionId: string,
  options?: { takeOver?: boolean },
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return sessionPool.switchClientSession(clientId, sessionId, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError;
}

function includesMatch(value: string | undefined, query: string, exact: boolean): boolean {
  const normalizedValue = (value ?? "").trim();
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return false;
  }
  return exact
    ? normalizedValue === normalizedQuery
    : normalizedValue.toLowerCase().includes(normalizedQuery.toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRecoverableUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

function tabMatchesRecoveryTarget(
  tab: BrowserTabInfo,
  target: { url?: string; label?: string },
): boolean {
  const normalizedTargetUrl = normalizeRecoverableUrl(target.url);
  const normalizedTabUrl = normalizeRecoverableUrl(tab.url);
  const labelMatches =
    target.label &&
    tab.label &&
    tab.label.trim().toLowerCase() === target.label.trim().toLowerCase();
  const urlMatches =
    normalizedTargetUrl &&
    normalizedTabUrl &&
    (normalizedTabUrl === normalizedTargetUrl ||
      normalizedTabUrl.startsWith(normalizedTargetUrl));

  return Boolean(labelMatches || urlMatches);
}

function chooseRecoveryTab(
  tabs: BrowserTabInfo[],
  target: { url?: string; label?: string },
): BrowserTabInfo | undefined {
  const matches = tabs.filter((tab) => tabMatchesRecoveryTarget(tab, target));
  return matches.sort((left, right) => {
    const leftConnected = left.sessionStatus === "connected" ? 1 : 0;
    const rightConnected = right.sessionStatus === "connected" ? 1 : 0;
    if (leftConnected !== rightConnected) {
      return rightConnected - leftConnected;
    }

    const leftHasSession = left.sessionId ? 1 : 0;
    const rightHasSession = right.sessionId ? 1 : 0;
    if (leftHasSession !== rightHasSession) {
      return rightHasSession - leftHasSession;
    }

    return right.tabId - left.tabId;
  })[0];
}

function sessionMatchesRecoveryTarget(
  session: BrowserSessionSummary,
  target: { label?: string },
): boolean {
  return Boolean(
    target.label &&
      session.label &&
      session.label.trim().toLowerCase() === target.label.trim().toLowerCase(),
  );
}

function chooseRecoveryBrokerSession(
  sessions: BrowserSessionSummary[],
  target: { label?: string },
): BrowserSessionSummary | undefined {
  return sessions
    .filter((session) => sessionMatchesRecoveryTarget(session, target))
    .sort((left, right) => {
      const leftWindowId = left.windowId ?? 0;
      const rightWindowId = right.windowId ?? 0;
      if (leftWindowId !== rightWindowId) {
        return rightWindowId - leftWindowId;
      }

      return (right.tabId ?? 0) - (left.tabId ?? 0);
    })[0];
}

async function ensureCreatedSessionSelectable(
  sessionPool: SessionPool,
  extensionControl: ExtensionControl,
  clientId: string,
  sessionId: string,
  options: { takeOver?: boolean; status?: string } = {},
) {
  let switchError: unknown = new Error(
    `Created session "${sessionId}" reported status "${options.status}".`,
  );

  try {
    if (!options.status || options.status === "connected") {
      return await switchToCreatedSession(sessionPool, clientId, sessionId, options);
    }
  } catch (error) {
    if (/already in use by another client/i.test(errorMessage(error))) {
      throw error;
    }
    switchError = error;
  }

  try {
    await extensionControl.reconnectSession(sessionId);
    return await switchToCreatedSession(
      sessionPool,
      clientId,
      sessionId,
      options,
    );
  } catch (reconnectError) {
    throw new Error(
      [
        `Created session "${sessionId}" did not attach to the broker.`,
        `Switch failed: ${errorMessage(switchError)}.`,
        `Reconnect failed: ${errorMessage(reconnectError)}.`,
      ].join(" "),
    );
  }
}

async function recoverSessionFromExistingTargets(
  sessionPool: SessionPool,
  extensionControl: ExtensionControl,
  clientId: string,
  target: { url?: string; label?: string; takeOver?: boolean },
): Promise<{ created: unknown; session: unknown; recovery: unknown } | undefined> {
  let lastTabsError: unknown;

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const brokerSession = chooseRecoveryBrokerSession(
      sessionPool.listSessions(clientId),
      target,
    );
    if (brokerSession) {
      const session = sessionPool.switchClientSession(
        clientId,
        brokerSession.sessionId,
        { takeOver: target.takeOver },
      );
      return {
        created: brokerSession,
        session,
        recovery: {
          mode: "broker_session_by_label",
          session: brokerSession,
        },
      };
    }

    try {
      const recoveryTab = chooseRecoveryTab(
        await extensionControl.listTabs(),
        target,
      );
      if (recoveryTab) {
        const created = recoveryTab.sessionId
          ? await extensionControl.reconnectSession(recoveryTab.sessionId)
          : await extensionControl.connectTab({
              tabId: recoveryTab.tabId,
              label: target.label,
            });
        const session = await ensureCreatedSessionSelectable(
          sessionPool,
          extensionControl,
          clientId,
          created.sessionId,
          { takeOver: target.takeOver, status: created.status },
        );

        return {
          created,
          session,
          recovery: {
            mode: recoveryTab.sessionId
              ? "reconnected_tab_session"
              : "connected_tab",
            tab: recoveryTab,
          },
        };
      }
    } catch (error) {
      lastTabsError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (lastTabsError) {
    throw lastTabsError;
  }
  return undefined;
}

function getFirstTextContent(result: ToolResult): string | undefined {
  const entry = result.content.find((content) => content.type === "text");
  return entry?.type === "text" ? entry.text : undefined;
}

function readNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function readBooleanProperty(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function readStringArrayProperty(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || !(key in value)) {
    return [];
  }

  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function runCurrentSessionTool(
  sessionPool: SessionPool,
  clientId: string,
  tools: Tool[],
  name: string,
  params?: Record<string, any>,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.schema.name === name);
  if (!tool) {
    throw new Error(`Tool "${name}" not found`);
  }

  const { context, executor } = sessionPool.acquire(clientId);
  return await executor.run(() => tool.handle(context, params));
}

export async function handleSessionTool(
  sessionPool: SessionPool,
  extensionControl: ExtensionControl,
  adminControls: AdminControls,
  clientId: string,
  tools: Tool[],
  name: string,
  params?: Record<string, any>,
): Promise<ToolResult | undefined> {
  switch (name) {
    case ListSessionsTool.shape.name.value:
      ListSessionsTool.shape.arguments.parse(params ?? {});
      return jsonResult({
        currentSessionId: sessionPool.getCurrentSession(clientId)?.sessionId ?? null,
        sessions: sessionPool.listSessions(clientId),
      });

    case GetCurrentSessionTool.shape.name.value:
      GetCurrentSessionTool.shape.arguments.parse(params ?? {});
      return jsonResult({
        session: sessionPool.getCurrentSession(clientId) ?? null,
      });

    case SwitchSessionTool.shape.name.value: {
      const { sessionId, takeOver } = SwitchSessionTool.shape.arguments.parse(params);
      const session = sessionPool.switchClientSession(clientId, sessionId, {
        takeOver,
      });
      return textResult(
        `Switched to session ${session.sessionId} (window ${session.windowId ?? "unknown"}, tab ${session.tabId ?? "unknown"}).`,
      );
    }

    case ListTabsTool.shape.name.value: {
      ListTabsTool.shape.arguments.parse(params ?? {});
      const tabs = await extensionControl.listTabs();
      return jsonResult({
        currentSessionId: sessionPool.getCurrentSession(clientId)?.sessionId ?? null,
        tabs,
      });
    }

    case SwitchTabTool.shape.name.value: {
      const { tabId, sessionId, title, url, exact, takeOver } =
        SwitchTabTool.shape.arguments.parse(params ?? {});
      const tabs = await extensionControl.listTabs();
      const matches = tabs.filter((tab) => {
        if (typeof tabId === "number") {
          return tab.tabId === tabId;
        }
        if (sessionId) {
          return tab.sessionId === sessionId;
        }
        if (title) {
          return includesMatch(tab.title, title, exact);
        }
        if (url) {
          return includesMatch(tab.url, url, exact);
        }
        return false;
      });

      if (matches.length === 0) {
        throw new Error("No matching browser tab found.");
      }
      if (matches.length > 1) {
        return jsonResult({
          error: "Multiple matching browser tabs found. Retry with tabId or exact matching.",
          matches,
        });
      }

      const match = matches[0]!;
      const connected = match.sessionId
        ? match.sessionStatus === "connected"
          ? { sessionId: match.sessionId, status: match.sessionStatus }
          : await extensionControl.reconnectSession(match.sessionId)
        : await extensionControl.connectTab({ tabId: match.tabId });
      const session = await ensureCreatedSessionSelectable(
        sessionPool,
        extensionControl,
        clientId,
        connected.sessionId,
        { takeOver, status: connected.status },
      );
      return jsonResult({
        tab: match,
        session,
      });
    }

    case CreateSessionTool.shape.name.value: {
      const { url, label, takeOver, recoverExisting } =
        CreateSessionTool.shape.arguments.parse(params ?? {});

      try {
        const created = await extensionControl.createSession({ url, label });
        const session = await ensureCreatedSessionSelectable(
          sessionPool,
          extensionControl,
          clientId,
          created.sessionId,
          { takeOver, status: created.status },
        );

        return jsonResult({
          created,
          session,
          recovered: false,
        });
      } catch (error) {
        if (recoverExisting) {
          const recovered = await recoverSessionFromExistingTargets(
            sessionPool,
            extensionControl,
            clientId,
            { url, label, takeOver },
          ).catch(() => undefined);
          if (recovered) {
            return jsonResult({
              ...recovered,
              recovered: true,
              originalError: errorMessage(error),
            });
          }
        }

        throw error;
      }
    }

    case ReloadExtensionTool.shape.name.value: {
      ReloadExtensionTool.shape.arguments.parse(params ?? {});
      await extensionControl.reloadExtension();
      return textResult("Reloading the BrowseFleetMCP extension.");
    }

    case RestartTransportTool.shape.name.value: {
      RestartTransportTool.shape.arguments.parse(params ?? {});
      const scheduled = adminControls.scheduleTransportRestart();
      return textResult(
        scheduled
          ? "Restarting the BrowseFleetMCP transport stack."
          : "A BrowseFleetMCP transport restart is already in progress.",
      );
    }

    case HealthTool.shape.name.value: {
      HealthTool.shape.arguments.parse(params ?? {});

      let extension: unknown;
      try {
        extension = await extensionControl.getStatus();
      } catch (error) {
        extension = {
          connected: false,
          error: classifyToolError(error, {
            toolName: name,
          }),
        };
      }

      const transport = adminControls.getTransportHealth();
      const sessionPoolHealth = adminControls.getSessionPoolHealth();
      const sessions = sessionPool.listSessions(clientId);
      const warnings = [...readStringArrayProperty(extension, "warnings")];
      const extensionConnected = readBooleanProperty(extension, "connected");
      const activeExtensionSessions = readNumberProperty(
        extension,
        "activeSessionCount",
      );
      const storedExtensionSessions = readNumberProperty(
        extension,
        "storedSessionCount",
      );

      if (extensionConnected === false && sessionPoolHealth.sessionCount > 0) {
        warnings.push(
          `Broker has ${sessionPoolHealth.sessionCount} open session socket(s), but the extension control channel is disconnected.`,
        );
      }

      if (
        activeExtensionSessions !== undefined &&
        activeExtensionSessions !== sessionPoolHealth.sessionCount
      ) {
        warnings.push(
          `Broker has ${sessionPoolHealth.sessionCount} open session socket(s), while the extension reports ${activeExtensionSessions} active session transport(s).`,
        );
      }

      if (
        storedExtensionSessions !== undefined &&
        sessionPoolHealth.sessionCount > storedExtensionSessions
      ) {
        warnings.push(
          `Broker has ${sessionPoolHealth.sessionCount} open session socket(s), but the extension only has ${storedExtensionSessions} stored session record(s); prune or reconnect sessions before relying on IDs from broker-only state.`,
        );
      }

      return jsonResult({
        transport,
        sessionPool: sessionPoolHealth,
        extension,
        currentSession: sessionPool.getCurrentSession(clientId) ?? null,
        sessions,
        warnings,
      });
    }

    case PruneSessionsTool.shape.name.value: {
      PruneSessionsTool.shape.arguments.parse(params ?? {});

      let extension;
      try {
        extension = await extensionControl.pruneSessions();
      } catch (error) {
        extension = {
          removedSessions: [],
          remainingSessionCount: sessionPool.listSessions(clientId).length,
          error: classifyToolError(error, {
            toolName: name,
          }),
        };
      }

      return jsonResult({
        brokerRemovedSessions: sessionPool.pruneDisconnectedSessions(),
        extension,
        sessions: sessionPool.listSessions(clientId),
      });
    }

    case ReconnectSessionTool.shape.name.value: {
      const { sessionId } = ReconnectSessionTool.shape.arguments.parse(params ?? {});
      const summary = sessionPool.getSession(sessionId, clientId);
      if (!summary) {
        throw new Error(`Session "${sessionId}" is not currently connected.`);
      }
      if (summary.status === "in-use") {
        throw new Error(`Session "${sessionId}" is already in use by another client.`);
      }

      const reconnected = await extensionControl.reconnectSession(sessionId);
      const session = await switchToCreatedSession(sessionPool, clientId, sessionId);
      return jsonResult({
        reconnected,
        session,
      });
    }

    case DestroySessionTool.shape.name.value: {
      const { sessionId } = DestroySessionTool.shape.arguments.parse(params ?? {});
      const wasCurrent =
        sessionPool.getCurrentSession(clientId)?.sessionId === sessionId;
      const destroyed = await extensionControl.destroySession(sessionId);
      sessionPool.pruneDisconnectedSessions();
      return jsonResult({
        ...destroyed,
        wasCurrent,
        currentSession: sessionPool.getCurrentSession(clientId) ?? null,
      });
    }

    case SelfTestTool.shape.name.value: {
      SelfTestTool.shape.arguments.parse(params ?? {});

      const previousSessionId =
        sessionPool.getCurrentSession(clientId)?.sessionId ?? null;
      const created = await extensionControl.createSession({
        url: "https://example.com",
        label: "BrowseFleetMCP Self Test",
      });

      let destroyed = false;
      let restoredPreviousSession = false;
      let cleanupError: ReturnType<typeof classifyToolError> | undefined;
      let resultPayload: Record<string, unknown> | undefined;

      try {
        const session = await switchToCreatedSession(
          sessionPool,
          clientId,
          created.sessionId,
        );
        const snapshot = await runCurrentSessionTool(
          sessionPool,
          clientId,
          tools,
          "browser_snapshot",
        );
        const snapshotText = getFirstTextContent(snapshot) ?? "";

        resultPayload = {
          ok: true,
          created,
          session,
          checks: {
            snapshotContainsExampleDomain: /Example Domain/i.test(snapshotText),
          },
        };
      } finally {
        try {
          await extensionControl.destroySession(created.sessionId);
          destroyed = true;
        } catch (error) {
          cleanupError = classifyToolError(error, { toolName: name });
        }

        if (previousSessionId) {
          try {
            sessionPool.switchClientSession(clientId, previousSessionId);
            restoredPreviousSession = true;
          } catch {
            restoredPreviousSession = false;
          }
        }

        if (cleanupError) {
          throw Object.assign(new Error(cleanupError.message), {
            cleanup: {
              destroyed,
              restoredPreviousSession,
              cleanupError,
            },
          });
        }
      }

      resultPayload ??= {
        ok: false,
        created,
      };
      resultPayload.cleanup = {
        destroyed,
        restoredPreviousSession,
      };
      return jsonResult(resultPayload);
    }

    default:
      return undefined;
  }
}
