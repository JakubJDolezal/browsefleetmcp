import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AdminControls } from "@/admin-controls";
import type { Tool, ToolResult, ToolSchema } from "@/tools/tool";
import type { ExtensionControl } from "@/extension-control";
import type { SessionPool } from "@/session-pool";
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
    "Switch this MCP client to a specific connected browser session. Use browser_list_sessions first to discover session IDs.",
  ),
  arguments: z.object({
    sessionId: z.string(),
  }),
});

const CreateSessionTool = z.object({
  name: z.literal("browser_create_session"),
  description: z.literal(
    "Create a new isolated browser session in a fresh window, connect it through the extension, and switch this MCP client to it. Accepts an optional URL and optional friendly label.",
  ),
  arguments: z.object({
    url: z.string().optional(),
    label: z.string().optional(),
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
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return sessionPool.switchClientSession(clientId, sessionId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError;
}

function getFirstTextContent(result: ToolResult): string | undefined {
  const entry = result.content.find((content) => content.type === "text");
  return entry?.type === "text" ? entry.text : undefined;
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
      const { sessionId } = SwitchSessionTool.shape.arguments.parse(params);
      const session = sessionPool.switchClientSession(clientId, sessionId);
      return textResult(
        `Switched to session ${session.sessionId} (window ${session.windowId ?? "unknown"}, tab ${session.tabId ?? "unknown"}).`,
      );
    }

    case CreateSessionTool.shape.name.value: {
      const { url, label } = CreateSessionTool.shape.arguments.parse(params ?? {});
      const created = await extensionControl.createSession({ url, label });
      const session = await switchToCreatedSession(
        sessionPool,
        clientId,
        created.sessionId,
      );

      return jsonResult({
        created,
        session,
      });
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

      return jsonResult({
        transport: adminControls.getTransportHealth(),
        sessionPool: adminControls.getSessionPoolHealth(),
        extension,
        currentSession: sessionPool.getCurrentSession(clientId) ?? null,
        sessions: sessionPool.listSessions(clientId),
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
