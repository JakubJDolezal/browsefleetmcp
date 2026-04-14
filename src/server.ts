import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import path from "node:path";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

import type { AdminControls } from "@/admin-controls";
import { BrokerClient, createBrokerServer } from "@/broker";
import { getBrokerPortCandidates, getWsPortCandidates } from "@/config";
import { ExtensionControl } from "@/extension-control";
import type { Resource } from "@/resources/resource";
import { SessionPool } from "@/session-pool";
import { sessionToolSchemas } from "@/session-tools";
import type { Tool } from "@/tools/tool";
import { createWebSocketServer } from "@/ws";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
};

type OwnedBrokerResources = {
  brokerServer: WebSocketServer;
  wss: WebSocketServer;
  sessionPool: SessionPool;
  extensionControl: ExtensionControl;
};

const brokerEstablishAttemptCount = 20;
const brokerEstablishRetryDelayMs = 100;

async function closeWebSocketServer(server?: WebSocketServer): Promise<void> {
  if (!server) {
    return;
  }

  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (
        error &&
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ERR_SERVER_NOT_RUNNING"
        )
      ) {
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

  let brokerClient: BrokerClient | undefined;
  let ownedBrokerResources: OwnedBrokerResources | undefined;
  let brokerConnectionPromise: Promise<BrokerClient> | undefined;
  let closed = false;
  let transportRestartScheduled = false;

  const parseNumber = (value: string | null): number | undefined => {
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const parseString = (value: string | null): string | undefined => {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  };

  const attachSessionServer = (
    wss: WebSocketServer,
    sessionPool: SessionPool,
    extensionControl: ExtensionControl,
  ) => {
    wss.on("connection", (websocket, request) => {
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      if (requestUrl.searchParams.get("channel") === "control") {
        extensionControl.attachConnection(websocket, {
          extensionId: parseString(requestUrl.searchParams.get("extensionId")) ?? null,
          extensionVersion:
            parseString(requestUrl.searchParams.get("extensionVersion")) ?? null,
          extensionRootUrl:
            parseString(requestUrl.searchParams.get("extensionRootUrl")) ?? null,
          buildSourceRoot:
            parseString(requestUrl.searchParams.get("buildSourceRoot")) ?? null,
          builtAt: parseString(requestUrl.searchParams.get("builtAt")) ?? null,
          browserVersion:
            parseString(requestUrl.searchParams.get("browserVersion")) ?? null,
          browserUserAgent:
            parseString(requestUrl.searchParams.get("browserUserAgent")) ?? null,
          transportMode:
            parseString(requestUrl.searchParams.get("transportMode")) ?? null,
        });
        if (websocket.readyState === 1) {
          websocket.send(
            JSON.stringify({
              type: "server_metadata",
              payload: {
                serverVersion: version,
                serverCwd: process.cwd(),
                expectedExtensionRoot: path.join(process.cwd(), "extension-v2"),
                wsPortCandidates: getWsPortCandidates(),
                brokerPortCandidates: getBrokerPortCandidates(),
                serverPid: process.pid,
                connectedAt: new Date().toISOString(),
              },
            }),
          );
        }
        return;
      }

      sessionPool.attachConnection(websocket, {
        sessionId: requestUrl.searchParams.get("sessionId") ?? undefined,
        tabId: parseNumber(requestUrl.searchParams.get("tabId")),
        windowId: parseNumber(requestUrl.searchParams.get("windowId")),
        label: parseString(requestUrl.searchParams.get("label")),
      });
    });
  };

  const closeOwnedBrokerResources = async (
    value?: OwnedBrokerResources,
  ): Promise<void> => {
    if (!value) {
      return;
    }

    await value.extensionControl.close().catch(() => undefined);
    await closeWebSocketServer(value.wss);
    await closeWebSocketServer(value.brokerServer);
    await value.sessionPool.close();
  };

  const tryConnectBrokerClient = async (
    retryCount: number,
  ): Promise<BrokerClient | undefined> => {
    try {
      return await BrokerClient.connect(retryCount);
    } catch {
      return undefined;
    }
  };

  const adminControls: AdminControls = {
    scheduleTransportRestart: () => false,
    getTransportHealth: () => ({
      brokerConnected: Boolean(brokerClient),
      ownsBrokerStack: Boolean(ownedBrokerResources),
      transportRestartScheduled,
      wsPortCandidates: [],
      brokerPortCandidates: [],
      serverPid: process.pid,
      serverCwd: process.cwd(),
      serverVersion: version,
    }),
    getSessionPoolHealth: () => ({
      sessionCount: 0,
      currentLeaseCount: 0,
      retainedClosedSessionCount: 0,
      focusLock: {
        queueDepth: 0,
        currentOwnerClientId: null,
        currentSessionId: null,
        currentToolName: null,
        lastWaitDurationMs: null,
        lastHoldDurationMs: null,
        timeoutMs: 0,
      },
    }),
  };

  const startOwnedBrokerStack = async (): Promise<BrokerClient> => {
    const sessionPool = new SessionPool();
    const extensionControl = new ExtensionControl();
    let brokerServer: WebSocketServer | undefined;
    let wss: WebSocketServer | undefined;
    let nextBrokerClient: BrokerClient | undefined;

    try {
      brokerServer = await createBrokerServer({
        tools,
        resources,
        sessionPool,
        extensionControl,
        adminControls,
      });
      wss = await createWebSocketServer();
      attachSessionServer(wss, sessionPool, extensionControl);
      nextBrokerClient = await BrokerClient.connect();
      ownedBrokerResources = {
        brokerServer,
        wss,
        sessionPool,
        extensionControl,
      };
      brokerClient = nextBrokerClient;
      return nextBrokerClient;
    } catch (error) {
      await nextBrokerClient?.close().catch(() => undefined);
      await extensionControl.close().catch(() => undefined);
      await closeWebSocketServer(wss);
      await closeWebSocketServer(brokerServer);
      await sessionPool.close();
      throw error;
    }
  };

  const establishBrokerClient = async (): Promise<BrokerClient> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < brokerEstablishAttemptCount; attempt += 1) {
      const existingBrokerClient = await tryConnectBrokerClient(1);
      if (existingBrokerClient) {
        brokerClient = existingBrokerClient;
        return existingBrokerClient;
      }

      try {
        return await startOwnedBrokerStack();
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, brokerEstablishRetryDelayMs),
      );
    }

    const sharedBrokerClient = await tryConnectBrokerClient(
      brokerEstablishAttemptCount,
    );
    if (sharedBrokerClient) {
      brokerClient = sharedBrokerClient;
      return sharedBrokerClient;
    }

    throw lastError ?? new Error("Unable to establish a BrowseFleetMCP broker client.");
  };

  const ensureBrokerClient = async (): Promise<BrokerClient> => {
    if (closed) {
      throw new Error("BrowseFleetMCP server is closed.");
    }

    if (brokerClient) {
      return brokerClient;
    }

    if (brokerConnectionPromise) {
      return await brokerConnectionPromise;
    }

    const connectionPromise = establishBrokerClient().finally(() => {
      if (brokerConnectionPromise === connectionPromise) {
        brokerConnectionPromise = undefined;
      }
    });
    brokerConnectionPromise = connectionPromise;
    return await connectionPromise;
  };

  const isRecoverableBrokerError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }

    return /BrowseFleetMCP broker|WebSocket is not open|socket hang up|ECONNREFUSED|ECONNRESET|EPIPE/i.test(
      error.message,
    );
  };

  const recoverBrokerClient = async (): Promise<BrokerClient> => {
    if (closed) {
      throw new Error("BrowseFleetMCP server is closed.");
    }

    if (brokerConnectionPromise) {
      return await brokerConnectionPromise;
    }

    const reconnectPromise = (async () => {
      const previousClient = brokerClient;
      brokerClient = undefined;
      await previousClient?.close().catch(() => undefined);

      const reconnectedClient = await tryConnectBrokerClient(1);
      if (reconnectedClient) {
        brokerClient = reconnectedClient;
        return reconnectedClient;
      }

      const previousResources = ownedBrokerResources;
      ownedBrokerResources = undefined;
      await closeOwnedBrokerResources(previousResources);
      return await establishBrokerClient();
    })().finally(() => {
      if (brokerConnectionPromise === reconnectPromise) {
        brokerConnectionPromise = undefined;
      }
    });

    brokerConnectionPromise = reconnectPromise;
    return await reconnectPromise;
  };

  const restartOwnedBrokerStack = async (): Promise<BrokerClient> => {
    if (closed) {
      throw new Error("BrowseFleetMCP server is closed.");
    }

    if (brokerConnectionPromise) {
      return await brokerConnectionPromise;
    }

    const restartPromise = (async () => {
      const previousClient = brokerClient;
      brokerClient = undefined;
      await previousClient?.close().catch(() => undefined);

      const previousResources = ownedBrokerResources;
      ownedBrokerResources = undefined;
      await closeOwnedBrokerResources(previousResources);
      return await establishBrokerClient();
    })().finally(() => {
      transportRestartScheduled = false;
      if (brokerConnectionPromise === restartPromise) {
        brokerConnectionPromise = undefined;
      }
    });

    brokerConnectionPromise = restartPromise;
    return await restartPromise;
  };

  adminControls.scheduleTransportRestart = () => {
    if (closed || brokerConnectionPromise || transportRestartScheduled) {
      return false;
    }

    transportRestartScheduled = true;
    queueMicrotask(() => {
      void restartOwnedBrokerStack().catch(() => undefined);
    });
    return true;
  };
  adminControls.getTransportHealth = () => ({
    brokerConnected: Boolean(brokerClient),
    ownsBrokerStack: Boolean(ownedBrokerResources),
    transportRestartScheduled,
    wsPortCandidates: getWsPortCandidates(),
    brokerPortCandidates: getBrokerPortCandidates(),
    serverPid: process.pid,
    serverCwd: process.cwd(),
    serverVersion: version,
  });
  adminControls.getSessionPoolHealth = () =>
    ownedBrokerResources?.sessionPool.getHealth() ?? {
      sessionCount: 0,
      currentLeaseCount: 0,
      retainedClosedSessionCount: 0,
      focusLock: {
        queueDepth: 0,
        currentOwnerClientId: null,
        currentSessionId: null,
        currentToolName: null,
        lastWaitDurationMs: null,
        lastHoldDurationMs: null,
        timeoutMs: 0,
      },
    };

  const withBrokerClient = async <T>(
    action: (client: BrokerClient) => Promise<T>,
  ): Promise<T> => {
    const client = await ensureBrokerClient();

    try {
      return await action(client);
    } catch (error) {
      if (!isRecoverableBrokerError(error)) {
        throw error;
      }

      const recoveredClient = await recoverBrokerClient();
      return await action(recoveredClient);
    }
  };

  try {
    await ensureBrokerClient();
  } catch (error) {
    await brokerClient?.close().catch(() => undefined);
    brokerClient = undefined;
    const resourcesToClose = ownedBrokerResources;
    ownedBrokerResources = undefined;
    await closeOwnedBrokerResources(resourcesToClose);
    throw error;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...sessionToolSchemas, ...tools.map((tool) => tool.schema)] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await withBrokerClient((client) =>
      client.callTool(request.params.name, request.params.arguments),
    );
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await withBrokerClient((client) =>
      client.readResource(request.params.uri),
    );
  });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    closed = true;
    await originalClose();
    await brokerClient?.close();
    brokerClient = undefined;
    const resourcesToClose = ownedBrokerResources;
    ownedBrokerResources = undefined;
    await closeOwnedBrokerResources(resourcesToClose);
  };

  return server;
}
