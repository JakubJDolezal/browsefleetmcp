import test from "node:test";
import assert from "node:assert/strict";

import { withPossibleNavigation } from "../dist/background/runtime.js";

test("withPossibleNavigation catches navigation that starts right after the action resolves", async () => {
  const listeners = new Set();

  globalThis.chrome = {
    webNavigation: {
      onBeforeNavigate: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
  };

  const navigated = await withPossibleNavigation(7, async () => {
    setTimeout(() => {
      for (const listener of listeners) {
        void listener({ tabId: 7, frameId: 0 });
      }
    }, 0);
  });

  assert.equal(navigated, true);
});

test("withPossibleNavigation ignores unrelated navigation events", async () => {
  const listeners = new Set();

  globalThis.chrome = {
    webNavigation: {
      onBeforeNavigate: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
  };

  const navigated = await withPossibleNavigation(7, async () => {
    setTimeout(() => {
      for (const listener of listeners) {
        void listener({ tabId: 8, frameId: 0 });
        void listener({ tabId: 7, frameId: 1 });
      }
    }, 0);
  });

  assert.equal(navigated, false);
});
