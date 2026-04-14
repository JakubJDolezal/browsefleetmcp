import test from "node:test";
import assert from "node:assert/strict";

import {
  FocusLock,
  socketRequestRequiresFocus,
} from "../dist/background/focus-lock.js";

test("FocusLock serializes concurrent focus-sensitive actions", async () => {
  const events = [];
  let releaseFirstAction;

  const focusLock = new FocusLock({
    windows: {
      async update(windowId, patch) {
        events.push(`window:${windowId}:${patch.focused}`);
      },
    },
    tabs: {
      async update(tabId, patch) {
        events.push(`tab:${tabId}:${patch.active}`);
      },
    },
  });

  const firstAction = focusLock.run(
    { sessionId: "session-1", windowId: 4, tabId: 1 },
    async () => {
      events.push("start:session-1");
      await new Promise((resolve) => {
        releaseFirstAction = () => {
          events.push("end:session-1");
          resolve();
        };
      });
    },
  );

  const secondAction = focusLock.run(
    { sessionId: "session-2", windowId: 5, tabId: 2 },
    async () => {
      events.push("start:session-2");
      events.push("end:session-2");
    },
  );

  const waitUntilStarted = async () => {
    const timeoutAt = Date.now() + 1_000;
    while (!events.includes("start:session-1")) {
      if (Date.now() >= timeoutAt) {
        throw new Error("Timed out waiting for the first action to start.");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  await waitUntilStarted();

  assert.equal(events[0], "window:4:true");
  assert.equal(events[1], "tab:1:true");
  assert.ok(events.includes("start:session-1"));
  assert.equal(events.includes("start:session-2"), false);

  releaseFirstAction();
  await Promise.all([firstAction, secondAction]);

  assert.deepEqual(events, [
    "window:4:true",
    "tab:1:true",
    "start:session-1",
    "end:session-1",
    "window:5:true",
    "tab:2:true",
    "start:session-2",
    "end:session-2",
  ]);
});

test("socketRequestRequiresFocus only marks focus-sensitive actions", () => {
  assert.equal(socketRequestRequiresFocus("browser_click"), true);
  assert.equal(socketRequestRequiresFocus("browser_drag"), true);
  assert.equal(socketRequestRequiresFocus("browser_hover"), true);
  assert.equal(socketRequestRequiresFocus("browser_press_key"), true);
  assert.equal(socketRequestRequiresFocus("browser_select_option"), true);
  assert.equal(socketRequestRequiresFocus("browser_type"), true);
  assert.equal(socketRequestRequiresFocus("browser_screen_screenshot"), false);

  assert.equal(socketRequestRequiresFocus("browser_snapshot"), false);
  assert.equal(socketRequestRequiresFocus("browser_navigate"), false);
  assert.equal(socketRequestRequiresFocus("browser_go_back"), false);
  assert.equal(socketRequestRequiresFocus("browser_go_forward"), false);
  assert.equal(socketRequestRequiresFocus("browser_wait"), false);
  assert.equal(socketRequestRequiresFocus("browser_screenshot"), false);
  assert.equal(socketRequestRequiresFocus("browser_get_console_logs"), false);
});
