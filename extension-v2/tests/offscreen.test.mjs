import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureOffscreenDocument,
  sendOffscreenRequest,
} from "../dist/background/offscreen.js";

function createChromeMock({
  contexts = [{}],
  sendMessage,
} = {}) {
  const createDocumentCalls = [];
  const closeDocumentCalls = [];

  return {
    createDocumentCalls,
    closeDocumentCalls,
    chrome: {
      runtime: {
        getURL(path) {
          return `chrome-extension://test/${path}`;
        },
        async getContexts() {
          return contexts;
        },
        async sendMessage(message) {
          return await sendMessage(message);
        },
      },
      offscreen: {
        async createDocument(options) {
          createDocumentCalls.push(options);
        },
        async closeDocument() {
          closeDocumentCalls.push(true);
        },
      },
    },
  };
}

test("ensureOffscreenDocument recreates an unresponsive offscreen document", async () => {
  let statusAttempts = 0;
  const { chrome, createDocumentCalls, closeDocumentCalls } = createChromeMock({
    async sendMessage(message) {
      if (message.type !== "offscreen/get-status") {
        throw new Error(`Unexpected message ${message.type}`);
      }

      statusAttempts += 1;
      if (statusAttempts === 1) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }

      return {
        activeSessionCount: 0,
        keepAlive: true,
      };
    },
  });

  await ensureOffscreenDocument(chrome);

  assert.equal(statusAttempts, 2);
  assert.equal(closeDocumentCalls.length, 1);
  assert.equal(createDocumentCalls.length, 1);
});

test("sendOffscreenRequest recreates an unresponsive offscreen document before forwarding the request", async () => {
  const observedTypes = [];
  let statusAttempts = 0;
  const { chrome, createDocumentCalls, closeDocumentCalls } = createChromeMock({
    async sendMessage(message) {
      observedTypes.push(message.type);

      if (message.type === "offscreen/get-status") {
        statusAttempts += 1;
        if (statusAttempts === 1) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }

        return {
          activeSessionCount: 0,
          keepAlive: true,
        };
      }

      if (message.type === "offscreen/connect-session") {
        return null;
      }

      throw new Error(`Unexpected message ${message.type}`);
    },
  });

  await sendOffscreenRequest(
    {
      type: "offscreen/connect-session",
      payload: { sessionId: "session-1" },
    },
    chrome,
  );

  assert.deepEqual(observedTypes, [
    "offscreen/get-status",
    "offscreen/get-status",
    "offscreen/connect-session",
  ]);
  assert.equal(closeDocumentCalls.length, 1);
  assert.equal(createDocumentCalls.length, 1);
});
