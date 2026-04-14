import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundService } from "../dist/background/service.js";
import {
  BACKGROUND_BRIDGE_PORT_NAME,
  CONNECTION_SETTINGS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
} from "../dist/shared/protocol.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChromeMock() {
  const setCalls = [];
  const reloadCalls = [];
  const runtimeMessageListeners = [];
  const runtimeConnectListeners = [];

  return {
    setCalls,
    reloadCalls,
    runtimeMessageListeners,
    runtimeConnectListeners,
    chrome: {
      runtime: {
        id: "test-extension-id",
        getManifest() {
          return { version: "0.0.2" };
        },
        getURL(path = "") {
          return `chrome-extension://test-extension-id/${path}`;
        },
        reload() {
          reloadCalls.push(Date.now());
        },
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          },
        },
        onConnect: {
          addListener(listener) {
            runtimeConnectListeners.push(listener);
          },
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set(payload) {
            setCalls.push(payload);
          },
        },
      },
      tabs: {
        async get() {
          return { id: 1, windowId: 2, title: "Example", url: "https://example.com" };
        },
        async query() {
          return [];
        },
        async update() {
          return null;
        },
        onRemoved: {
          addListener() {},
        },
        onUpdated: {
          addListener() {},
        },
      },
      windows: {
        async get() {
          return { type: "normal", tabs: [{ id: 1 }] };
        },
        async create() {
          return { tabs: [{ id: 1, windowId: 2 }] };
        },
        async update() {
          return null;
        },
      },
    },
  };
}

function createPortMock(name) {
  const messageListeners = [];
  const disconnectListeners = [];
  const postedMessages = [];

  return {
    name,
    postedMessages,
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
    postMessage(message) {
      postedMessages.push(message);
    },
    emitMessage(message) {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
    emitDisconnect() {
      for (const listener of disconnectListeners) {
        listener();
      }
    },
  };
}

test("BackgroundService batches repeated record persistence", async () => {
  const { chrome, setCalls } = createChromeMock();
  const service = new BackgroundService({
    chromeApi: chrome,
    persistDebounceMs: 5,
  });

  service.handleRecordUpdate({
    sessionId: "session-1",
    tabId: 7,
    windowId: 2,
    title: "First title",
    url: "https://example.com/one",
    status: "connecting",
    connectedAt: "2026-04-10T12:00:00.000Z",
    updatedAt: "2026-04-10T12:00:00.000Z",
  });
  service.handleRecordUpdate({
    sessionId: "session-1",
    tabId: 7,
    windowId: 2,
    title: "Second title",
    url: "https://example.com/two",
    status: "connected",
    connectedAt: "2026-04-10T12:00:00.000Z",
    updatedAt: "2026-04-10T12:00:01.000Z",
  });

  await wait(20);

  assert.equal(setCalls.length, 1);
  assert.deepEqual(setCalls[0][SESSION_STORAGE_KEY], [
    {
      sessionId: "session-1",
      tabId: 7,
      windowId: 2,
      title: "Second title",
      url: "https://example.com/two",
      status: "connected",
      connectedAt: "2026-04-10T12:00:00.000Z",
      updatedAt: "2026-04-10T12:00:01.000Z",
    },
  ]);
});

test("BackgroundService stores normalized connection settings", async () => {
  const { chrome, setCalls } = createChromeMock();
  const service = new BackgroundService({
    chromeApi: chrome,
  });

  const settings = await service.updateConnectionSettings({
    primaryPort: 9200,
    fallbackPorts: [9202, 9200, 9202, 9204],
    authToken: "  shared-token  ",
    pointerMode: "human",
  });

  assert.deepEqual(settings, {
    primaryPort: 9200,
    fallbackPorts: [9202, 9204],
    authToken: "shared-token",
    pointerMode: "human",
  });
  assert.deepEqual(
    setCalls[0][CONNECTION_SETTINGS_STORAGE_KEY],
    settings,
  );
});

test("BackgroundService responds to background bridge port requests", async () => {
  const { chrome, runtimeConnectListeners } = createChromeMock();
  const controlTransportConnectCalls = [];
  const service = new BackgroundService({
    chromeApi: chrome,
    createControlTransport() {
      return {
        async connect() {
          controlTransportConnectCalls.push(true);
        },
      };
    },
  });

  service.start();

  assert.equal(controlTransportConnectCalls.length, 1);
  assert.equal(runtimeConnectListeners.length, 1);
  const port = createPortMock(BACKGROUND_BRIDGE_PORT_NAME);
  runtimeConnectListeners[0](port);

  port.emitMessage({
    requestId: "bridge-1",
    message: { type: "popup/get-connection-settings" },
  });

  await wait(0);

  assert.deepEqual(port.postedMessages, [
    {
      requestId: "bridge-1",
      ok: true,
      data: {
        primaryPort: 9150,
        fallbackPorts: [9152, 9154],
        authToken: "",
        pointerMode: "direct",
      },
    },
  ]);
});

test("BackgroundService creates a new session in a fresh window", async () => {
  const { chrome } = createChromeMock();
  const startedSessions = [];
  chrome.tabs.get = async (tabId) => {
    if (tabId === 9) {
      return {
        id: 9,
        windowId: 12,
        title: "Created",
        url: "https://example.com/created",
      };
    }

    return {
      id: 1,
      windowId: 2,
      title: "Example",
      url: "https://example.com",
    };
  };
  chrome.windows.create = async ({ url }) => {
    return {
      id: 12,
      tabs: [{ id: 9, windowId: 12, title: "Created", url }],
    };
  };

  const service = new BackgroundService({
    chromeApi: chrome,
    createController(options) {
      return {
        get recordSnapshot() {
          return options.record;
        },
        applyTransportUpdate() {},
        async connect() {
          startedSessions.push(options.record.sessionId);
        },
        async disconnect() {},
        recordCommandError() {},
        recordCommandSuccess() {},
        async refreshFromTab() {},
        async routeSocketRequest() {
          return null;
        },
      };
    },
  });

  const record = await service.createSession("https://example.com/created");

  assert.equal(startedSessions.length, 1);
  assert.equal(record.tabId, 9);
  assert.equal(record.windowId, 12);
  assert.equal(record.url, "https://example.com/created");
  assert.equal(record.status, "connecting");
});

test("BackgroundService waits for a created session tab to load its URL before connecting", async () => {
  const { chrome } = createChromeMock();
  const startedSessions = [];
  let createdTabReads = 0;

  chrome.tabs.get = async (tabId) => {
    if (tabId === 9) {
      createdTabReads += 1;
      if (createdTabReads === 1) {
        return {
          id: 9,
          windowId: 12,
          title: "",
          url: "",
          status: "loading",
        };
      }

      return {
        id: 9,
        windowId: 12,
        title: "Created",
        url: "https://example.com/created",
        status: "complete",
      };
    }

    return {
      id: 1,
      windowId: 2,
      title: "Example",
      url: "https://example.com",
      status: "complete",
    };
  };
  chrome.windows.create = async ({ url }) => {
    return {
      id: 12,
      tabs: [{ id: 9, windowId: 12, title: "", url, status: "loading" }],
    };
  };

  const service = new BackgroundService({
    chromeApi: chrome,
    createController(options) {
      return {
        get recordSnapshot() {
          return options.record;
        },
        applyTransportUpdate() {},
        async connect() {
          startedSessions.push(options.record.sessionId);
        },
        async disconnect() {},
        recordCommandError() {},
        recordCommandSuccess() {},
        async refreshFromTab() {},
        async routeSocketRequest() {
          return null;
        },
      };
    },
  });

  const record = await service.createSession("https://example.com/created");

  assert.equal(startedSessions.length, 1);
  assert.equal(record.url, "https://example.com/created");
  assert.ok(createdTabReads >= 2);
});

test("BackgroundService schedules an extension reload through the runtime bridge", async () => {
  const { chrome, reloadCalls } = createChromeMock();
  const service = new BackgroundService({
    chromeApi: chrome,
    setTimer(callback) {
      callback();
      return 1;
    },
  });

  const result = await service.handleRuntimeRequest({
    type: "background/reload-extension",
  });

  assert.deepEqual(result, { reloading: true });
  assert.equal(reloadCalls.length, 1);
});

test("BackgroundService reports extension health warnings when the connected server expects a different extension root", async () => {
  const { chrome } = createChromeMock();
  const service = new BackgroundService({
    chromeApi: chrome,
  });

  await service.handleRuntimeRequest({
    type: "background/update-server-metadata",
    payload: {
      serverVersion: "0.1.3",
      serverCwd: "/tmp/browsefleetmcp",
      expectedExtensionRoot: "/tmp/browsefleetmcp/extension-v2",
      wsPortCandidates: [9150],
      brokerPortCandidates: [9151],
      serverPid: 999,
      connectedAt: "2026-04-14T12:00:00.000Z",
    },
  });

  const status = await service.handleRuntimeRequest({
    type: "popup/get-extension-status",
  });

  assert.equal(status.extensionVersion, "0.0.2");
  assert.equal(status.serverMetadata.serverVersion, "0.1.3");
  assert.ok(Array.isArray(status.warnings));
});
