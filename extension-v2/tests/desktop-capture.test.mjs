import test from "node:test";
import assert from "node:assert/strict";

import {
  TEST_DESKTOP_CAPTURE_STORAGE_KEY,
} from "../dist/shared/protocol.js";
import { captureDesktopScreenshot } from "../dist/background/desktop-capture.js";

test("captureDesktopScreenshot returns the test override without opening the picker", async () => {
  let chooseDesktopMediaCalls = 0;
  let offscreenCreateCalls = 0;
  let runtimeSendMessageCalls = 0;

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          assert.equal(key, TEST_DESKTOP_CAPTURE_STORAGE_KEY);
          return {
            [TEST_DESKTOP_CAPTURE_STORAGE_KEY]: "iVBOR-test-override",
          };
        },
      },
    },
    desktopCapture: {
      chooseDesktopMedia() {
        chooseDesktopMediaCalls += 1;
      },
    },
    offscreen: {
      async createDocument() {
        offscreenCreateCalls += 1;
      },
      async closeDocument() {
        return undefined;
      },
    },
    runtime: {
      async sendMessage() {
        runtimeSendMessageCalls += 1;
        return undefined;
      },
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
      async getContexts() {
        return [];
      },
    },
  };

  const capture = await captureDesktopScreenshot();

  assert.equal(capture, "iVBOR-test-override");
  assert.equal(chooseDesktopMediaCalls, 0);
  assert.equal(offscreenCreateCalls, 0);
  assert.equal(runtimeSendMessageCalls, 0);
});
