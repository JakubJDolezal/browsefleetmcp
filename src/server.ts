import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

import { BrokerClient, createBrokerServer } from "@/broker";
import type { Resource } from "@/resources/resource";
import { SessionPool } from "@/session-pool";
import type { Tool } from "@/tools/tool";
import { createWebSocketServer } from "@/ws";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
};

async function closeWebSocketServer(server?: WebSocketServer): Promise<void> {
  if (!server) {
    return;
  }

  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function createServerWithTools(options: Options): Promise<Server> {
  const { name, version, tools, resources } = options;
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  let wss: WebSocketServer | undefined;
  let brokerServer: WebSocketServer | undefined;
  let brokerClient: BrokerClient | undefined;
  let sessionPool: SessionPool | undefined;

  const parseNumber = (value: string | null): number | undefined => {
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  try {
    sessionPool = new SessionPool();
    brokerServer = await createBrokerServer({
      tools,
      resources,
      sessionPool,
    });
    wss = await createWebSocketServer();
    wss.on("connection", (websocket, request) => {
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      sessionPool?.attachConnection(websocket, {
        sessionId: requestUrl.searchParams.get("sessionId") ?? undefined,
        tabId: parseNumber(requestUrl.searchParams.get("tabId")),
        windowId: parseNumber(requestUrl.searchParams.get("windowId")),
      });
    });
    brokerClient = await BrokerClient.connect();
  } catch (error) {
    const errorCode =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;

    await closeWebSocketServer(wss);
    wss = undefined;

    if (brokerServer) {
      await closeWebSocketServer(brokerServer);
      brokerServer = undefined;
    }

    await sessionPool?.close();
    sessionPool = undefined;

    if (errorCode !== "EADDRINUSE") {
      throw error;
    }

    try {
      brokerClient = await BrokerClient.connect();
    } catch (brokerError) {
      throw brokerError;
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => tool.schema) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!brokerClient) {
      throw new Error("Unable to establish a BrowseFleetMCP broker client.");
    }

    return await brokerClient.callTool(
      request.params.name,
      request.params.arguments,
    );
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (!brokerClient) {
      throw new Error("Unable to establish a BrowseFleetMCP broker client.");
    }

    return await brokerClient.readResource(request.params.uri);
  });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    await originalClose();
    await brokerClient?.close();
    await closeWebSocketServer(brokerServer);
    await closeWebSocketServer(wss);
    await sessionPool?.close();
  };

  return server;
}
