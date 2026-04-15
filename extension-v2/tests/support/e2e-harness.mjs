import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WebSocketServer } from "ws";

import { loadPlaywright } from "./playwright-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "../..");
const OUTPUT_DIR = path.join(EXTENSION_ROOT, "output", "playwright");
const execFileAsync = promisify(execFile);

const E2E_POINTER_MODE =
  process.env.BROWSEFLEET_E2E_POINTER_MODE === "human" ? "human" : "direct";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPlatformBrowserCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  if (process.platform === "win32") {
    return [
      path.join(
        process.env.PROGRAMFILES ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "Chromium",
        "Application",
        "chrome.exe",
      ),
    ].filter(Boolean);
  }

  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

async function resolveBrowserExecutable(chromium) {
  const explicitPath = process.env.BROWSEFLEET_CHROME_EXECUTABLE;
  if (explicitPath) {
    if (!(await fileExists(explicitPath))) {
      throw new Error(
        `BROWSEFLEET_CHROME_EXECUTABLE is set but does not exist: ${explicitPath}`,
      );
    }
    return explicitPath;
  }

  const bundledExecutable =
    typeof chromium.executablePath === "function"
      ? chromium.executablePath()
      : undefined;
  if (bundledExecutable && (await fileExists(bundledExecutable))) {
    return bundledExecutable;
  }

  for (const candidate of getPlatformBrowserCandidates()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      "Unable to locate a Chromium executable for the E2E extension test.",
      "Install Playwright browsers with `npx playwright install chromium`,",
      "or set BROWSEFLEET_CHROME_EXECUTABLE to a Chrome/Chromium binary.",
    ].join(" "),
  );
}

function createPageOneHtml(origin, label = "default") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Page One</title>
    <style>
      body { font-family: sans-serif; margin: 24px; }
      .row { margin: 12px 0; }
      #hover-target, #drag-source, #drop-zone {
        border: 1px solid #333;
        display: inline-block;
        padding: 12px;
        margin-right: 12px;
      }
    </style>
  </head>
  <body>
    <h1>Page One</h1>
    <p id="page-label">Session ${label}</p>
    <div class="row">
      <button id="increment">Increment counter</button>
      <span id="click-status">not clicked</span>
    </div>
    <div class="row">
      <input id="name-input" placeholder="Your name" />
      <span id="keypress-status">no keypress</span>
    </div>
    <div class="row">
      <input id="date-input" type="date" aria-label="Start date" />
      <span id="date-status">no date</span>
    </div>
    <div class="row">
      <select id="color-select" aria-label="Color selector">
        <option value="red">Red</option>
        <option value="blue">Blue</option>
      </select>
      <span id="select-status">red</span>
    </div>
    <div class="row">
      <progress id="sync-progress" role="progressbar" value="70" max="100"></progress>
    </div>
    <div class="row">
      <div id="hover-target" role="button" aria-label="Hover target">Hover target</div>
      <span id="hover-status">not hovered</span>
    </div>
    <div class="row">
      <div id="drag-source" draggable="true" role="button" aria-label="Drag source">Drag source</div>
      <div id="drop-zone" role="button" aria-label="Drop zone">Drop zone</div>
      <span id="drag-status">not dropped</span>
    </div>
    <div class="row">
      <a id="next-link" href="${origin}/page2">Go to page two</a>
    </div>
    <div class="row">
      <button id="busy-button">Busy action</button>
      <span id="busy-status">idle</span>
    </div>
    <div class="row">
      <span id="focus-status">unknown</span>
      <span id="visibility-status">unknown</span>
    </div>

    <script>
      console.log("page-one-ready");

      const incrementButton = document.getElementById("increment");
      const clickStatus = document.getElementById("click-status");
      const input = document.getElementById("name-input");
      const keypressStatus = document.getElementById("keypress-status");
      const dateInput = document.getElementById("date-input");
      const dateStatus = document.getElementById("date-status");
      const select = document.getElementById("color-select");
      const selectStatus = document.getElementById("select-status");
      const hoverTarget = document.getElementById("hover-target");
      const hoverStatus = document.getElementById("hover-status");
      const dragSource = document.getElementById("drag-source");
      const dropZone = document.getElementById("drop-zone");
      const dragStatus = document.getElementById("drag-status");
      const busyButton = document.getElementById("busy-button");
      const busyStatus = document.getElementById("busy-status");
      const focusStatus = document.getElementById("focus-status");
      const visibilityStatus = document.getElementById("visibility-status");

      const testState = {
        label: ${JSON.stringify(label)},
        focusEventCount: 0,
        blurEventCount: 0,
        lastFocusAt: null,
        lastBlurAt: null,
        lastVisibilityState: document.visibilityState,
        busyStartedAt: null,
        busyDoneAt: null,
        nameKeydownCount: 0,
        dateKeydownCount: 0
      };
      window.__browseFleetTestState = testState;

      const syncFocusStatus = () => {
        focusStatus.textContent = document.hasFocus() ? "focused" : "blurred";
        visibilityStatus.textContent = document.visibilityState;
        testState.lastVisibilityState = document.visibilityState;
      };

      window.addEventListener("focus", () => {
        testState.focusEventCount += 1;
        testState.lastFocusAt = Date.now();
        syncFocusStatus();
      });

      window.addEventListener("blur", () => {
        testState.blurEventCount += 1;
        testState.lastBlurAt = Date.now();
        syncFocusStatus();
      });

      document.addEventListener("visibilitychange", () => {
        syncFocusStatus();
      });

      if (document.hasFocus()) {
        testState.focusEventCount += 1;
        testState.lastFocusAt = Date.now();
      }
      syncFocusStatus();

      let clickCount = 0;
      incrementButton.addEventListener("click", () => {
        clickCount += 1;
        clickStatus.textContent = "clicked " + clickCount;
      });

      input.addEventListener("keydown", (event) => {
        testState.nameKeydownCount += 1;
        if (event.key === "Enter") {
          keypressStatus.textContent = "enter:" + input.value;
        }
      });

      dateInput.addEventListener("keydown", () => {
        testState.dateKeydownCount += 1;
      });

      dateInput.addEventListener("change", () => {
        dateStatus.textContent = dateInput.value || "no date";
      });

      select.addEventListener("change", () => {
        selectStatus.textContent = select.value;
      });

      hoverTarget.addEventListener("mouseenter", () => {
        hoverStatus.textContent = "hovered";
      });

      dragSource.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", "Drag source");
      });

      dropZone.addEventListener("dragover", (event) => {
        event.preventDefault();
      });

      dropZone.addEventListener("drop", (event) => {
        event.preventDefault();
        dragStatus.textContent = "dropped:" + event.dataTransfer.getData("text/plain");
      });

      busyButton.addEventListener("click", () => {
        let ticks = 0;
        testState.busyStartedAt = Date.now();
        testState.busyDoneAt = null;
        busyStatus.textContent = "busy:0";

        const intervalId = setInterval(() => {
          ticks += 1;
          busyStatus.textContent = "busy:" + ticks;
          if (ticks >= 12) {
            clearInterval(intervalId);
            testState.busyDoneAt = Date.now();
            busyStatus.textContent = "busy done";
          }
        }, 100);
      });
    </script>
  </body>
</html>`;
}

const PAGE_TWO_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Page Two</title>
  </head>
  <body>
    <h1>Page Two</h1>
    <p id="page-two-status">ready</p>
    <script>console.log("page-two-ready");</script>
  </body>
</html>`;

async function startHttpServer() {
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const requestUrl = new URL(request.url ?? "/", origin);
    const label = requestUrl.searchParams.get("label") ?? "default";

    if (requestUrl.pathname === "/page2") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE_TWO_HTML);
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(createPageOneHtml(origin, label));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessesMatching(pattern) {
  try {
    if (process.platform === "win32") {
      const escapedPattern = pattern.replace(/'/g, "''");
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        [
          "$pattern = '*' + '",
          escapedPattern,
          "' + '*'",
          "Get-CimInstance Win32_Process |",
          "Where-Object { $_.CommandLine -like $pattern } |",
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        ].join(" "),
      ]);
      return;
    }

    await execFileAsync("pkill", ["-f", pattern]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      return;
    }
    throw error;
  }
}

async function closeContextSafely(context, userDataDir, timeoutMs = 10_000) {
  if (!context) {
    return;
  }

  let timeoutId = 0;
  const closePromise = context.close();
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Timed out closing browser context."));
    }, timeoutMs);
  });

  try {
    await Promise.race([closePromise, timeoutPromise]);
  } catch {
    await terminateProcessesMatching(userDataDir);
    await wait(1_000);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function startSocketServer() {
  const connections = [];
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
  });
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      wss.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      wss.off("error", handleError);
      resolve();
    };
    wss.once("error", handleError);
    wss.once("listening", handleListening);
  });

  wss.on("connection", (socket, request) => {
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message?.type !== "heartbeat" || typeof message.id !== "string") {
        return;
      }

      socket.send(
        JSON.stringify({
          id: `heartbeat-ack-${message.id}`,
          type: "heartbeatAck",
          payload: {
            requestId: message.id,
            receivedAt: new Date().toISOString(),
          },
        }),
      );
    });
    connections.push({ socket, request });
  });

  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test socket server port.");
  }

  return {
    port: address.port,
    async waitForConnections(count, timeoutMs = 15_000) {
      return await waitFor(
        async () => (connections.length >= count ? [...connections] : undefined),
        `${count} socket connections`,
        timeoutMs,
      );
    },
    async waitForSession(sessionId, timeoutMs = 15_000) {
      return await waitFor(
        async () =>
          connections.find((connection) => {
            const requestUrl = new URL(connection.request.url, "ws://127.0.0.1");
            return requestUrl.searchParams.get("sessionId") === sessionId;
          }),
        `socket session ${sessionId}`,
        timeoutMs,
      );
    },
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export function findRef(snapshot, role, name) {
  const quotedName = JSON.stringify(name);
  const line = snapshot
    .split("\n")
    .find((candidate) => candidate.startsWith(`- ${role}`) && candidate.includes(quotedName));

  assert.ok(line, `Missing ${role} "${name}" in snapshot.\n${snapshot}`);
  const match = line.match(/\[ref=([^\]]+)\]/);
  assert.ok(match, `Missing ref in snapshot line: ${line}`);
  return match[1];
}

export async function getRefs(socketClient, refsByName) {
  const snapshot = await socketClient.request("browser_snapshot", {});
  return Object.fromEntries(
    Object.entries(refsByName).map(([key, [role, name]]) => [
      key,
      findRef(snapshot, role, name),
    ]),
  );
}

export async function waitFor(condition, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await condition();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

function createSocketClient(socket) {
  let nextId = 0;

  return {
    async request(type, payload, timeoutMs = 15_000) {
      const id = `req-${++nextId}`;

      return await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          socket.off("message", handleMessage);
          reject(new Error(`Timed out waiting for socket response to ${type}.`));
        }, timeoutMs);

        const handleMessage = (raw) => {
          const message = JSON.parse(String(raw));
          if (message?.type !== "messageResponse") {
            return;
          }

          if (message.payload?.requestId !== id) {
            return;
          }

          clearTimeout(timeoutId);
          socket.off("message", handleMessage);

          if (message.payload.error) {
            reject(new Error(message.payload.error));
            return;
          }

          resolve(message.payload.result);
        };

        socket.on("message", handleMessage);
        socket.send(JSON.stringify({ id, type, payload }));
      });
    },
  };
}

async function waitForSocketClose(socket, timeoutMs = 10_000) {
  if (socket.readyState === socket.CLOSED) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.off("close", handleClose);
      reject(new Error("Timed out waiting for the session socket to close."));
    }, timeoutMs);

    const handleClose = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    socket.once("close", handleClose);
  });
}

async function resolveExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      timeout: 15_000,
    });
  }

  return new URL(serviceWorker.url()).host;
}

async function connectTabFromPopup(popupPage, targetUrl) {
  return await popupPage.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find((tab) => tab.url === url);
    if (!targetTab?.id) {
      throw new Error(`Unable to find tab for ${url}`);
    }

    return await chrome.runtime.sendMessage({
      type: "popup/connect-tab",
      payload: { tabId: targetTab.id },
    });
  }, targetUrl);
}

async function listSessionsFromPopup(popupPage) {
  return await popupPage.evaluate(async () => {
    return await chrome.runtime.sendMessage({ type: "popup/list-sessions" });
  });
}

async function setConnectionSettingsFromPopup(
  popupPage,
  primaryPort,
  pointerMode = E2E_POINTER_MODE,
) {
  const response = await popupPage.evaluate(
    async ({ primaryPort, pointerMode }) => {
      return await chrome.runtime.sendMessage({
        type: "popup/update-connection-settings",
        payload: {
          primaryPort,
          fallbackPorts: [primaryPort],
          authToken: "",
          pointerMode,
        },
      });
    },
    { primaryPort, pointerMode },
  );
  assert.equal(response?.ok, true);
}

async function waitForPopupSessions(popupPage, count) {
  return await waitFor(
    async () => {
      const response = await listSessionsFromPopup(popupPage);
      return response.ok && response.data.length === count
        ? response.data
        : undefined;
    },
    `popup session count ${count}`,
  );
}

export async function readPageTestState(page) {
  return await page.evaluate(() => {
    const state = window.__browseFleetTestState ?? {};
    return {
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      focusEventCount: state.focusEventCount ?? 0,
      blurEventCount: state.blurEventCount ?? 0,
      lastFocusAt: state.lastFocusAt ?? null,
      lastBlurAt: state.lastBlurAt ?? null,
      busyStartedAt: state.busyStartedAt ?? null,
      busyDoneAt: state.busyDoneAt ?? null,
      nameKeydownCount: state.nameKeydownCount ?? 0,
      dateKeydownCount: state.dateKeydownCount ?? 0,
      label: state.label ?? "unknown",
    };
  });
}

export async function waitForPageFocusState(page, focused, description) {
  return await waitFor(
    async () => {
      const state = await readPageTestState(page);
      return state.hasFocus === focused ? state : undefined;
    },
    description,
  );
}

export async function waitForPageText(
  page,
  selector,
  expectedText,
  description,
  timeoutMs,
) {
  return await waitFor(
    async () =>
      (await page.textContent(selector)) === expectedText ? expectedText : undefined,
    description,
    timeoutMs,
  );
}

export async function assertActionBringsFocus({
  actingPage,
  otherPage,
  description,
  runAction,
  verify,
}) {
  await otherPage.bringToFront();
  await waitForPageFocusState(otherPage, true, `${description} initial focus`);
  await runAction();
  await waitForPageFocusState(actingPage, true, `${description} acting focus`);
  if (verify) {
    await verify();
  }
}

export async function assertActionPreservesBackgroundFocus({
  actingPage,
  actingSession,
  otherSession,
  otherPage,
  description,
  runAction,
  verify,
}) {
  await otherPage.bringToFront();
  await waitForPageFocusState(otherPage, true, `${description} initial focus`);
  const result = await runAction();
  try {
    await waitForPageFocusState(otherPage, true, `${description} preserved focus`);
  } catch (error) {
    const actingState = await readPageTestState(actingPage);
    const otherState = await readPageTestState(otherPage);
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `Acting page state after ${description}: ${JSON.stringify(actingState)}`,
        `Background page state after ${description}: ${JSON.stringify(otherState)}`,
        `Expected preserved session: ${JSON.stringify({
          windowId: otherSession.windowId,
          tabId: otherSession.tabId,
          url: otherSession.url,
        })}`,
        `Acting session: ${JSON.stringify({
          windowId: actingSession.windowId,
          tabId: actingSession.tabId,
          url: actingSession.url,
        })}`,
      ].join("\n"),
    );
  }
  if (verify) {
    await verify(result);
  }
  return result;
}

export async function captureFailureArtifacts(pages, name) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const [index, page] of pages.entries()) {
    if (!page || page.isClosed()) {
      continue;
    }

    const suffix = index === 0 ? "" : `-${index + 1}`;
    try {
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `${name}${suffix}.png`),
        fullPage: true,
        timeout: 5_000,
      });
    } catch {
      // Best-effort failure capture should not hide the original test error.
    }

    try {
      await writeFile(
        path.join(OUTPUT_DIR, `${name}${suffix}.html`),
        await page.content(),
        "utf8",
      );
    } catch {
      // Ignore secondary artifact capture failures.
    }
  }
}

export class ExtensionE2EHarness {
  static async launch() {
    const { chromium } = await loadPlaywright();
    const httpServer = await startHttpServer();
    const socketServer = await startSocketServer();
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "browsefleetmcp-extension-e2e-"),
    );
    const executablePath = await resolveBrowserExecutable(chromium);
    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`,
    ];
    if (process.platform === "linux" && process.env.CI) {
      launchArgs.push("--no-sandbox", "--disable-dev-shm-usage");
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      viewport: { width: 1400, height: 1000 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: launchArgs,
    });
    const extensionId = await resolveExtensionId(context);
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await setConnectionSettingsFromPopup(popupPage, socketServer.port);

    return new ExtensionE2EHarness({
      context,
      httpServer,
      popupPage,
      socketServer,
      userDataDir,
    });
  }

  constructor({ context, httpServer, popupPage, socketServer, userDataDir }) {
    this.context = context;
    this.httpServer = httpServer;
    this.popupPage = popupPage;
    this.socketServer = socketServer;
    this.userDataDir = userDataDir;
    this.primaryPageConsumed = false;
    this.connections = [];
  }

  get origin() {
    return this.httpServer.origin;
  }

  get connectedPages() {
    return this.connections.map((entry) => entry.page);
  }

  async openConnectedPage(label = "default") {
    const reusablePage = this.context
      .pages()
      .find(
        (candidate) =>
          candidate !== this.popupPage &&
          !this.connections.some((entry) => entry.page === candidate),
      );
    const page =
      !this.primaryPageConsumed
        ? reusablePage ?? (await this.context.newPage())
        : await this.context.newPage();
    this.primaryPageConsumed = true;

    const url =
      label === "default"
        ? `${this.httpServer.origin}/page1`
        : `${this.httpServer.origin}/page1?label=${encodeURIComponent(label)}`;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");

    return await this.connectPage(page, url);
  }

  async connectPage(page, url) {
    const connectResponse = await connectTabFromPopup(this.popupPage, url);
    assert.equal(connectResponse.ok, true);

    const connection = await this.socketServer.waitForSession(
      connectResponse.data.sessionId,
    );
    const sessions = await waitForPopupSessions(
      this.popupPage,
      this.connections.length + 1,
    );
    const session = sessions.find(
      (candidate) => candidate.sessionId === connectResponse.data.sessionId,
    );
    assert.ok(session, `Missing popup session for ${url}`);

    const entry = {
      page,
      url,
      session,
      connection,
      socketClient: createSocketClient(connection.socket),
    };
    this.connections.push(entry);
    return entry;
  }

  async listSessions() {
    const response = await listSessionsFromPopup(this.popupPage);
    assert.equal(response?.ok, true);
    return response.data;
  }

  async captureFailureArtifacts(name) {
    await captureFailureArtifacts(this.connectedPages, name);
  }

  async close() {
    try {
      if (!this.popupPage.isClosed()) {
        const sessions = await this.listSessions().catch(() => []);
        const sessionIds = sessions.map((session) => session.sessionId);
        const socketClosedPromises = this.connections.map((entry) =>
          waitForSocketClose(entry.connection.socket).catch(() => undefined),
        );

        if (sessionIds.length > 0) {
          await this.popupPage
            .evaluate(async (ids) => {
              for (const sessionId of ids) {
                await chrome.runtime.sendMessage({
                  type: "popup/disconnect-session",
                  payload: { sessionId },
                });
              }
            }, sessionIds)
            .catch(() => undefined);
          await this.popupPage
            .waitForFunction(() => {
              return document.getElementById("session-count")?.textContent === "0";
            })
            .catch(() => undefined);
          await Promise.all(socketClosedPromises);
        }

        await this.popupPage.close().catch(() => undefined);
      }
    } finally {
      await closeContextSafely(this.context, this.userDataDir);
      await this.socketServer.close();
      await this.httpServer.close();
      await rm(this.userDataDir, { recursive: true, force: true });
    }
  }
}
