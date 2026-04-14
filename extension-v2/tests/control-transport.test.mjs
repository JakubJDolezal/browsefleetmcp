import test from "node:test";
import assert from "node:assert/strict";

import { ExtensionControlTransport } from "../dist/offscreen/control-transport.js";
import { SOCKET_CONNECT_TIMEOUT_MS } from "../dist/offscreen/transport-shared.js";

function createConnectionSettings() {
  return {
    primaryPort: 9150,
    fallbackPorts: [9150],
    authToken: "",
    pointerMode: "direct",
  };
}

function createMockWebSocketClass(options = {}) {
  const { autoOpen = true } = options;

  return class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      const instanceIndex = MockWebSocket.instances.length;
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      this.listeners = new Map();
      MockWebSocket.instances.push(this);
      queueMicrotask(() => {
        const shouldAutoOpen =
          typeof autoOpen === "function" ? autoOpen(instanceIndex) : autoOpen;
        if (shouldAutoOpen && this.readyState === MockWebSocket.CONNECTING) {
          this.dispatch("open");
        }
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    }

    send(message) {
      this.sent.push(message);
    }

    close(code = 1000, reason = "") {
      if (this.readyState === MockWebSocket.CLOSED) {
        return;
      }

      this.readyState = MockWebSocket.CLOSED;
      this.dispatch("close", { code, reason });
    }

    dispatch(type, event = {}) {
      if (type === "open") {
        this.readyState = MockWebSocket.OPEN;
      }

      const listeners = [...(this.listeners.get(type) ?? [])];
      for (const listener of listeners) {
        listener(event);
      }
    }
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(check, description, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check();
    if (result) {
      return result;
    }

    await flushMicrotasks();
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

function findTimerByDelay(timeoutCallbacks, delay) {
  const matches = [...timeoutCallbacks.values()].filter(
    (candidate) => candidate.delay === delay,
  );
  assert.equal(matches.length, 1, `Expected one timer with delay ${delay}.`);
  return matches[0];
}

test("ExtensionControlTransport forwards create-session commands to the background bridge", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const backgroundRequests = [];
  const transport = new ExtensionControlTransport({
    async requestBackground(message) {
      backgroundRequests.push(message);
      switch (message.type) {
        case "background/get-connection-settings":
          return createConnectionSettings();
        case "background/create-session":
          return {
            sessionId: "created-session",
            tabId: 7,
            windowId: 11,
            title: "Created Session",
            url: message.payload.url,
            status: "connected",
          };
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    webSocketClass: MockWebSocket,
  });

  await transport.connect();

  MockWebSocket.instances[0].dispatch("message", {
    data: JSON.stringify({
      id: "request-1",
      type: "extension_create_session",
      payload: {
        url: "https://example.com/created",
      },
    }),
  });

  await waitFor(
    async () => (MockWebSocket.instances[0].sent.length > 0 ? true : undefined),
    "extension create-session response",
  );

  const response = JSON.parse(MockWebSocket.instances[0].sent[0]);
  assert.equal(response.type, "messageResponse");
  assert.equal(response.payload.requestId, "request-1");
  assert.equal(response.payload.result.sessionId, "created-session");
  assert.equal(
    response.payload.result.url,
    "https://example.com/created",
  );
  assert.ok(
    backgroundRequests.some(
      (message) =>
        message.type === "background/create-session" &&
        message.payload.url === "https://example.com/created",
    ),
  );

  await transport.close();
});

test("ExtensionControlTransport forwards reload commands to the background bridge", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const backgroundRequests = [];
  const transport = new ExtensionControlTransport({
    async requestBackground(message) {
      backgroundRequests.push(message);
      switch (message.type) {
        case "background/get-connection-settings":
          return createConnectionSettings();
        case "background/reload-extension":
          return { reloading: true };
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    webSocketClass: MockWebSocket,
  });

  await transport.connect();

  MockWebSocket.instances[0].dispatch("message", {
    data: JSON.stringify({
      id: "request-2",
      type: "extension_reload",
    }),
  });

  await waitFor(
    async () => (MockWebSocket.instances[0].sent.length > 0 ? true : undefined),
    "extension reload response",
  );

  const response = JSON.parse(MockWebSocket.instances[0].sent[0]);
  assert.equal(response.type, "messageResponse");
  assert.equal(response.payload.requestId, "request-2");
  assert.deepEqual(response.payload.result, { reloading: true });
  assert.ok(
    backgroundRequests.some(
      (message) => message.type === "background/reload-extension",
    ),
  );

  await transport.close();
});

test("ExtensionControlTransport forwards unsolicited server metadata to the background bridge", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const backgroundRequests = [];
  const transport = new ExtensionControlTransport({
    async requestBackground(message) {
      backgroundRequests.push(message);
      switch (message.type) {
        case "background/get-connection-settings":
          return createConnectionSettings();
        case "background/update-server-metadata":
          return message.payload;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    webSocketClass: MockWebSocket,
  });

  await transport.connect();

  MockWebSocket.instances[0].dispatch("message", {
    data: JSON.stringify({
      type: "server_metadata",
      payload: {
        serverVersion: "0.1.3",
        serverCwd: "/tmp/browsefleetmcp",
        expectedExtensionRoot: "/tmp/browsefleetmcp/extension-v2",
        wsPortCandidates: [9150],
        brokerPortCandidates: [9151],
        serverPid: 123,
        connectedAt: "2026-04-14T12:00:00.000Z",
      },
    }),
  });

  await waitFor(
    async () =>
      backgroundRequests.some(
        (message) => message.type === "background/update-server-metadata",
      )
        ? true
        : undefined,
    "server metadata bridge update",
  );

  assert.ok(
    backgroundRequests.some(
      (message) =>
        message.type === "background/update-server-metadata" &&
        message.payload.serverCwd === "/tmp/browsefleetmcp",
    ),
  );

  await transport.close();
});

test("ExtensionControlTransport can source connection settings without the background bridge", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const backgroundRequests = [];
  const transport = new ExtensionControlTransport({
    async requestBackground(message) {
      backgroundRequests.push(message);
      throw new Error(`Unexpected background message ${message.type}`);
    },
    async getConnectionSettings() {
      return createConnectionSettings();
    },
    webSocketClass: MockWebSocket,
  });

  await transport.connect();

  assert.equal(MockWebSocket.instances.length, 1);
  const socketUrl = new URL(MockWebSocket.instances[0].url);
  assert.equal(socketUrl.origin, "ws://127.0.0.1:9150");
  assert.equal(socketUrl.searchParams.get("channel"), "control");
  assert.equal(
    socketUrl.searchParams.get("transportMode"),
    "direct-background-websocket",
  );
  assert.ok(socketUrl.searchParams.get("buildSourceRoot"));
  assert.equal(backgroundRequests.length, 0);

  await transport.close();
});

test("ExtensionControlTransport reconnects after an unexpected close", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 1;

  const transport = new ExtensionControlTransport({
    async requestBackground(message) {
      switch (message.type) {
        case "background/get-connection-settings":
          return createConnectionSettings();
        case "background/create-session":
          return null;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    webSocketClass: MockWebSocket,
    setTimeout(callback, delay) {
      const id = nextTimeoutId;
      nextTimeoutId += 1;
      timeoutCallbacks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(timeoutId) {
      timeoutCallbacks.delete(timeoutId);
    },
    random: () => 1,
  });

  await transport.connect();
  MockWebSocket.instances[0].close(1006, "socket-lost");
  await flushMicrotasks();

  const reconnectTimer = findTimerByDelay(timeoutCallbacks, 1300);

  await reconnectTimer.callback();
  await waitFor(
    async () => (MockWebSocket.instances.length === 2 ? true : undefined),
    "control reconnect socket",
  );

  assert.equal(MockWebSocket.instances.length, 2);

  await transport.close();
});

test("ExtensionControlTransport times out a stalled socket connect and retries", async () => {
  const MockWebSocket = createMockWebSocketClass({
    autoOpen(instanceIndex) {
      return instanceIndex > 0;
    },
  });
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 1;

  const transport = new ExtensionControlTransport({
    async requestBackground(message) {
      switch (message.type) {
        case "background/get-connection-settings":
          return createConnectionSettings();
        case "background/create-session":
        case "background/reload-extension":
          return null;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    webSocketClass: MockWebSocket,
    setTimeout(callback, delay) {
      const id = nextTimeoutId;
      nextTimeoutId += 1;
      timeoutCallbacks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(timeoutId) {
      timeoutCallbacks.delete(timeoutId);
    },
    random: () => 1,
  });

  const connectPromise = transport.connect();
  await flushMicrotasks();

  const connectTimeout = findTimerByDelay(
    timeoutCallbacks,
    SOCKET_CONNECT_TIMEOUT_MS,
  );

  await connectTimeout.callback();
  await assert.rejects(
    connectPromise,
    /Timed out opening BrowseFleetMCP control socket on port 9150/,
  );
  const reconnectTimer = findTimerByDelay(timeoutCallbacks, 1300);

  await reconnectTimer.callback();
  await waitFor(
    async () => (MockWebSocket.instances.length === 2 ? true : undefined),
    "control reconnect after stalled connect",
  );

  await transport.close();
});
