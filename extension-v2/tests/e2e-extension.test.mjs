import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WebSocketServer } from "ws";

import { DEFAULT_WS_PORT } from "../dist/shared/protocol.js";
import { loadPlaywright } from "./support/playwright-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(EXTENSION_ROOT, "output", "playwright");
const execFileAsync = promisify(execFile);

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
    typeof chromium.executablePath === "function" ? chromium.executablePath() : undefined;
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

function createPageOneHtml(origin) {
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

      let clickCount = 0;
      incrementButton.addEventListener("click", () => {
        clickCount += 1;
        clickStatus.textContent = "clicked " + clickCount;
      });

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          keypressStatus.textContent = "enter:" + input.value;
        }
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
    if (request.url === "/page2") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE_TWO_HTML);
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(createPageOneHtml(origin));
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

async function wait(ms) {
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
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: DEFAULT_WS_PORT,
  });
  const connectionPromise = new Promise((resolve) => {
    wss.once("connection", (socket, request) => {
      resolve({ socket, request });
    });
  });

  return {
    connectionPromise,
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

function findRef(snapshot, role, name) {
  const quotedName = JSON.stringify(name);
  const line = snapshot
    .split("\n")
    .find((candidate) => candidate.startsWith(`- ${role}`) && candidate.includes(quotedName));

  assert.ok(line, `Missing ${role} "${name}" in snapshot.\n${snapshot}`);
  const match = line.match(/\[ref=([^\]]+)\]/);
  assert.ok(match, `Missing ref in snapshot line: ${line}`);
  return match[1];
}

async function waitFor(condition, description, timeoutMs = 10_000) {
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

function waitForSocketClose(socket, timeoutMs = 10_000) {
  if (socket.readyState === socket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
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

async function captureFailureArtifacts(page, name) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${name}.png`),
    fullPage: true,
  });
  await writeFile(
    path.join(OUTPUT_DIR, `${name}.html`),
    await page.content(),
    "utf8",
  );
}

test(
  "extension-v2 E2E smoke test",
  { timeout: 180_000 },
  async (t) => {
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

    let context;
    let page;

    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath,
        headless: false,
        viewport: { width: 1400, height: 1000 },
        ignoreDefaultArgs: ["--disable-extensions"],
        args: launchArgs,
      });

      page =
        context.pages()[0] ??
        (await context.newPage());

      await page.goto(`${httpServer.origin}/page1`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle");

      const extensionId = await resolveExtensionId(context);
      const popupPage = await context.newPage();
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

      const connectResponse = await connectTabFromPopup(
        popupPage,
        `${httpServer.origin}/page1`,
      );
      assert.equal(connectResponse.ok, true);

      const { socket, request } = await socketServer.connectionPromise;
      const requestUrl = new URL(request.url, "ws://127.0.0.1");
      assert.ok(requestUrl.searchParams.get("sessionId"));
      assert.ok(requestUrl.searchParams.get("tabId"));
      assert.ok(requestUrl.searchParams.get("windowId"));

      const socketClient = createSocketClient(socket);

      await waitFor(
        async () => {
          const sessionsResponse = await listSessionsFromPopup(popupPage);
          return sessionsResponse.ok && sessionsResponse.data.length === 1
            ? sessionsResponse.data
            : undefined;
        },
        "popup session list",
      );

      await popupPage.waitForSelector("#session-count");
      await popupPage.waitForFunction(() => {
        return document.getElementById("session-count")?.textContent === "1";
      });

      assert.equal(await socketClient.request("getTitle", {}), "Page One");
      assert.equal(
        await socketClient.request("getUrl", {}),
        `${httpServer.origin}/page1`,
      );

      const snapshot = await socketClient.request("browser_snapshot", {});
      const incrementRef = findRef(snapshot, "button", "Increment counter");
      const inputRef = findRef(snapshot, "textbox", "Your name");
      const dateRef = findRef(snapshot, "textbox", "Start date");
      const selectRef = findRef(snapshot, "combobox", "Color selector");
      const hoverRef = findRef(snapshot, "button", "Hover target");
      const dragSourceRef = findRef(snapshot, "button", "Drag source");
      const dropZoneRef = findRef(snapshot, "button", "Drop zone");
      const linkRef = findRef(snapshot, "link", "Go to page two");

      await socketClient.request("browser_hover", { ref: hoverRef });
      await page.waitForSelector("#hover-status");
      assert.equal(await page.textContent("#hover-status"), "hovered");

      await socketClient.request("browser_click", { ref: incrementRef });
      assert.equal(await page.textContent("#click-status"), "clicked 1");

      await socketClient.request("browser_type", {
        ref: inputRef,
        text: "Alice",
        submit: false,
      });
      assert.equal(await page.inputValue("#name-input"), "Alice");

      await socketClient.request("browser_press_key", { key: "Enter" });
      assert.equal(await page.textContent("#keypress-status"), "enter:Alice");

      await socketClient.request("browser_type", {
        ref: dateRef,
        text: "2026-04-10",
        submit: false,
      });
      assert.equal(await page.inputValue("#date-input"), "2026-04-10");
      assert.equal(await page.textContent("#date-status"), "2026-04-10");

      await socketClient.request("browser_select_option", {
        ref: selectRef,
        values: ["blue"],
      });
      assert.equal(await page.inputValue("#color-select"), "blue");
      assert.equal(await page.textContent("#select-status"), "blue");

      await socketClient.request("browser_drag", {
        startRef: dragSourceRef,
        endRef: dropZoneRef,
      });
      assert.equal(await page.textContent("#drag-status"), "dropped:Drag source");

      const waitStartedAt = Date.now();
      await socketClient.request("browser_wait", { time: 0.15 });
      assert.ok(Date.now() - waitStartedAt >= 120);

      const consoleLogs = await socketClient.request("browser_get_console_logs", {});
      assert.ok(Array.isArray(consoleLogs));

      await socketClient.request("browser_click", { ref: linkRef });
      await page.waitForURL(`${httpServer.origin}/page2`);
      assert.equal(await socketClient.request("getTitle", {}), "Page Two");
      assert.equal(
        await socketClient.request("getUrl", {}),
        `${httpServer.origin}/page2`,
      );

      await socketClient.request("browser_go_back", {});
      await page.waitForURL(`${httpServer.origin}/page1`);
      assert.equal(await socketClient.request("getTitle", {}), "Page One");

      await socketClient.request("browser_go_forward", {});
      await page.waitForURL(`${httpServer.origin}/page2`);
      assert.equal(await socketClient.request("getTitle", {}), "Page Two");

      await socketClient.request("browser_navigate", {
        url: `${httpServer.origin}/page1?navigate=1`,
      });
      await page.waitForURL(`${httpServer.origin}/page1?navigate=1`);
      assert.equal(
        await socketClient.request("getUrl", {}),
        `${httpServer.origin}/page1?navigate=1`,
      );

      const screenshot = await socketClient.request("browser_screenshot", {});
      assert.ok(typeof screenshot === "string" && screenshot.startsWith("iVBOR"));

      const screenScreenshot = await socketClient.request(
        "browser_screen_screenshot",
        {},
      );
      assert.ok(
        typeof screenScreenshot === "string" &&
          screenScreenshot.startsWith("iVBOR"),
      );

      const socketClosedPromise = waitForSocketClose(socket);
      await popupPage.bringToFront();
      await popupPage.getByRole("button", { name: "Focus" }).click();
      await popupPage.getByRole("button", { name: "Disconnect" }).click();
      await popupPage.waitForFunction(() => {
        return document.getElementById("session-count")?.textContent === "0";
      });

      await socketClosedPromise;
      await popupPage.close();
    } catch (error) {
      if (page) {
        await captureFailureArtifacts(page, "e2e-extension-failure");
      }
      throw error;
    } finally {
      await closeContextSafely(context, userDataDir);
      await socketServer.close();
      await httpServer.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
);
