import test from "node:test";
import assert from "node:assert/strict";

import {
  callTool,
  closeMcpClient,
  createBrowserSession,
  createControlConnection,
  createMcpClient,
  execCliCommand,
  findAvailablePort,
  getTextResult,
} from "./support/integration-harness.mjs";

const AUTH_TOKEN = "operational-controls-test-token";

async function waitFor(check, description, attempts = 40, delayMs = 50) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError ?? new Error(`Timed out waiting for ${description}.`);
}

test("MCP and CLI can both reload the extension through the control channel", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let reloadCount = 0;

  try {
    hostClient = await createMcpClient({
      name: "operational-controls-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_reload() {
        reloadCount += 1;
        return { reloading: true };
      },
    });
    mcpClient = await createMcpClient({
      name: "operational-controls-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const toolResult = getTextResult(
      assert,
      await callTool(mcpClient.client, "browser_reload_extension"),
    );
    assert.match(toolResult, /Reloading the BrowseFleetMCP extension/);

    const cliResult = await execCliCommand({
      args: ["reload-extension"],
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    assert.match(
      cliResult.stdout,
      /Reloading the BrowseFleetMCP extension/,
    );
    assert.equal(reloadCount, 2);
  } finally {
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_restart_transport restarts the stack and accepts reconnected sessions", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let nextControlConnection;
  let sessionBefore;
  let sessionAfter;

  try {
    hostClient = await createMcpClient({
      name: "restart-transport-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_reload() {
        return { reloading: true };
      },
    });
    sessionBefore = await createBrowserSession({
      wsPort,
      authToken: AUTH_TOKEN,
      sessionId: "before-restart",
      tabId: 21,
      windowId: 31,
      title: "Before Restart",
      url: "https://example.com/before-restart",
    });
    mcpClient = await createMcpClient({
      name: "restart-transport-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    await waitFor(async () => {
      const sessions = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return sessions.sessions.some(
        (session) => session.sessionId === "before-restart",
      )
        ? sessions
        : undefined;
    }, "initial session registration");

    const restartResult = getTextResult(
      assert,
      await callTool(mcpClient.client, "browser_restart_transport"),
    );
    assert.match(restartResult, /Restarting the BrowseFleetMCP transport stack/);

    await waitFor(
      async () =>
        controlConnection.ws.readyState === 3 &&
        sessionBefore.ws.readyState === 3
          ? true
          : undefined,
      "transport connections to close",
    );

    nextControlConnection = await waitFor(async () => {
      try {
        return await createControlConnection(wsPort, AUTH_TOKEN, {
          async extension_reload() {
            return { reloading: true };
          },
        });
      } catch {
        return undefined;
      }
    }, "control channel rebinding");
    sessionAfter = await waitFor(async () => {
      try {
        return await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId: "after-restart",
          tabId: 22,
          windowId: 32,
          title: "After Restart",
          url: "https://example.com/after-restart",
        });
      } catch {
        return undefined;
      }
    }, "browser session rebinding");

    await waitFor(async () => {
      const sessions = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return sessions.sessions.some(
        (session) => session.sessionId === "after-restart",
      )
        ? sessions
        : undefined;
    }, "reconnected session registration");

    const switched = getTextResult(
      assert,
      await callTool(mcpClient.client, "browser_switch_session", {
        sessionId: "after-restart",
      }),
    );
    assert.match(switched, /after-restart/);

    const snapshot = getTextResult(
      assert,
      await callTool(mcpClient.client, "browser_snapshot"),
    );
    assert.match(snapshot, /after-restart/);
  } finally {
    await sessionAfter?.close().catch(() => undefined);
    await sessionBefore?.close().catch(() => undefined);
    await nextControlConnection?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("restart-transport CLI restarts the stack and accepts reconnected sessions", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let sessionBefore;
  let sessionAfter;

  try {
    hostClient = await createMcpClient({
      name: "restart-transport-cli-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    sessionBefore = await createBrowserSession({
      wsPort,
      authToken: AUTH_TOKEN,
      sessionId: "cli-before-restart",
      tabId: 41,
      windowId: 51,
      title: "CLI Before Restart",
      url: "https://example.com/cli-before-restart",
    });
    mcpClient = await createMcpClient({
      name: "restart-transport-cli-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    await waitFor(async () => {
      const sessions = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return sessions.sessions.some(
        (session) => session.sessionId === "cli-before-restart",
      )
        ? sessions
        : undefined;
    }, "CLI pre-restart session registration");

    const cliResult = await execCliCommand({
      args: ["restart-transport"],
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    assert.match(
      cliResult.stdout,
      /Restarting the BrowseFleetMCP transport stack/,
    );

    await waitFor(
      async () =>
        sessionBefore.ws.readyState === 3
          ? true
          : undefined,
      "CLI-initiated transport close",
    );

    sessionAfter = await waitFor(async () => {
      try {
        return await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId: "cli-after-restart",
          tabId: 42,
          windowId: 52,
          title: "CLI After Restart",
          url: "https://example.com/cli-after-restart",
        });
      } catch {
        return undefined;
      }
    }, "CLI browser session rebinding");

    await waitFor(async () => {
      const sessions = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return sessions.sessions.some(
        (session) => session.sessionId === "cli-after-restart",
      )
        ? sessions
        : undefined;
    }, "CLI post-restart session registration");
  } finally {
    await sessionAfter?.close().catch(() => undefined);
    await sessionBefore?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});
