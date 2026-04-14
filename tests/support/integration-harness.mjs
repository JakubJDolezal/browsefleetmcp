import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine an open test port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

export function createResultPayload(requestId, result, error) {
  return JSON.stringify({
    id: `response-${Math.random().toString(36).slice(2)}`,
    type: "messageResponse",
    payload: {
      requestId,
      result,
      error,
    },
  });
}

export async function createBrowserSession({
  wsPort,
  authToken,
  sessionId,
  tabId,
  windowId,
  label,
  title,
  url,
  onRequest,
}) {
  const socketUrl = new URL(`ws://127.0.0.1:${wsPort}`);
  socketUrl.searchParams.set("sessionId", sessionId);
  socketUrl.searchParams.set("tabId", String(tabId));
  socketUrl.searchParams.set("windowId", String(windowId));
  socketUrl.searchParams.set("authToken", authToken);
  if (label) {
    socketUrl.searchParams.set("label", label);
  }

  const ws = new WebSocket(socketUrl);

  ws.on("message", (rawMessage) => {
    void (async () => {
      const message = JSON.parse(String(rawMessage));
      if (message.type === "heartbeatAck") {
        return;
      }

      if (onRequest) {
        const customResult = await onRequest(message, ws);
        if (customResult !== undefined) {
          ws.send(createResultPayload(message.id, customResult));
          return;
        }
      }

      let result = null;
      switch (message.type) {
        case "getTitle":
          result = title;
          break;
        case "getUrl":
          result = url;
          break;
        case "browser_snapshot":
          result = `root:\n  session: ${sessionId}\n`;
          break;
        default:
          throw new Error(`Unexpected socket request type "${message.type}"`);
      }

      ws.send(createResultPayload(message.id, result));
    })().catch((error) => {
      ws.emit("error", error);
    });
  });

  if (ws.readyState !== WebSocket.OPEN) {
    await once(ws, "open");
  }

  return {
    ws,
    sessionId,
    tabId,
    windowId,
    label,
    url,
    title,
    async waitForClose() {
      if (
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      ) {
        return;
      }

      await once(ws, "close");
    },
    async close() {
      if (
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      ) {
        return;
      }

      const closed = once(ws, "close");
      ws.close();
      await closed;
    },
  };
}

export async function createControlConnection(wsPort, authToken, handlers) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${wsPort}?channel=control&authToken=${encodeURIComponent(authToken)}`,
  );

  ws.on("message", (rawMessage) => {
    void (async () => {
      const message = JSON.parse(String(rawMessage));
      if (typeof message.type !== "string") {
        return;
      }

      const handler = handlers[message.type];
      if (!handler) {
        ws.send(
          createResultPayload(
            message.id,
            undefined,
            `Unexpected control command "${message.type}"`,
          ),
        );
        return;
      }

      try {
        const result = await handler(message.payload ?? {});
        ws.send(createResultPayload(message.id, result));
      } catch (error) {
        ws.send(
          createResultPayload(
            message.id,
            undefined,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    })().catch((error) => {
      ws.emit("error", error);
    });
  });

  if (ws.readyState !== WebSocket.OPEN) {
    await once(ws, "open");
  }

  return {
    ws,
    async waitForClose() {
      if (
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      ) {
        return;
      }

      await once(ws, "close");
    },
    async close() {
      if (
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      ) {
        return;
      }

      const closed = once(ws, "close");
      ws.close();
      await closed;
    },
  };
}

export async function createMcpClient({ name, wsPort, brokerPort, authToken }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: ROOT_DIR,
    stderr: "pipe",
    env: {
      BROWSEFLEETMCP_PORT: String(wsPort),
      BROWSEFLEETMCP_BROKER_PORT: String(brokerPort),
      BROWSEFLEETMCP_AUTH_TOKEN: authToken,
    },
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
  });
  const client = new Client({ name, version: "1.0.0" });
  client.onerror = () => undefined;
  await client.connect(transport);
  return { client, transport, stderr };
}

export async function closeMcpClient(handle) {
  if (!handle) {
    return;
  }

  await handle.transport.close();
}

export async function callTool(client, name, args = {}) {
  return await client.request(
    {
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
    CallToolResultSchema,
  );
}

export function getTextResult(assert, result) {
  const textEntry = result.content.find((entry) => entry.type === "text");
  assert.ok(textEntry);
  return textEntry.text;
}

export async function execCliCommand({
  args,
  wsPort,
  brokerPort,
  authToken,
  timeout = 5_000,
}) {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["dist/index.js", ...args],
      {
        cwd: ROOT_DIR,
        timeout,
        env: {
          ...process.env,
          BROWSEFLEETMCP_PORT: String(wsPort),
          BROWSEFLEETMCP_BROKER_PORT: String(brokerPort),
          BROWSEFLEETMCP_AUTH_TOKEN: authToken,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout: String(stdout),
              stderr: String(stderr),
            }),
          );
          return;
        }

        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}
