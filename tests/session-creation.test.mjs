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

const AUTH_TOKEN = "session-creation-test-token";

test("MCP and CLI can both create new sessions through the extension control channel", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  const browserSessions = [];
  let createdCount = 0;

  try {
    hostClient = await createMcpClient({
      name: "session-creation-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_create_session({ url, label }) {
        createdCount += 1;
        const sessionId = `created-session-${createdCount}`;
        const session = await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId,
          tabId: 100 + createdCount,
          windowId: 200 + createdCount,
          label,
          title: `Created Session ${createdCount}`,
          url: typeof url === "string" && url.length > 0 ? url : "about:blank",
        });
        browserSessions.push(session);
        return {
          sessionId,
          tabId: session.tabId,
          windowId: session.windowId,
          label: session.label,
          title: session.title,
          url: session.url,
          status: "connected",
        };
      },
    });

    mcpClient = await createMcpClient({
      name: "session-creation-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const mcpCreateResult = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_create_session", {
          url: "https://example.com/mcp-created",
          label: "Docs Search",
        }),
      ),
    );
    assert.equal(mcpCreateResult.created.sessionId, "created-session-1");
    assert.equal(mcpCreateResult.created.url, "https://example.com/mcp-created");
    assert.equal(mcpCreateResult.created.label, "Docs Search");
    assert.equal(mcpCreateResult.session.sessionId, "created-session-1");
    assert.equal(mcpCreateResult.session.label, "Docs Search");

    const currentSession = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_get_current_session"),
      ),
    );
    assert.equal(currentSession.session?.sessionId, "created-session-1");

    const snapshot = getTextResult(
      assert,
      await callTool(mcpClient.client, "browser_snapshot"),
    );
    assert.match(snapshot, /created-session-1/);

    let cliResult;
    try {
      cliResult = await execCliCommand({
        args: [
          "create-session",
          "--url",
          "https://example.com/cli-created",
          "--label",
          "CLI Session",
        ],
        wsPort,
        brokerPort,
        authToken: AUTH_TOKEN,
      });
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${error.message} (createdCount=${createdCount}, browserSessions=${browserSessions.length})`;
      }
      throw error;
    }
    const cliPayload = JSON.parse(cliResult.stdout.trim());
    assert.equal(cliPayload.sessionId, "created-session-2");
    assert.equal(cliPayload.url, "https://example.com/cli-created");
    assert.equal(cliPayload.label, "CLI Session");

    const sessions = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_list_sessions"),
      ),
    );
    assert.equal(sessions.sessions.length, 2);
    assert.ok(
      sessions.sessions.some(
        (session) =>
          session.sessionId === "created-session-2" &&
          session.label === "CLI Session",
      ),
    );
  } finally {
    while (browserSessions.length > 0) {
      await browserSessions.pop().close().catch(() => undefined);
    }
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_create_session reconnects a created session that reports disconnected", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let browserSession;
  let reconnectCalls = 0;

  try {
    hostClient = await createMcpClient({
      name: "session-creation-reconnect-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_create_session({ url, label }) {
        return {
          sessionId: "late-session",
          tabId: 301,
          windowId: 401,
          label,
          title: "Late Session",
          url,
          status: "disconnected",
        };
      },
      async extension_reconnect_session({ sessionId }) {
        assert.equal(sessionId, "late-session");
        reconnectCalls += 1;
        browserSession = await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId,
          tabId: 301,
          windowId: 401,
          label: "Procurement",
          title: "Late Session",
          url: "https://example.com/late",
        });
        return {
          sessionId,
          tabId: 301,
          windowId: 401,
          label: "Procurement",
          title: "Late Session",
          url: "https://example.com/late",
          status: "connected",
        };
      },
    });
    mcpClient = await createMcpClient({
      name: "session-creation-reconnect-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const result = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_create_session", {
          url: "https://example.com/late",
          label: "Procurement",
        }),
      ),
    );
    assert.equal(result.created.sessionId, "late-session");
    assert.equal(result.session.sessionId, "late-session");
    assert.equal(result.recovered, false);
    assert.equal(reconnectCalls, 1);
  } finally {
    await browserSession?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_create_session recovers by attaching a matching tab when creation fails", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let browserSession;

  try {
    hostClient = await createMcpClient({
      name: "session-creation-tab-recovery-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_create_session() {
        throw new Error("Browser session disconnected");
      },
      async extension_list_tabs() {
        return [
          {
            tabId: 501,
            windowId: 601,
            title: "Supplier",
            url: "https://supplier.test/category",
            active: false,
            label: "Supplier",
          },
        ];
      },
      async extension_connect_tab({ tabId, label }) {
        assert.equal(tabId, 501);
        assert.equal(label, "Supplier");
        browserSession = await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId: "recovered-tab-session",
          tabId,
          windowId: 601,
          label,
          title: "Supplier",
          url: "https://supplier.test/category",
        });
        return {
          sessionId: "recovered-tab-session",
          tabId,
          windowId: 601,
          label,
          title: "Supplier",
          url: "https://supplier.test/category",
          status: "connected",
        };
      },
    });
    mcpClient = await createMcpClient({
      name: "session-creation-tab-recovery-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const result = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_create_session", {
          url: "https://supplier.test/category",
          label: "Supplier",
        }),
      ),
    );
    assert.equal(result.recovered, true);
    assert.equal(result.created.sessionId, "recovered-tab-session");
    assert.equal(result.session.sessionId, "recovered-tab-session");
    assert.match(result.originalError, /Browser session disconnected/);
    assert.equal(result.recovery.mode, "connected_tab");
  } finally {
    await browserSession?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});

test("browser_create_session recovers by selecting a newly attached labeled broker session", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();

  let hostClient;
  let mcpClient;
  let controlConnection;
  let browserSession;

  try {
    hostClient = await createMcpClient({
      name: "session-creation-broker-recovery-host",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });
    controlConnection = await createControlConnection(wsPort, AUTH_TOKEN, {
      async extension_create_session({ url, label }) {
        browserSession = await createBrowserSession({
          wsPort,
          authToken: AUTH_TOKEN,
          sessionId: "attached-before-error",
          tabId: 701,
          windowId: 801,
          label,
          title: "Supplier",
          url,
        });
        throw new Error("Browser session disconnected");
      },
      async extension_list_tabs() {
        return [];
      },
    });
    mcpClient = await createMcpClient({
      name: "session-creation-broker-recovery-client",
      wsPort,
      brokerPort,
      authToken: AUTH_TOKEN,
    });

    const result = JSON.parse(
      getTextResult(
        assert,
        await callTool(mcpClient.client, "browser_create_session", {
          url: "https://supplier.test/category",
          label: "Supplier Broker Recovery",
        }),
      ),
    );
    assert.equal(result.recovered, true);
    assert.equal(result.created.sessionId, "attached-before-error");
    assert.equal(result.session.sessionId, "attached-before-error");
    assert.equal(result.recovery.mode, "broker_session_by_label");
    assert.match(result.originalError, /Browser session disconnected/);
  } finally {
    await browserSession?.close().catch(() => undefined);
    await controlConnection?.close().catch(() => undefined);
    await closeMcpClient(mcpClient);
    await closeMcpClient(hostClient);
  }
});
