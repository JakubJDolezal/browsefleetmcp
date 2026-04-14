import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AUTH_TOKEN = "broker-recovery-test-token";

async function findAvailablePort() {
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

function createResultPayload(requestId, result) {
  return JSON.stringify({
    id: `response-${Math.random().toString(36).slice(2)}`,
    type: "messageResponse",
    payload: {
      requestId,
      result,
    },
  });
}

async function createBrowserSession({
  wsPort,
  sessionId,
  tabId,
  windowId,
  title,
  url,
}) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${wsPort}?sessionId=${encodeURIComponent(sessionId)}&tabId=${tabId}&windowId=${windowId}&authToken=${encodeURIComponent(AUTH_TOKEN)}`,
  );

  ws.on("message", (rawMessage) => {
    void (async () => {
      const message = JSON.parse(String(rawMessage));
      if (message.type === "heartbeat") {
        ws.send(
          JSON.stringify({
            id: `heartbeat-ack-${Math.random().toString(36).slice(2)}`,
            type: "heartbeatAck",
            payload: {
              requestId: message.id,
              receivedAt: new Date().toISOString(),
            },
          }),
        );
        return;
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

async function createMcpClient(name, wsPort, brokerPort) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: ROOT_DIR,
    stderr: "pipe",
    env: {
      BROWSEFLEETMCP_PORT: String(wsPort),
      BROWSEFLEETMCP_BROKER_PORT: String(brokerPort),
      BROWSEFLEETMCP_AUTH_TOKEN: AUTH_TOKEN,
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

async function closeMcpClient(handle) {
  if (!handle) {
    return;
  }

  await handle.transport.close();
}

async function callTool(client, name, args = {}) {
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

function getTextResult(result) {
  const textEntry = result.content.find((entry) => entry.type === "text");
  assert.ok(textEntry);
  return textEntry.text;
}

async function waitForValue(getValue, timeoutMs = 5_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await getValue();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for the expected value.");
}

test("a surviving MCP client recreates the broker stack and accepts restarted sessions", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let leader;
  let follower;
  let browserSession;

  try {
    leader = await createMcpClient("broker-recovery-leader", wsPort, brokerPort);
    follower = await createMcpClient("broker-recovery-follower", wsPort, brokerPort);

    browserSession = await createBrowserSession({
      wsPort,
      sessionId: "initial-session",
      tabId: 21,
      windowId: 7,
      title: "Initial Session",
      url: "https://example.com/initial",
    });

    const initialSessions = JSON.parse(
      getTextResult(await callTool(follower.client, "browser_list_sessions")),
    );
    assert.equal(initialSessions.sessions.length, 1);

    await closeMcpClient(leader);
    leader = undefined;
    await browserSession.waitForClose();

    const recoveredSessions = JSON.parse(
      getTextResult(await callTool(follower.client, "browser_list_sessions")),
    );
    assert.deepEqual(recoveredSessions.sessions, []);
    assert.equal(recoveredSessions.currentSessionId, null);

    browserSession = await createBrowserSession({
      wsPort,
      sessionId: "restarted-session",
      tabId: 22,
      windowId: 8,
      title: "Restarted Session",
      url: "https://example.com/restarted",
    });

    const restartedSessions = await waitForValue(async () => {
      const payload = JSON.parse(
        getTextResult(await callTool(follower.client, "browser_list_sessions")),
      );
      return payload.sessions.length > 0 ? payload : undefined;
    });

    assert.equal(restartedSessions.sessions.length, 1);
    assert.equal(restartedSessions.sessions[0].sessionId, "restarted-session");

    await callTool(follower.client, "browser_switch_session", {
      sessionId: "restarted-session",
    });

    const currentSession = JSON.parse(
      getTextResult(
        await callTool(follower.client, "browser_get_current_session"),
      ),
    );
    assert.equal(currentSession.session?.sessionId, "restarted-session");

    const snapshot = getTextResult(
      await callTool(follower.client, "browser_snapshot"),
    );
    assert.match(snapshot, /restarted-session/);
  } finally {
    await browserSession?.close().catch(() => undefined);
    await closeMcpClient(follower);
    await closeMcpClient(leader);
  }
});
