import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEST_WS_PORT = 19450;
const TEST_BROKER_PORT = 19451;

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

async function createBrowserSession({ sessionId, tabId, windowId, title, url }) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${TEST_WS_PORT}?sessionId=${encodeURIComponent(sessionId)}&tabId=${tabId}&windowId=${windowId}`,
  );

  ws.on("message", (rawMessage) => {
    const message = JSON.parse(String(rawMessage));
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
  });

  if (ws.readyState !== WebSocket.OPEN) {
    await once(ws, "open");
  }

  return {
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

async function createMcpClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: ROOT_DIR,
    stderr: "pipe",
    env: {
      BROWSEFLEETMCP_PORT: String(TEST_WS_PORT),
      BROWSEFLEETMCP_BROKER_PORT: String(TEST_BROKER_PORT),
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

async function listSessions(client) {
  return JSON.parse(getTextResult(await callTool(client, "browser_list_sessions")));
}

async function waitFor(check, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

test(
  "CLI/MCP clients can list, lease, and switch browser sessions",
  { timeout: 30_000 },
  async () => {
    let clientOne;
    let clientTwo;
    let sessionOne;
    let sessionTwo;
    let step = "starting";

    try {
      step = "starting first MCP client";
      clientOne = await createMcpClient("test-client-one");
      step = "connecting first browser session";
      sessionOne = await createBrowserSession({
        sessionId: "session-one",
        tabId: 101,
        windowId: 201,
        title: "Session One",
        url: "https://session-one.test",
      });
      step = "connecting second browser session";
      sessionTwo = await createBrowserSession({
        sessionId: "session-two",
        tabId: 102,
        windowId: 202,
        title: "Session Two",
        url: "https://session-two.test",
      });
      step = "starting second MCP client";
      clientTwo = await createMcpClient("test-client-two");

      step = "listing tools";
      const toolsResult = await clientOne.client.request(
        {
          method: "tools/list",
          params: {},
        },
        ListToolsResultSchema,
      );
      assert.ok(
        toolsResult.tools.some((tool) => tool.name === "browser_list_sessions"),
      );
      assert.ok(
        toolsResult.tools.some((tool) => tool.name === "browser_switch_session"),
      );

      step = "listing initial sessions";
      const initialSessions = await listSessions(clientOne.client);
      assert.equal(initialSessions.currentSessionId, null);
      assert.deepEqual(
        initialSessions.sessions.map((session) => session.sessionId),
        ["session-one", "session-two"],
      );

      step = "capturing first snapshot";
      const firstSnapshot = getTextResult(
        await callTool(clientOne.client, "browser_snapshot"),
      );
      assert.match(firstSnapshot, /Page Title: Session One/);
      assert.match(firstSnapshot, /Page URL: https:\/\/session-one\.test/);

      step = "capturing second snapshot";
      const secondSnapshot = getTextResult(
        await callTool(clientTwo.client, "browser_snapshot"),
      );
      assert.match(secondSnapshot, /Page Title: Session Two/);
      assert.match(secondSnapshot, /Page URL: https:\/\/session-two\.test/);

      step = "listing leased sessions";
      const leasedSessions = await listSessions(clientOne.client);
      assert.equal(leasedSessions.currentSessionId, "session-one");
      assert.deepEqual(
        leasedSessions.sessions.map((session) => ({
          sessionId: session.sessionId,
          status: session.status,
        })),
        [
          { sessionId: "session-one", status: "current" },
          { sessionId: "session-two", status: "in-use" },
        ],
      );

      step = "switching to a busy session";
      const busySwitch = await callTool(clientOne.client, "browser_switch_session", {
        sessionId: "session-two",
      });
      assert.equal(busySwitch.isError, true);
      assert.match(getTextResult(busySwitch), /already in use/i);

      step = "closing second MCP client";
      await closeMcpClient(clientTwo);
      clientTwo = undefined;

      step = "waiting for released session";
      await waitFor(async () => {
        const sessions = await listSessions(clientOne.client);
        return sessions.sessions.find(
          (session) => session.sessionId === "session-two",
        )?.status === "available";
      }, "released session");

      step = "switching to the released session";
      const switched = await callTool(clientOne.client, "browser_switch_session", {
        sessionId: "session-two",
      });
      assert.match(
        getTextResult(switched),
        /Switched to session session-two/,
      );

      step = "capturing switched snapshot";
      const switchedSnapshot = getTextResult(
        await callTool(clientOne.client, "browser_snapshot"),
      );
      assert.match(switchedSnapshot, /Page Title: Session Two/);
      assert.match(switchedSnapshot, /Page URL: https:\/\/session-two\.test/);

      step = "listing final sessions";
      const finalSessions = await listSessions(clientOne.client);
      assert.equal(finalSessions.currentSessionId, "session-two");
      assert.deepEqual(
        finalSessions.sessions.map((session) => ({
          sessionId: session.sessionId,
          status: session.status,
        })),
        [
          { sessionId: "session-one", status: "available" },
          { sessionId: "session-two", status: "current" },
        ],
      );
    } catch (error) {
      throw new Error(
        [
          `Failed while ${step}.`,
          `clientOne stderr: ${clientOne?.stderr?.join("").trim() || "(empty)"}`,
          `clientTwo stderr: ${clientTwo?.stderr?.join("").trim() || "(empty)"}`,
          `cause: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        ].join("\n\n"),
      );
    } finally {
      await closeMcpClient(clientTwo);
      await closeMcpClient(clientOne);
      await sessionTwo?.close();
      await sessionOne?.close();
    }
  },
);
