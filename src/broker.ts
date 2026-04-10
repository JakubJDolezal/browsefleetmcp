import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { getAuthToken, getBrokerPortCandidates } from "@/config";

import type { Resource, ResourceResult } from "@/resources/resource";
import type { Tool, ToolResult } from "@/tools/tool";
import { handleSessionTool } from "./session-tools";
import { SessionPool } from "./session-pool";

const brokerHost = "127.0.0.1";
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
      payload?: {
        authToken?: string;
      };
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
  try {
    const sessionToolResult = await handleSessionTool(
      sessionPool,
      clientId,
      name,
      params,
    );
    if (sessionToolResult) {
      return sessionToolResult;
    }

    const tool = tools.find((tool) => tool.schema.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool "${name}" not found` }],
        isError: true,
      };
    }

    const { context, executor } = sessionPool.acquire(clientId);
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

function isAuthorized(providedToken?: string): boolean {
  const expectedToken = getAuthToken();
  if (!expectedToken) {
    return true;
  }

  return providedToken?.trim() === expectedToken;
}

export async function createBrokerServer(options: {
  tools: Tool[];
  resources: Resource[];
  sessionPool: SessionPool;
}): Promise<WebSocketServer> {
  const { tools, resources, sessionPool } = options;

  let lastError: unknown;

  for (const brokerPort of getBrokerPortCandidates()) {
    try {
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
          let isAuthenticated = false;
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
                if (message.type !== "hello" && !isAuthenticated) {
                  socket.close();
                  return;
                }

                switch (message.type) {
                  case "hello":
                    if (!isAuthorized(message.payload?.authToken)) {
                      sendMessage(socket, {
                        id: message.id,
                        ok: false,
                        error: "Unauthorized BrowseFleetMCP broker connection.",
                      });
                      socket.close();
                      return;
                    }

                    isAuthenticated = true;
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
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Unable to bind a BrowseFleetMCP broker server.");
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

  static async connect(retryCount: number = brokerRetryCount): Promise<BrokerClient> {
    let lastError: unknown;

    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      for (const brokerPort of getBrokerPortCandidates()) {
        try {
          const client = await new Promise<BrokerClient>((resolve, reject) => {
            const socket = new WebSocket(`ws://${brokerHost}:${brokerPort}`);

            socket.once("open", () => resolve(new BrokerClient(socket)));
            socket.once("error", reject);
          });

          const authToken = getAuthToken();
          const handshake = await client.request<string>(
            "hello",
            authToken ? { authToken } : undefined,
          );
          if (handshake !== brokerReadyMessage) {
            throw new Error("Connected to an unexpected broker process.");
          }

          return client;
        } catch (error) {
          lastError = error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, brokerRetryDelayMs));
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
