import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createClassList() {
  const values = new Set();
  return {
    add(...tokens) {
      for (const token of tokens) {
        values.add(token);
      }
    },
    remove(...tokens) {
      for (const token of tokens) {
        values.delete(token);
      }
    },
    contains(token) {
      return values.has(token);
    },
  };
}

class FakeElement {
  constructor(tagName, id = "") {
    this.tagName = tagName;
    this.id = id;
    this.children = [];
    this.className = "";
    this.classList = createClassList();
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.type = "";
    this.listeners = new Map();
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    if (value === "") {
      this.textContent = "";
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) {
      this.appendChild(child);
    }
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
}

function createPopupDom() {
  const elements = new Map();
  const ids = [
    "error",
    "health-summary",
    "health-warnings",
    "current-tab",
    "connect-current",
    "refresh",
    "save-ports",
    "primary-port",
    "fallback-ports",
    "auth-token",
    "pointer-mode",
    "session-count",
    "sessions",
  ];

  for (const id of ids) {
    elements.set(id, new FakeElement("div", id));
  }

  return {
    elements,
    document: {
      getElementById(id) {
        return elements.get(id) ?? null;
      },
      createElement(tagName) {
        return new FakeElement(tagName);
      },
    },
  };
}

async function loadPopup(sendMessage) {
  const { elements, document } = createPopupDom();

  globalThis.document = document;
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        return await sendMessage(message);
      },
    },
    storage: {
      onChanged: {
        addListener() {},
      },
    },
  };

  const popupModuleUrl =
    pathToFileURL(
      path.resolve("dist/popup/index.js"),
    ).href + `?case=${Math.random()}`;
  await import(popupModuleUrl);
  await Promise.resolve();
  await Promise.resolve();

  return elements;
}

function createCurrentTabResponse() {
  return {
    ok: true,
    data: {
      tabId: 11,
      title: "Example",
      url: "https://example.com",
      connectable: true,
    },
  };
}

function createSessionsResponse() {
  return {
    ok: true,
    data: [],
  };
}

function createConnectionSettingsResponse() {
  return {
    ok: true,
    data: {
      primaryPort: 9150,
      fallbackPorts: [9152, 9154],
      authToken: "",
      pointerMode: "direct",
    },
  };
}

test("popup shows a helpful health error when the background returns a null health payload", async () => {
  const elements = await loadPopup(async (message) => {
    switch (message.type) {
      case "popup/get-current-tab":
        return createCurrentTabResponse();
      case "popup/list-sessions":
        return createSessionsResponse();
      case "popup/get-connection-settings":
        return createConnectionSettingsResponse();
      case "popup/get-extension-status":
        return { ok: true, data: null };
      default:
        throw new Error(`Unexpected popup request ${message.type}`);
    }
  });

  assert.equal(
    elements.get("health-summary").children[0].textContent,
    "Extension health unavailable.",
  );
  assert.match(
    elements.get("error").textContent,
    /Extension health is unavailable/,
  );
});

test("popup surfaces a malformed runtime response instead of crashing", async () => {
  const elements = await loadPopup(async (message) => {
    switch (message.type) {
      case "popup/get-current-tab":
        return createCurrentTabResponse();
      case "popup/list-sessions":
        return createSessionsResponse();
      case "popup/get-connection-settings":
        return createConnectionSettingsResponse();
      case "popup/get-extension-status":
        return null;
      default:
        throw new Error(`Unexpected popup request ${message.type}`);
    }
  });

  assert.equal(
    elements.get("health-summary").children[0].textContent,
    "Extension health unavailable.",
  );
  assert.match(
    elements.get("error").textContent,
    /Invalid response for popup\/get-extension-status/,
  );
});
