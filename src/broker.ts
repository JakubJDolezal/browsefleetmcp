import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { mcpConfig } from "@/config";

import type { Resource, ResourceResult } from "@/resources/resource";
import type { Tool, ToolResult } from "@/tools/tool";
import { SessionPool } from "./session-pool";

const brokerHost = "127.0.0.1";
const brokerPort = Number(
  process.env.BROWSERMCP_BROKER_PORT ?? mcpConfig.defaultWsPort + 1,
);
const brokerReadyMessage = "browsefleetmcp-broker-ready";
const brokerRetryDelayMs = 100;
const brokerRetryCount = 20;

type BrokerRequest =
  | {
      id: string;
      type: "callTool";
      payload: {
        name: string;
        arguments?: Record<string, any>;
      };
    }
  | {
      id: string;
      type: "readResource";
      payload: {
        uri: string;
      };
    }
  | {
      id: string;
      type: "hello";
      payload?: undefined;
    };

type BrokerResponse =
  | {
      id: string;
      ok: true;
      result:
        | ToolResult
        | {
            contents: ResourceResult[];
          }
        | string;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

function parseMessage<T>(message: RawData): T {
  return JSON.parse(message.toString()) as T;
}

function sendMessage(socket: WebSocket, message: BrokerResponse) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

async function handleToolCall(
  sessionPool: SessionPool,
  clientId: string,
  tools: Tool[],
  name: string,
  params?: Record<string, any>,
): Promise<ToolResult> {
  const { context, executor } = sessionPool.acquire(clientId);
  const tool = tools.find((tool) => tool.schema.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Tool "${name}" not found` }],
      isError: true,
    };
  }

  try {
    return await executor.run(() => tool.handle(context, params));
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error) }],
      isError: true,
    };
  }
}

async function handleReadResource(
  sessionPool: SessionPool,
  clientId: string,
  resources: Resource[],
  uri: string,
): Promise<{ contents: ResourceResult[] }> {
  const { context, executor } = sessionPool.acquire(clientId);
  const resource = resources.find((resource) => resource.schema.uri === uri);
  if (!resource) {
    return { contents: [] };
  }

  return { contents: await executor.run(() => resource.read(context, uri)) };
}

function rejectPendingRequests(
  pending: Map<string, PendingRequest>,
  error: Error,
) {
  for (const { reject } of pending.values()) {
    reject(error);
  }
  pending.clear();
}

export async function createBrokerServer(options: {
  tools: Tool[];
  resources: Resource[];
  sessionPool: SessionPool;
}): Promise<WebSocketServer> {
  const { tools, resources, sessionPool } = options;

  return await new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: brokerHost, port: brokerPort });
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);

    server.on("connection", (socket) => {
      const clientId = randomUUID();
      socket.once("close", () => {
        sessionPool.releaseClient(clientId);
      });

      socket.on("message", (rawMessage) => {
        void (async () => {
          let message: BrokerRequest;

          try {
            message = parseMessage<BrokerRequest>(rawMessage);
          } catch {
            socket.close();
            return;
          }

          try {
            switch (message.type) {
              case "hello":
                sendMessage(socket, {
                  id: message.id,
                  ok: true,
                  result: brokerReadyMessage,
                });
                return;
              case "callTool":
                sendMessage(socket, {
                  id: message.id,
                  ok: true,
                  result: await handleToolCall(
                    sessionPool,
                    clientId,
                    tools,
                    message.payload.name,
                    message.payload.arguments,
                  ),
                });
                return;
              case "readResource":
                sendMessage(socket, {
                  id: message.id,
                  ok: true,
                  result: await handleReadResource(
                    sessionPool,
                    clientId,
                    resources,
                    message.payload.uri,
                  ),
                });
                return;
            }
          } catch (error) {
            sendMessage(socket, {
              id: message.id,
              ok: false,
              error: String(error),
            });
          }
        })();
      });
    });
  });
}

export class BrokerClient {
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private constructor(private readonly socket: WebSocket) {
    this.socket.on("message", (rawMessage) => {
      const message = parseMessage<BrokerResponse>(rawMessage);
      const request = this.pendingRequests.get(message.id);
      if (!request) {
        return;
      }

      this.pendingRequests.delete(message.id);
      if (message.ok) {
        request.resolve(message.result);
        return;
      }

      request.reject(new Error(message.error));
    });

    this.socket.on("close", () => {
      rejectPendingRequests(
        this.pendingRequests,
        new Error("Lost connection to the BrowseFleetMCP broker."),
      );
    });

    this.socket.on("error", (error) => {
      rejectPendingRequests(this.pendingRequests, error);
    });
  }

  static async connect(): Promise<BrokerClient> {
    let lastError: unknown;

    for (let attempt = 0; attempt < brokerRetryCount; attempt += 1) {
      try {
        const client = await new Promise<BrokerClient>((resolve, reject) => {
          const socket = new WebSocket(
            `ws://${brokerHost}:${brokerPort}`,
          );

          socket.once("open", () => resolve(new BrokerClient(socket)));
          socket.once("error", reject);
        });

        const handshake = await client.request<string>("hello");
        if (handshake !== brokerReadyMessage) {
          throw new Error("Connected to an unexpected broker process.");
        }

        return client;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) =>
          setTimeout(resolve, brokerRetryDelayMs),
        );
      }
    }

    throw lastError;
  }

  async request<T>(
    type: BrokerRequest["type"],
    payload?: BrokerRequest["payload"],
  ): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Lost connection to the BrowseFleetMCP broker.");
    }

    const id = randomUUID();

    const response = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    this.socket.send(JSON.stringify({ id, type, payload }));

    return await response;
  }

  async callTool(name: string, params?: Record<string, any>) {
    return await this.request<ToolResult>("callTool", {
      name,
      arguments: params,
    });
  }

  async readResource(uri: string) {
    return await this.request<{ contents: ResourceResult[] }>("readResource", {
      uri,
    });
  }

  async close() {
    if (
      this.socket.readyState === WebSocket.CLOSING ||
      this.socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}
