import { createHash, randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { AdminControls } from "@/admin-controls";
import { getAuthToken, getBrokerPortCandidates } from "@/config";
import type {
  CreatedSession,
  ExtensionControl,
  ExtensionReloadResult,
} from "@/extension-control";
import { isFocusRequiredToolName } from "@/focus-tools";
import { createToolErrorResult } from "@/tool-errors";

import type { Resource, ResourceResult } from "@/resources/resource";
import type { Tool, ToolResult, ToolSchema } from "@/tools/tool";
import { handleSessionTool, sessionToolSchemas } from "./session-tools";
import { SessionPool } from "./session-pool";

const brokerHost = "127.0.0.1";
const brokerReadyMessage = "browsefleetmcp-broker-ready";
const brokerProtocolVersion = 2;
const brokerRetryDelayMs = 100;
const brokerRetryCount = 20;

export type BrokerMetadata = {
  ready: typeof brokerReadyMessage;
  protocolVersion: typeof brokerProtocolVersion;
  serverName: string;
  serverVersion: string;
  serverCwd: string;
  serverRoot: string;
  serverPid: number;
  brokerPort: number;
  startedAt: string;
  toolNames: string[];
  toolSurfaceFingerprint: string;
  toolSchemas: ToolSchema[];
  resourceUris: string[];
};

export type BrokerCompatibilityOptions = {
  expectedServerRoot?: string;
  expectedToolSurfaceFingerprint?: string;
  expectedToolNames?: string[];
  rejectLegacyBroker?: boolean;
};

export class IncompatibleBrokerError extends Error {
  readonly brokerPort?: number;
  readonly metadata?: BrokerMetadata;

  constructor(
    message: string,
    options: { brokerPort?: number; metadata?: BrokerMetadata } = {},
  ) {
    super(message);
    this.name = "IncompatibleBrokerError";
    this.brokerPort = options.brokerPort;
    this.metadata = options.metadata;
  }
}

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
    }
  | {
      id: string;
      type: "createSession";
      payload?: {
        url?: string;
        label?: string;
      };
    }
  | {
      id: string;
      type: "reloadExtension";
      payload?: undefined;
    }
  | {
      id: string;
      type: "restartTransport";
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
        | CreatedSession
        | ExtensionReloadResult
        | BrokerMetadata
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

export function getBrokerToolSchemas(tools: Tool[]): ToolSchema[] {
  return [...sessionToolSchemas, ...tools.map((tool) => tool.schema)];
}

function normalizeToolSchemas(toolSchemas: ToolSchema[]): ToolSchema[] {
  return [...toolSchemas]
    .map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createToolSurfaceFingerprint(toolSchemas: ToolSchema[]): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeToolSchemas(toolSchemas)))
    .digest("hex");
}

function createBrokerMetadata(options: {
  brokerPort: number;
  name: string;
  version: string;
  serverRoot: string;
  tools: Tool[];
  resources: Resource[];
}): BrokerMetadata {
  const toolSchemas = getBrokerToolSchemas(options.tools);

  return {
    ready: brokerReadyMessage,
    protocolVersion: brokerProtocolVersion,
    serverName: options.name,
    serverVersion: options.version,
    serverCwd: process.cwd(),
    serverRoot: options.serverRoot,
    serverPid: process.pid,
    brokerPort: options.brokerPort,
    startedAt: new Date().toISOString(),
    toolNames: toolSchemas.map((tool) => tool.name),
    toolSurfaceFingerprint: createToolSurfaceFingerprint(toolSchemas),
    toolSchemas,
    resourceUris: options.resources.map((resource) => resource.schema.uri),
  };
}

function parseBrokerMetadata(
  handshake: BrokerMetadata | string,
): BrokerMetadata | null {
  if (handshake === brokerReadyMessage) {
    return null;
  }

  if (
    handshake &&
    typeof handshake === "object" &&
    handshake.ready === brokerReadyMessage &&
    handshake.protocolVersion === brokerProtocolVersion
  ) {
    return handshake;
  }

  throw new Error("Connected to an unexpected BrowseFleetMCP broker process.");
}

function normalizePath(value?: string): string | undefined {
  return value?.replace(/\\/g, "/").replace(/\/+$/, "");
}

function compareToolNames(expected: string[], actual: string[]) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  return {
    missing: expected.filter((name) => !actualSet.has(name)).sort(),
    extra: actual.filter((name) => !expectedSet.has(name)).sort(),
  };
}

function assertCompatibleBroker(
  client: BrokerClient,
  options: BrokerCompatibilityOptions,
) {
  const metadata = client.metadata;

  if (!metadata) {
    if (!options.rejectLegacyBroker) {
      return;
    }

    throw new IncompatibleBrokerError(
      [
        `Connected to a legacy BrowseFleetMCP broker on ${brokerHost}:${client.brokerPort}.`,
        "Restart the BrowseFleetMCP transport so the active broker can report its tool surface before MCP clients use it.",
      ].join(" "),
      { brokerPort: client.brokerPort },
    );
  }

  const expectedServerRoot = normalizePath(options.expectedServerRoot);
  const brokerServerRoot = normalizePath(metadata.serverRoot);
  if (
    expectedServerRoot &&
    brokerServerRoot &&
    expectedServerRoot !== brokerServerRoot
  ) {
    throw new IncompatibleBrokerError(
      [
        `Connected to a BrowseFleetMCP broker from "${metadata.serverRoot}" on ${brokerHost}:${client.brokerPort},`,
        `but this MCP process was loaded from "${options.expectedServerRoot}".`,
        "Restart the BrowseFleetMCP transport so all MCP clients route to the same installed build.",
      ].join(" "),
      { brokerPort: client.brokerPort, metadata },
    );
  }

  if (
    options.expectedToolSurfaceFingerprint &&
    metadata.toolSurfaceFingerprint &&
    options.expectedToolSurfaceFingerprint !== metadata.toolSurfaceFingerprint
  ) {
    const expectedToolNames = options.expectedToolNames ?? [];
    const { missing, extra } = compareToolNames(
      expectedToolNames,
      metadata.toolNames,
    );
    const details = [
      missing.length > 0 ? `missing tools: ${missing.join(", ")}` : undefined,
      extra.length > 0 ? `extra tools: ${extra.join(", ")}` : undefined,
    ].filter(Boolean);

    throw new IncompatibleBrokerError(
      [
        `Connected to a stale BrowseFleetMCP broker on ${brokerHost}:${client.brokerPort}.`,
        `Broker PID ${metadata.serverPid} from "${metadata.serverRoot}" has a different tool surface.`,
        details.length > 0 ? details.join("; ") + "." : undefined,
        "Restart the BrowseFleetMCP transport before using this MCP client.",
      ].filter(Boolean).join(" "),
      { brokerPort: client.brokerPort, metadata },
    );
  }

  if (options.expectedToolNames) {
    const { missing } = compareToolNames(
      options.expectedToolNames,
      metadata.toolNames,
    );
    if (missing.length > 0) {
      throw new IncompatibleBrokerError(
        [
          `Connected to a BrowseFleetMCP broker on ${brokerHost}:${client.brokerPort} that is missing advertised tools: ${missing.join(", ")}.`,
          "Restart the BrowseFleetMCP transport before using this MCP client.",
        ].join(" "),
        { brokerPort: client.brokerPort, metadata },
      );
    }
  }
}

function sendMessage(socket: WebSocket, message: BrokerResponse) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

async function handleToolCall(
  sessionPool: SessionPool,
  extensionControl: ExtensionControl,
  adminControls: AdminControls,
  clientId: string,
  tools: Tool[],
  name: string,
  params?: Record<string, any>,
): Promise<ToolResult> {
  try {
    const sessionToolResult = await handleSessionTool(
      sessionPool,
      extensionControl,
      adminControls,
      clientId,
      tools,
      name,
      params,
    );
    if (sessionToolResult) {
      return sessionToolResult;
    }

    const tool = tools.find((tool) => tool.schema.name === name);
    if (!tool) {
      return createToolErrorResult(new Error(`Tool "${name}" not found`), {
        toolName: name,
      });
    }

    const { context, executor, sessionId } = sessionPool.acquire(clientId);
    if (isFocusRequiredToolName(name)) {
      return await executor.run(() =>
        sessionPool.runFocusSensitiveTask(
          {
            clientId,
            sessionId,
            toolName: name,
          },
          () => tool.handle(context, params),
        ),
      );
    }

    return await executor.run(() => tool.handle(context, params));
  } catch (error) {
    return createToolErrorResult(error, { toolName: name });
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
  name: string;
  version: string;
  serverRoot: string;
  tools: Tool[];
  resources: Resource[];
  sessionPool: SessionPool;
  extensionControl: ExtensionControl;
  adminControls: AdminControls;
}): Promise<WebSocketServer> {
  const { tools, resources, sessionPool, extensionControl, adminControls } =
    options;

  let lastError: unknown;

  for (const brokerPort of getBrokerPortCandidates()) {
    try {
      return await new Promise((resolve, reject) => {
        const server = new WebSocketServer({ host: brokerHost, port: brokerPort });
        const metadata = createBrokerMetadata({
          brokerPort,
          name: options.name,
          version: options.version,
          serverRoot: options.serverRoot,
          tools,
          resources,
        });
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
                      result: metadata,
                    });
                    return;
                  case "callTool":
                    sendMessage(socket, {
                      id: message.id,
                      ok: true,
                      result: await handleToolCall(
                        sessionPool,
                        extensionControl,
                        adminControls,
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
                  case "createSession":
                    sendMessage(socket, {
                      id: message.id,
                      ok: true,
                      result: await extensionControl.createSession({
                        url: message.payload?.url,
                        label: message.payload?.label,
                      }),
                    });
                    return;
                  case "reloadExtension":
                    sendMessage(socket, {
                      id: message.id,
                      ok: true,
                      result: await extensionControl.reloadExtension(),
                    });
                    return;
                  case "restartTransport": {
                    const scheduled = adminControls.scheduleTransportRestart();
                    sendMessage(socket, {
                      id: message.id,
                      ok: true,
                      result: scheduled
                        ? "Restarting the BrowseFleetMCP transport stack."
                        : "A BrowseFleetMCP transport restart is already in progress.",
                    });
                    return;
                  }
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
  private readonly closePromise: Promise<void>;
  metadata: BrokerMetadata | null = null;

  private constructor(
    private readonly socket: WebSocket,
    readonly brokerPort: number,
  ) {
    this.closePromise = new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
    });

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

  static async connect(
    retryCount: number = brokerRetryCount,
    options: BrokerCompatibilityOptions = {},
  ): Promise<BrokerClient> {
    let lastError: unknown;

    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      for (const brokerPort of getBrokerPortCandidates()) {
        let client: BrokerClient | undefined;
        try {
          client = await new Promise<BrokerClient>((resolve, reject) => {
            const socket = new WebSocket(`ws://${brokerHost}:${brokerPort}`);

            socket.once("open", () => resolve(new BrokerClient(socket, brokerPort)));
            socket.once("error", reject);
          });

          const authToken = getAuthToken();
          const handshake = await client.request<BrokerMetadata | string>(
            "hello",
            authToken ? { authToken } : undefined,
          );
          client.metadata = parseBrokerMetadata(handshake);
          assertCompatibleBroker(client, options);

          return client;
        } catch (error) {
          await client?.close().catch(() => undefined);
          if (error instanceof IncompatibleBrokerError) {
            throw error;
          }
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

    try {
      this.socket.send(JSON.stringify({ id, type, payload }));
    } catch (error) {
      this.pendingRequests.delete(id);
      throw error;
    }

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

  async createSession(url?: string, label?: string) {
    return await this.request<CreatedSession>("createSession", { url, label });
  }

  async reloadExtension() {
    return await this.request<ExtensionReloadResult>("reloadExtension");
  }

  async restartTransport() {
    return await this.request<string>("restartTransport");
  }

  async waitForClose(timeoutMs: number = 5_000) {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error("Timed out waiting for the BrowseFleetMCP broker to close."),
        );
      }, timeoutMs);

      void this.closePromise.then(
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
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
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        resolve();
      };

      const timeoutId = setTimeout(() => {
        try {
          this.socket.terminate();
        } catch {
          // Ignore termination failures during shutdown fallback.
        }
        finish();
      }, 1_000);

      this.socket.once("close", finish);
      this.socket.close();
    });
  }
}
