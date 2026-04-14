import test from "node:test";
import assert from "node:assert/strict";

import { SessionTransportHub } from "../dist/offscreen/session-hub.js";
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

function maybeFindTimerByDelay(timeoutCallbacks, delay) {
  return [...timeoutCallbacks.values()].find(
    (candidate) => candidate.delay === delay,
  );
}

test("SessionTransportHub sends heartbeats and records heartbeat acknowledgements", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const transportUpdates = [];
  const intervalCallbacks = new Map();
  const timeoutCallbacks = new Map();
  let nextIntervalId = 1;
  let nextTimeoutId = 1;

  const hub = new SessionTransportHub(
    async (message) => {
      switch (message.type) {
        case "background/get-session-setup":
          return {
            session: { sessionId: "session-1", tabId: 1, windowId: 4 },
            settings: createConnectionSettings(),
          };
        case "background/update-session-transport":
          transportUpdates.push(message.payload.patch);
          return undefined;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    {
      webSocketClass: MockWebSocket,
      setInterval(callback) {
        const id = nextIntervalId;
        nextIntervalId += 1;
        intervalCallbacks.set(id, callback);
        return id;
      },
      clearInterval(intervalId) {
        intervalCallbacks.delete(intervalId);
      },
      setTimeout(callback) {
        const id = nextTimeoutId;
        nextTimeoutId += 1;
        timeoutCallbacks.set(id, callback);
        return id;
      },
      clearTimeout(timeoutId) {
        timeoutCallbacks.delete(timeoutId);
      },
      random: () => 0.5,
    },
  );

  await hub.connectSession("session-1");

  assert.equal(MockWebSocket.instances.length, 1);
  assert.ok(
    transportUpdates.some((patch) => patch.status === "connected"),
  );

  intervalCallbacks.get(1)();
  const heartbeatPayload = JSON.parse(MockWebSocket.instances[0].sent[0]);
  assert.equal(heartbeatPayload.type, "heartbeat");

  MockWebSocket.instances[0].dispatch("message", {
    data: JSON.stringify({
      type: "heartbeatAck",
      payload: {
        requestId: heartbeatPayload.id,
        receivedAt: "2026-04-12T10:00:00.000Z",
      },
    }),
  });
  await flushMicrotasks();

  assert.ok(
    transportUpdates.some(
      (patch) => patch.lastHeartbeatAt === "2026-04-12T10:00:00.000Z",
    ),
  );
  assert.equal(timeoutCallbacks.size, 0);

  await hub.disconnectSession("session-1");
});

test("SessionTransportHub reconnects with backoff and jitter after an unexpected close", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const transportUpdates = [];
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 1;

  const hub = new SessionTransportHub(
    async (message) => {
      switch (message.type) {
        case "background/get-session-setup":
          return {
            session: { sessionId: "session-1", tabId: 1, windowId: 4 },
            settings: createConnectionSettings(),
          };
        case "background/update-session-transport":
          transportUpdates.push(message.payload.patch);
          return undefined;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    {
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
    },
  );

  await hub.connectSession("session-1");
  MockWebSocket.instances[0].close(1006, "socket-lost");
  await flushMicrotasks();

  assert.ok(
    transportUpdates.some(
      (patch) =>
        patch.retryCount === 1 &&
        patch.lastCloseCode === 1006 &&
        patch.lastCloseReason === "socket-lost",
    ),
  );
  const reconnectTimer = findTimerByDelay(timeoutCallbacks, 1300);

  await reconnectTimer.callback();
  await waitFor(
    async () => (MockWebSocket.instances.length === 2 ? true : undefined),
    "second reconnect socket",
  );

  assert.equal(MockWebSocket.instances.length, 2);
  assert.ok(
    transportUpdates.some(
      (patch) => patch.status === "connected" && patch.retryCount === 0,
    ),
  );

  await hub.disconnectSession("session-1");
});

test("SessionTransportHub times out a stalled socket connect and retries", async () => {
  const MockWebSocket = createMockWebSocketClass({
    autoOpen(instanceIndex) {
      return instanceIndex > 0;
    },
  });
  const transportUpdates = [];
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 1;

  const hub = new SessionTransportHub(
    async (message) => {
      switch (message.type) {
        case "background/get-session-setup":
          return {
            session: { sessionId: "session-1", tabId: 1, windowId: 4 },
            settings: createConnectionSettings(),
          };
        case "background/update-session-transport":
          transportUpdates.push(message.payload.patch);
          return undefined;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    {
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
    },
  );

  const connectPromise = hub.connectSession("session-1");
  await flushMicrotasks();

  const connectTimeout = await waitFor(
    async () =>
      maybeFindTimerByDelay(timeoutCallbacks, SOCKET_CONNECT_TIMEOUT_MS),
    "session connect timeout timer",
  );

  await connectTimeout.callback();
  await assert.rejects(
    connectPromise,
    /Timed out opening BrowseFleetMCP socket on port 9150/,
  );
  assert.ok(
    transportUpdates.some(
      (patch) =>
        patch.lastTransportError ===
        "Timed out opening BrowseFleetMCP socket on port 9150.",
    ),
  );
  const reconnectTimer = findTimerByDelay(timeoutCallbacks, 1300);

  await reconnectTimer.callback();
  await waitFor(
    async () => (MockWebSocket.instances.length === 2 ? true : undefined),
    "session reconnect after stalled connect",
  );

  await hub.disconnectSession("session-1");
});

test("SessionTransportHub closes an opened socket when the connected status update fails", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const transportUpdates = [];
  const timeoutCallbacks = new Map();
  let nextTimeoutId = 1;
  let failConnectedPatch = true;

  const hub = new SessionTransportHub(
    async (message) => {
      switch (message.type) {
        case "background/get-session-setup":
          return {
            session: { sessionId: "session-1", tabId: 1, windowId: 4 },
            settings: createConnectionSettings(),
          };
        case "background/update-session-transport":
          transportUpdates.push(message.payload.patch);
          if (
            failConnectedPatch &&
            message.payload.patch.status === "connected"
          ) {
            failConnectedPatch = false;
            throw new Error("Background bridge disconnected.");
          }
          return undefined;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    {
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
    },
  );

  await assert.rejects(
    hub.connectSession("session-1"),
    /Background bridge disconnected/,
  );
  assert.equal(MockWebSocket.instances[0].readyState, MockWebSocket.CLOSED);
  assert.ok(
    transportUpdates.some(
      (patch) => patch.lastTransportError === "Background bridge disconnected.",
    ),
  );

  const reconnectTimer = findTimerByDelay(timeoutCallbacks, 1300);
  await reconnectTimer.callback();
  await waitFor(
    async () => (MockWebSocket.instances.length === 2 ? true : undefined),
    "session reconnect after connected patch failure",
  );
  assert.equal(MockWebSocket.instances[1].readyState, MockWebSocket.OPEN);

  await hub.disconnectSession("session-1");
});

test("SessionTransportHub forwards socket commands and returns messageResponse envelopes", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const backgroundRequests = [];
  const hub = new SessionTransportHub(
    async (message) => {
      backgroundRequests.push(message);
      switch (message.type) {
        case "background/get-session-setup":
          return {
            session: { sessionId: "session-1", tabId: 1, windowId: 4 },
            settings: createConnectionSettings(),
          };
        case "background/update-session-transport":
          return undefined;
        case "background/run-session-command":
          if (message.payload.commandType === "getTitle") {
            return "Page One";
          }
          throw new Error("Unknown ref");
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    {
      webSocketClass: MockWebSocket,
    },
  );

  try {
    await hub.connectSession("session-1");

    MockWebSocket.instances[0].dispatch("message", {
      data: JSON.stringify({
        id: "request-1",
        type: "getTitle",
        payload: {},
      }),
    });
    await waitFor(
      async () => (MockWebSocket.instances[0].sent.length >= 1 ? true : undefined),
      "getTitle socket response",
    );

    const successResponse = JSON.parse(MockWebSocket.instances[0].sent[0]);
    assert.equal(successResponse.type, "messageResponse");
    assert.equal(successResponse.payload.requestId, "request-1");
    assert.equal(successResponse.payload.result, "Page One");

    MockWebSocket.instances[0].dispatch("message", {
      data: JSON.stringify({
        id: "request-2",
        type: "browser_click",
        payload: { ref: "missing-ref" },
      }),
    });
    await waitFor(
      async () => (MockWebSocket.instances[0].sent.length >= 2 ? true : undefined),
      "browser_click socket error response",
    );

    const errorResponse = JSON.parse(MockWebSocket.instances[0].sent[1]);
    assert.equal(errorResponse.payload.requestId, "request-2");
    assert.equal(errorResponse.payload.error, "Unknown ref");
    assert.ok(
      backgroundRequests.some(
        (message) =>
          message.type === "background/run-session-command" &&
          message.payload.commandType === "browser_click",
      ),
    );
  } finally {
    await hub.disconnectSession("session-1");
  }
});

test("SessionTransportHub serializes focus-sensitive commands before sending them to the background", async () => {
  const MockWebSocket = createMockWebSocketClass();
  const startedCommands = [];
  let releaseFirstCommand;

  const hub = new SessionTransportHub(
    async (message) => {
      switch (message.type) {
        case "background/get-session-setup":
          return {
            session: { sessionId: message.payload.sessionId, tabId: 1, windowId: 4 },
            settings: createConnectionSettings(),
          };
        case "background/update-session-transport":
          return undefined;
        case "background/run-session-command":
          startedCommands.push(
            `${message.payload.sessionId}:${message.payload.commandType}`,
          );
          if (
            message.payload.sessionId === "session-1" &&
            message.payload.commandType === "browser_click"
          ) {
            await new Promise((resolve) => {
              releaseFirstCommand = resolve;
            });
          }
          return null;
        default:
          throw new Error(`Unexpected background message ${message.type}`);
      }
    },
    {
      webSocketClass: MockWebSocket,
    },
  );

  await hub.connectSession("session-1");
  await hub.connectSession("session-2");

  MockWebSocket.instances[0].dispatch("message", {
    data: JSON.stringify({
      id: "request-1",
      type: "browser_click",
      payload: { ref: "busy-ref" },
    }),
  });
  await flushMicrotasks();

  MockWebSocket.instances[1].dispatch("message", {
    data: JSON.stringify({
      id: "request-2",
      type: "browser_type",
      payload: { ref: "input-ref", text: "Serialized", submit: false },
    }),
  });
  await flushMicrotasks();

  assert.deepEqual(startedCommands, ["session-1:browser_click"]);

  releaseFirstCommand();
  await waitFor(
    async () => (startedCommands.length === 2 ? true : undefined),
    "serialized focus-sensitive background command",
  );

  assert.deepEqual(startedCommands, [
    "session-1:browser_click",
    "session-2:browser_type",
  ]);

  await hub.disconnectSession("session-1");
  await hub.disconnectSession("session-2");
});
