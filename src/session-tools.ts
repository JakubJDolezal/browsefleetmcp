import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ToolResult, ToolSchema } from "@/tools/tool";
import type { SessionPool } from "@/session-pool";

const emptyArguments = z.object({}).strict();

const ListSessionsTool = z.object({
  name: z.literal("browser_list_sessions"),
  description: z.literal(
    "List connected browser sessions and show which session is currently selected for this MCP client.",
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

export const sessionToolSchemas: ToolSchema[] = [
  {
    name: ListSessionsTool.shape.name.value,
    description: ListSessionsTool.shape.description.value,
    inputSchema: zodToJsonSchema(ListSessionsTool.shape.arguments),
  },
  {
    name: SwitchSessionTool.shape.name.value,
    description: SwitchSessionTool.shape.description.value,
    inputSchema: zodToJsonSchema(SwitchSessionTool.shape.arguments),
  },
];

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

export async function handleSessionTool(
  sessionPool: SessionPool,
  clientId: string,
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

    case SwitchSessionTool.shape.name.value: {
      const { sessionId } = SwitchSessionTool.shape.arguments.parse(params);
      const session = sessionPool.switchClientSession(clientId, sessionId);
      return textResult(
        `Switched to session ${session.sessionId} (window ${session.windowId ?? "unknown"}, tab ${session.tabId ?? "unknown"}).`,
      );
    }

    default:
      return undefined;
  }
}
