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
