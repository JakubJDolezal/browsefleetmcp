import test from "node:test";
import assert from "node:assert/strict";

import { SessionController } from "../dist/background/session-controller.js";

function createBaseRecord() {
  return {
    sessionId: "session-1",
    tabId: 1,
    windowId: 4,
    title: "Before",
    url: "https://before.test",
    status: "connected",
    connectedAt: "2026-04-10T12:00:00.000Z",
    updatedAt: "2026-04-10T12:00:00.000Z",
  };
}

function createConnectionSettings() {
  return {
    primaryPort: 9150,
    fallbackPorts: [],
  };
}

test("SessionController does not refresh the tab for getTitle", async () => {
  let tabsGetCount = 0;
  globalThis.chrome = {
    tabs: {
      async get() {
        tabsGetCount += 1;
        return createBaseRecord();
      },
    },
  };

  const controller = new SessionController({
    record: createBaseRecord(),
    getConnectionSettings: async () => createConnectionSettings(),
    onUpdate() {},
    onDisposed() {},
  });

  const title = await controller.routeSocketRequest("getTitle");

  assert.equal(title, "Before");
  assert.equal(tabsGetCount, 0);
});

test("SessionController skips record updates when tab state is unchanged", async () => {
  let updateCount = 0;
  globalThis.chrome = {
    tabs: {
      async get() {
        return createBaseRecord();
      },
    },
  };

  const controller = new SessionController({
    record: createBaseRecord(),
    getConnectionSettings: async () => createConnectionSettings(),
    onUpdate() {
      updateCount += 1;
    },
    onDisposed() {},
  });

  await controller.refreshFromTab();

  assert.equal(updateCount, 0);
});

test("SessionController refreshes record state after navigation completes", async () => {
  const listeners = new Set();
  const tabState = {
    id: 1,
    windowId: 4,
    title: "Before",
    url: "https://before.test",
    status: "loading",
  };
  let tabsGetCount = 0;
  const updates = [];

  globalThis.chrome = {
    tabs: {
      async get(tabId) {
        assert.equal(tabId, 1);
        tabsGetCount += 1;
        return { ...tabState };
      },
      async update(tabId, patch) {
        assert.equal(tabId, 1);
        tabState.url = patch.url;
        tabState.title = "After";
        tabState.status = "loading";
        setTimeout(() => {
          tabState.status = "complete";
          for (const listener of listeners) {
            void listener(tabId, { status: "complete", url: tabState.url });
          }
        }, 0);
        return { ...tabState };
      },
      async sendMessage(_tabId, message) {
        if (message.type === "ping") {
          return true;
        }
        if (message.type === "waitForStableDOM") {
          return null;
        }
        throw new Error(`Unexpected message type ${message.type}`);
      },
      onUpdated: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
    scripting: {
      async executeScript() {
        return null;
      },
    },
  };

  const controller = new SessionController({
    record: createBaseRecord(),
    getConnectionSettings: async () => createConnectionSettings(),
    onUpdate(record) {
      updates.push(record);
    },
    onDisposed() {},
  });

  await controller.routeSocketRequest("browser_navigate", {
    url: "https://after.test",
  });

  assert.ok(tabsGetCount >= 3);
  assert.equal(controller.recordSnapshot.url, "https://after.test");
  assert.equal(controller.recordSnapshot.title, "After");
  assert.ok(
    updates.some((record) => record.url === "https://after.test"),
  );
});

test("SessionController runs focus-sensitive keyboard input through the focus lock", async () => {
  const navigationListeners = new Set();
  const debuggerCommands = [];
  let focusLockCalls = 0;

  globalThis.chrome = {
    debugger: {
      async attach() {
        return null;
      },
      async detach() {
        return null;
      },
      async sendCommand(_target, command, params) {
        debuggerCommands.push({ command, params });
        return {};
      },
    },
    tabs: {
      async sendMessage(_tabId, message) {
        if (message.type === "ping") {
          return true;
        }
        if (message.type === "waitForStableDOM") {
          return null;
        }
        throw new Error(`Unexpected message type ${message.type}`);
      },
    },
    scripting: {
      async executeScript() {
        return null;
      },
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener(listener) {
          navigationListeners.add(listener);
        },
        removeListener(listener) {
          navigationListeners.delete(listener);
        },
      },
    },
  };

  const controller = new SessionController({
    record: createBaseRecord(),
    getConnectionSettings: async () => createConnectionSettings(),
    onUpdate() {},
    onDisposed() {},
    runWithFocusLock(_record, action) {
      focusLockCalls += 1;
      return action();
    },
  });

  await controller.routeSocketRequest("browser_press_key", { key: "Enter" });

  assert.equal(focusLockCalls, 1);
  assert.ok(
    debuggerCommands.some(
      ({ command }) => command === "Input.dispatchKeyEvent",
    ),
  );
});
