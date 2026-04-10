import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundService } from "../dist/background/service.js";
import {
  CONNECTION_SETTINGS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
} from "../dist/shared/protocol.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChromeMock() {
  const setCalls = [];

  return {
    setCalls,
    chrome: {
      runtime: {
        onMessage: {
          addListener() {},
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
  });

  assert.deepEqual(settings, {
    primaryPort: 9200,
    fallbackPorts: [9202, 9204],
  });
  assert.deepEqual(
    setCalls[0][CONNECTION_SETTINGS_STORAGE_KEY],
    settings,
  );
});
