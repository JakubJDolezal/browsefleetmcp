import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import net from "node:net";
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
const AUTH_TOKEN = "session-routing-test-token";

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

function waitForHeartbeatAck(ws, requestId, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      ws.off("message", handleMessage);
      reject(new Error("Timed out waiting for heartbeat acknowledgement."));
    }, timeoutMs);

    const handleMessage = (rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (
        message.type !== "heartbeatAck" ||
        message.payload?.requestId !== requestId
      ) {
        return;
      }

      clearTimeout(timeoutId);
      ws.off("message", handleMessage);
      resolve(message);
    };

    ws.on("message", handleMessage);
  });
}

async function createBrowserSession({
  wsPort,
  sessionId,
  tabId,
  windowId,
  title,
  url,
  onRequest,
}) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${wsPort}?sessionId=${encodeURIComponent(sessionId)}&tabId=${tabId}&windowId=${windowId}&authToken=${encodeURIComponent(AUTH_TOKEN)}`,
  );

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
    async heartbeat() {
      const requestId = `heartbeat-${Math.random().toString(36).slice(2)}`;
      const ackPromise = waitForHeartbeatAck(ws, requestId);
      ws.send(
        JSON.stringify({
          id: requestId,
          type: "heartbeat",
          payload: {
            sentAt: new Date().toISOString(),
          },
        }),
      );
      return await ackPromise;
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

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
    const pendingCalls = [];
    const wsPort = await findAvailablePort();
    let brokerPort = await findAvailablePort();
    while (brokerPort === wsPort) {
      brokerPort = await findAvailablePort();
    }

    try {
      step = "starting first MCP client";
      clientOne = await createMcpClient("test-client-one", wsPort, brokerPort);
      step = "connecting first browser session";
      sessionOne = await createBrowserSession({
        wsPort,
        sessionId: "session-one",
        tabId: 101,
        windowId: 201,
        title: "Session One",
        url: "https://session-one.test",
      });
      step = "connecting second browser session";
      sessionTwo = await createBrowserSession({
        wsPort,
        sessionId: "session-two",
        tabId: 102,
        windowId: 202,
        title: "Session Two",
        url: "https://session-two.test",
      });

      step = "verifying heartbeat acknowledgement";
      const heartbeatAck = await sessionOne.heartbeat();
      assert.equal(heartbeatAck.type, "heartbeatAck");
      assert.ok(heartbeatAck.payload?.receivedAt);

      step = "starting second MCP client";
      clientTwo = await createMcpClient(
        "test-client-two",
        wsPort,
        brokerPort,
      );

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
        toolsResult.tools.some((tool) => tool.name === "browser_get_current_session"),
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
      assert.deepEqual(
        initialSessions.sessions.map((session) => session.recentClientCount),
        [0, 0],
      );

      step = "capturing snapshot without a selected session";
      const missingSelection = await callTool(clientOne.client, "browser_snapshot");
      assert.equal(missingSelection.isError, true);
      assert.match(getTextResult(missingSelection), /currently selected/i);

      step = "switching first client to session one";
      const switchedOne = await callTool(clientOne.client, "browser_switch_session", {
        sessionId: "session-one",
      });
      assert.match(getTextResult(switchedOne), /Switched to session session-one/);

      step = "switching second client to session two";
      const switchedTwo = await callTool(clientTwo.client, "browser_switch_session", {
        sessionId: "session-two",
      });
      assert.match(getTextResult(switchedTwo), /Switched to session session-two/);

      step = "checking current session";
      const currentSession = JSON.parse(
        getTextResult(
          await callTool(clientOne.client, "browser_get_current_session"),
        ),
      );
      assert.equal(currentSession.session?.sessionId, "session-one");

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
          recentClientCount: session.recentClientCount,
        })),
        [
          {
            sessionId: "session-one",
            status: "current",
            recentClientCount: 1,
          },
          {
            sessionId: "session-two",
            status: "in-use",
            recentClientCount: 1,
          },
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
          recentClientCount: session.recentClientCount,
        })),
        [
          {
            sessionId: "session-one",
            status: "available",
            recentClientCount: 1,
          },
          {
            sessionId: "session-two",
            status: "current",
            recentClientCount: 2,
          },
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

test(
  "focus-sensitive tools are serialized across selected sessions while background tools remain concurrent",
  { timeout: 30_000 },
  async () => {
    let clientOne;
    let clientTwo;
    let sessionOne;
    let sessionTwo;
    let step = "starting";
    const pendingCalls = [];
    const wsPort = await findAvailablePort();
    let brokerPort = await findAvailablePort();
    while (brokerPort === wsPort) {
      brokerPort = await findAvailablePort();
    }

    const events = [];
    const clickRelease = createDeferred();
    const snapshotRelease = createDeferred();

    try {
      step = "starting MCP clients";
      clientOne = await createMcpClient("focus-lock-client-one", wsPort, brokerPort);
      clientTwo = await createMcpClient("focus-lock-client-two", wsPort, brokerPort);

      step = "connecting browser sessions";
      sessionOne = await createBrowserSession({
        wsPort,
        sessionId: "focus-session-one",
        tabId: 201,
        windowId: 301,
        title: "Focus Session One",
        url: "https://focus-session-one.test",
        onRequest: async (message) => {
          switch (message.type) {
            case "browser_click":
              events.push({ type: "click-start", sessionId: "focus-session-one" });
              await clickRelease.promise;
              events.push({ type: "click-end", sessionId: "focus-session-one" });
              return null;
            case "browser_snapshot":
              events.push({ type: "snapshot-start", sessionId: "focus-session-one" });
              await snapshotRelease.promise;
              events.push({ type: "snapshot-end", sessionId: "focus-session-one" });
              return "root:\n  session: focus-session-one\n";
            default:
              return undefined;
          }
        },
      });
      sessionTwo = await createBrowserSession({
        wsPort,
        sessionId: "focus-session-two",
        tabId: 202,
        windowId: 302,
        title: "Focus Session Two",
        url: "https://focus-session-two.test",
        onRequest: async (message) => {
          switch (message.type) {
            case "browser_click":
              events.push({ type: "click-start", sessionId: "focus-session-two" });
              events.push({ type: "click-end", sessionId: "focus-session-two" });
              return null;
            case "browser_snapshot":
              events.push({ type: "snapshot-start", sessionId: "focus-session-two" });
              events.push({ type: "snapshot-end", sessionId: "focus-session-two" });
              return "root:\n  session: focus-session-two\n";
            default:
              return undefined;
          }
        },
      });

      step = "switching clients to sessions";
      await callTool(clientOne.client, "browser_switch_session", {
        sessionId: "focus-session-one",
      });
      await callTool(clientTwo.client, "browser_switch_session", {
        sessionId: "focus-session-two",
      });

      step = "verifying concurrent background tools";
      const firstSnapshotPromise = callTool(clientOne.client, "browser_snapshot");
      pendingCalls.push(firstSnapshotPromise);
      await waitFor(
        async () =>
          events.some(
            (event) =>
              event.type === "snapshot-start" &&
              event.sessionId === "focus-session-one",
          )
            ? true
            : undefined,
        "first snapshot start",
      );
      const secondSnapshotPromise = callTool(clientTwo.client, "browser_snapshot");
      pendingCalls.push(secondSnapshotPromise);
      await waitFor(
        async () =>
          events.some(
            (event) =>
              event.type === "snapshot-start" &&
              event.sessionId === "focus-session-two",
          )
            ? true
            : undefined,
        "second snapshot start",
      );
      assert.ok(
        events.findIndex(
          (event) =>
            event.type === "snapshot-start" &&
            event.sessionId === "focus-session-two",
        ) <
          events.findIndex(
            (event) =>
              event.type === "snapshot-end" &&
              event.sessionId === "focus-session-one",
          ) ||
          !events.some(
            (event) =>
              event.type === "snapshot-end" &&
              event.sessionId === "focus-session-one",
          ),
      );
      snapshotRelease.resolve();
      await Promise.all([firstSnapshotPromise, secondSnapshotPromise]);

      step = "verifying serialized focus-sensitive tools";
      const firstClickPromise = callTool(clientOne.client, "browser_click", {
        element: "Busy button",
        ref: "busy-ref",
      });
      pendingCalls.push(firstClickPromise);
      await waitFor(
        async () =>
          events.some(
            (event) =>
              event.type === "click-start" &&
              event.sessionId === "focus-session-one",
          )
            ? true
            : undefined,
        "first click start",
      );
      const secondClickPromise = callTool(clientTwo.client, "browser_click", {
        element: "Busy button",
        ref: "busy-ref",
      });
      pendingCalls.push(secondClickPromise);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        events.some(
          (event) =>
            event.type === "click-start" &&
            event.sessionId === "focus-session-two",
        ),
        false,
      );
      clickRelease.resolve();
      await Promise.all([firstClickPromise, secondClickPromise]);

      const clickEventOrder = events
        .filter((event) => event.type.startsWith("click-"))
        .map((event) => `${event.type}:${event.sessionId}`);
      assert.deepEqual(clickEventOrder, [
        "click-start:focus-session-one",
        "click-end:focus-session-one",
        "click-start:focus-session-two",
        "click-end:focus-session-two",
      ]);
    } catch (error) {
      throw new Error(
        [
          `Failed while ${step}.`,
          `clientOne stderr: ${clientOne?.stderr?.join("").trim() || "(empty)"}`,
          `clientTwo stderr: ${clientTwo?.stderr?.join("").trim() || "(empty)"}`,
          `events: ${JSON.stringify(events)}`,
          `cause: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        ].join("\n\n"),
      );
    } finally {
      clickRelease.resolve();
      snapshotRelease.resolve();
      await Promise.allSettled(pendingCalls);
      await closeMcpClient(clientTwo);
      await closeMcpClient(clientOne);
      await sessionTwo?.close();
      await sessionOne?.close();
    }
  },
);

test("server focus-sensitive tool list matches the extension focus lock list", async () => {
  const serverFocusToolsSource = await readFile(
    path.join(ROOT_DIR, "src", "focus-tools.ts"),
    "utf8",
  );
  const extensionFocusLockSource = await readFile(
    path.join(ROOT_DIR, "extension-v2", "src", "background", "focus-lock.ts"),
    "utf8",
  );

  const serverArrayMatch = serverFocusToolsSource.match(
    /FOCUS_REQUIRED_TOOL_NAMES = \[([\s\S]*?)\] as const/,
  );
  const setLiteralMatch = extensionFocusLockSource.match(
    /FOCUS_REQUIRED_SOCKET_REQUEST_TYPES = new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(serverArrayMatch, "Unable to locate the server focus tool list.");
  assert.ok(setLiteralMatch, "Unable to locate the extension focus lock set.");

  const serverToolNames = Array.from(
    serverArrayMatch[1].matchAll(/"([^"]+)"/g),
    (match) => match[1],
  );
  const extensionToolNames = Array.from(
    setLiteralMatch[1].matchAll(/"([^"]+)"/g),
    (match) => match[1],
  );

  assert.deepEqual(extensionToolNames, serverToolNames);
});
