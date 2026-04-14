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

const AUTH_TOKEN = "browser-operations-test-token";

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

test("browser_health reports transport, extension, and labeled session state", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let browserSession;

  try {
    hostClient = await createMcpClient({
      name: "browser-health-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_status() {
        return {
          connected: true,
          lastConnectedAt: "2026-04-14T12:00:00.000Z",
          extensionId: "test-extension-id",
          extensionVersion: "0.0.2",
          extensionRootUrl: "chrome-extension://test-extension-id/",
          buildSourceRoot: "/tmp/browsefleetmcp/extension-v2",
          builtAt: "2026-04-14T12:00:00.000Z",
          browserVersion: "135.0.0.0",
          browserUserAgent: "Mozilla/5.0 Chrome/135.0.0.0",
          transportMode: "direct-background-websocket",
          activeSessionCount: 1,
          storedSessionCount: 1,
          sessionStatusCounts: { connected: 1 },
          sourcePathAvailable: true,
          sourcePathReason: null,
        };
      },
    });
    browserSession = await createBrowserSession({
      wsPort,
      authToken: AUTH_TOKEN,
      sessionId: "labeled-session",
      tabId: 61,
      windowId: 71,
      label: "Docs Search",
      title: "Example",
      url: "https://example.com/health",
    });
    mcpClient = await createMcpClient({
      name: "browser-health-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    await waitFor(async () => {
      const payload = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return payload.sessions.some(
        (session) => session.sessionId === "labeled-session",
      )
        ? payload
        : undefined;
    }, "health session registration");

    await callTool(mcpClient.client, "browser_switch_session", {
      sessionId: "labeled-session",
    });

    const health = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_health"),
      ),
    );
    assert.equal(health.transport.brokerConnected, true);
    assert.equal(health.extension.connected, true);
    assert.equal(health.extension.extensionVersion, "0.0.2");
    assert.equal(health.currentSession.sessionId, "labeled-session");
    assert.equal(health.currentSession.label, "Docs Search");
    assert.equal(health.sessions[0].label, "Docs Search");
    assert.ok(Array.isArray(health.transport.wsPortCandidates));
  } finally {
    await browserSession?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_prune_sessions returns extension cleanup details", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;

  try {
    hostClient = await createMcpClient({
      name: "browser-prune-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_prune_sessions() {
        return {
          removedSessions: [
            {
              sessionId: "stale-session",
              tabId: 11,
              windowId: 21,
              label: "Stale Session",
              reason: "tab-missing",
            },
          ],
          remainingSessionCount: 0,
        };
      },
    });
    mcpClient = await createMcpClient({
      name: "browser-prune-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const prune = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_prune_sessions"),
      ),
    );
    assert.deepEqual(prune.brokerRemovedSessions, []);
    assert.equal(prune.extension.removedSessions.length, 1);
    assert.equal(prune.extension.removedSessions[0].sessionId, "stale-session");
    assert.equal(prune.extension.removedSessions[0].reason, "tab-missing");
  } finally {
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_reconnect_session rebinds a session without restarting the full stack", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let session;

  try {
    hostClient = await createMcpClient({
      name: "browser-reconnect-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    session = await createBrowserSession({
      wsPort,
      authToken: AUTH_TOKEN,
      sessionId: "reconnect-session",
      tabId: 81,
      windowId: 91,
      label: "Reconnect Me",
      title: "Reconnect Before",
      url: "https://example.com/reconnect-before",
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_reconnect_session({ sessionId }) {
        assert.equal(sessionId, "reconnect-session");
        await session.close();
        session = await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId: "reconnect-session",
          tabId: 82,
          windowId: 92,
          label: "Reconnect Me",
          title: "Reconnect After",
          url: "https://example.com/reconnect-after",
        });
        return {
          sessionId: "reconnect-session",
          tabId: 82,
          windowId: 92,
          label: "Reconnect Me",
          title: "Reconnect After",
          url: "https://example.com/reconnect-after",
          status: "connected",
        };
      },
    });
    mcpClient = await createMcpClient({
      name: "browser-reconnect-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    await waitFor(async () => {
      const payload = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return payload.sessions.some(
        (candidate) => candidate.sessionId === "reconnect-session",
      )
        ? payload
        : undefined;
    }, "reconnect session registration");

    await callTool(mcpClient.client, "browser_switch_session", {
      sessionId: "reconnect-session",
    });

    const reconnect = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_reconnect_session", {
          sessionId: "reconnect-session",
        }),
      ),
    );
    assert.equal(reconnect.reconnected.windowId, 92);
    assert.equal(reconnect.session.sessionId, "reconnect-session");

    const snapshot = getTextResult(
      assert,
      await callTool(mcpClient.client, "browser_snapshot"),
    );
    assert.match(snapshot, /reconnect-session/);
  } finally {
    await session?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_destroy_session works through MCP and CLI", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let mcpSession;
  let cliSession;

  try {
    hostClient = await createMcpClient({
      name: "browser-destroy-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    mcpSession = await createBrowserSession({
      wsPort,
      authToken: AUTH_TOKEN,
      sessionId: "destroy-via-mcp",
      tabId: 121,
      windowId: 131,
      label: "Destroy Via MCP",
      title: "Destroy Via MCP",
      url: "https://example.com/destroy-mcp",
    });
    cliSession = await createBrowserSession({
      wsPort,
      authToken: AUTH_TOKEN,
      sessionId: "destroy-via-cli",
      tabId: 122,
      windowId: 132,
      label: "Destroy Via CLI",
      title: "Destroy Via CLI",
      url: "https://example.com/destroy-cli",
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_destroy_session({ sessionId }) {
        if (sessionId === "destroy-via-mcp") {
          await mcpSession.close();
          return { destroyed: true, sessionId };
        }
        if (sessionId === "destroy-via-cli") {
          await cliSession.close();
          return { destroyed: true, sessionId };
        }
        throw new Error(`Unexpected session id ${sessionId}`);
      },
    });
    mcpClient = await createMcpClient({
      name: "browser-destroy-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    await waitFor(async () => {
      const payload = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return payload.sessions.length === 2 ? payload : undefined;
    }, "destroy sessions registration");

    const mcpDestroy = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_destroy_session", {
          sessionId: "destroy-via-mcp",
        }),
      ),
    );
    assert.equal(mcpDestroy.destroyed, true);
    assert.equal(mcpDestroy.sessionId, "destroy-via-mcp");

    const cliResult = await execCliCommand({
      args: ["destroy-session", "--session-id", "destroy-via-cli"],
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    const cliDestroy = JSON.parse(cliResult.stdout.trim());
    assert.equal(cliDestroy.destroyed, true);
    assert.equal(cliDestroy.sessionId, "destroy-via-cli");

    await waitFor(async () => {
      const payload = JSON.parse(
        getTextResult(
          assert,
          await callTool(mcpClient.client, "browser_list_sessions"),
        ),
      );
      return payload.sessions.length === 0 ? payload : undefined;
    }, "destroyed sessions removed");
  } finally {
    await mcpSession?.close().catch(() => undefined);
    await cliSession?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_self_test creates, snapshots, and cleans up a temporary session", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let selfTestSession;
  let destroyCalls = 0;

  try {
    hostClient = await createMcpClient({
      name: "browser-self-test-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_create_session({ url, label }) {
        selfTestSession = await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId: "self-test-session",
          tabId: 101,
          windowId: 111,
          label,
          title: "Example Domain",
          url: url ?? "https://example.com",
          async onRequest(message) {
            if (message.type !== "browser_snapshot") {
              return undefined;
            }

            return [
              "- Page URL: https://example.com/",
              "- Page Title: Example Domain",
              "- Page Snapshot",
              "```yaml",
              "- heading \"Example Domain\" [ref=s1e1]",
              "```",
            ].join("\n");
          },
        });

        return {
          sessionId: "self-test-session",
          tabId: 101,
          windowId: 111,
          label,
          title: "Example Domain",
          url: url ?? "https://example.com",
          status: "connected",
        };
      },
      async extension_destroy_session({ sessionId }) {
        assert.equal(sessionId, "self-test-session");
        destroyCalls += 1;
        await selfTestSession?.close().catch(() => undefined);
        return {
          destroyed: true,
          sessionId,
        };
      },
    });
    mcpClient = await createMcpClient({
      name: "browser-self-test-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const result = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_self_test"),
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.created.sessionId, "self-test-session");
    assert.equal(result.checks.snapshotContainsExampleDomain, true);
    assert.equal(result.cleanup.destroyed, true);
    assert.equal(destroyCalls, 1);

    const sessions = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_list_sessions"),
      ),
    );
    assert.equal(
      sessions.sessions.some((session) => session.sessionId === "self-test-session"),
      false,
    );
  } finally {
    await selfTestSession?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});
