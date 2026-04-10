export type ViewportPoint = {
  x: number;
  y: number;
};

type KeyDefinition = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
};

const DEBUGGER_VERSION = "1.3";
const DATA_URL_PREFIX = "data:image/png;base64,";
const attachedTabs = new Set<number>();
const pendingAttachments = new Map<number, Promise<void>>();

const SPECIAL_KEYS: Record<string, KeyDefinition> = {
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  End: { key: "End", code: "End", keyCode: 35 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function modifierBit(key: string): number {
  switch (key) {
    case "Alt":
      return 1;
    case "Control":
      return 2;
    case "Meta":
      return 4;
    case "Shift":
      return 8;
    default:
      return 0;
  }
}

function sanitizeCapture(dataUrl: string): string {
  return dataUrl.startsWith(DATA_URL_PREFIX)
    ? dataUrl.slice(DATA_URL_PREFIX.length)
    : dataUrl;
}

function buildCharacterKeyDefinition(input: string): KeyDefinition {
  if (input.length !== 1) {
    throw new Error(`Unsupported key "${input}"`);
  }

  const charCode = input.toUpperCase().charCodeAt(0);
  if (/[a-z]/i.test(input)) {
    return {
      key: input,
      code: `Key${input.toUpperCase()}`,
      keyCode: charCode,
      text: input,
    };
  }

  if (/[0-9]/.test(input)) {
    return {
      key: input,
      code: `Digit${input}`,
      keyCode: input.charCodeAt(0),
      text: input,
    };
  }

  if (input === " ") {
    return SPECIAL_KEYS.Space;
  }

  return {
    key: input,
    code: "Unidentified",
    keyCode: input.charCodeAt(0),
    text: input,
  };
}

function getKeyDefinition(input: string): KeyDefinition {
  return SPECIAL_KEYS[input] ?? buildCharacterKeyDefinition(input);
}

async function sendCommand<T>(
  tabId: number,
  command: string,
  params?: Record<string, unknown>,
): Promise<T> {
  await attachDebugger(tabId);

  try {
    return await chrome.debugger.sendCommand({ tabId }, command, params ?? {});
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes("Detached while handling command") ||
      message.includes("Debugger is not attached")
    ) {
      attachedTabs.delete(tabId);
      await attachDebugger(tabId);
      return await chrome.debugger.sendCommand(
        { tabId },
        command,
        params ?? {},
      );
    }
    throw error;
  }
}

async function getViewportZoom(tabId: number): Promise<number> {
  const layoutMetrics = await sendCommand<{
    visualViewport?: { zoom?: number };
    cssVisualViewport?: { zoom?: number };
  }>(tabId, "Page.getLayoutMetrics");

  return (
    layoutMetrics.cssVisualViewport?.zoom ??
    layoutMetrics.visualViewport?.zoom ??
    1
  );
}

async function scalePoint(
  zoom: number,
  point: ViewportPoint,
): Promise<ViewportPoint> {
  return {
    x: point.x * zoom,
    y: point.y * zoom,
  };
}

export async function attachDebugger(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) {
    return;
  }

  const pending = pendingAttachments.get(tabId);
  if (pending) {
    await pending;
    return;
  }

  const attachment = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    } catch (error) {
      const message = errorMessage(error);
      if (!message.includes("already attached")) {
        throw error;
      }
    }

    attachedTabs.add(tabId);
  })();
  pendingAttachments.set(tabId, attachment);

  try {
    await attachment;
  } finally {
    pendingAttachments.delete(tabId);
  }
}

export async function detachDebugger(tabId: number): Promise<void> {
  attachedTabs.delete(tabId);

  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes("Debugger is not attached") ||
      message.includes("Cannot access a chrome-extension:// URL")
    ) {
      return;
    }
    throw error;
  }
}

async function dispatchMouseEvent(
  tabId: number,
  payload: {
    type: "mouseMoved" | "mousePressed" | "mouseReleased";
    point: ViewportPoint;
    buttons: number;
    button: "left" | "none";
    clickCount?: number;
  },
): Promise<void> {
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: payload.type,
    x: payload.point.x,
    y: payload.point.y,
    buttons: payload.buttons,
    button: payload.button,
    clickCount: payload.clickCount,
    pointerType: "mouse",
  });
}

export async function moveMouse(
  tabId: number,
  point: ViewportPoint,
  buttons = 0,
): Promise<void> {
  const zoom = await getViewportZoom(tabId);
  await dispatchMouseEvent(tabId, {
    type: "mouseMoved",
    point: await scalePoint(zoom, point),
    buttons,
    button: buttons ? "left" : "none",
  });
}

export async function clickPoint(
  tabId: number,
  point: ViewportPoint,
): Promise<void> {
  const zoom = await getViewportZoom(tabId);
  const scaledPoint = await scalePoint(zoom, point);

  await dispatchMouseEvent(tabId, {
    type: "mouseMoved",
    point: scaledPoint,
    buttons: 0,
    button: "none",
  });
  await dispatchMouseEvent(tabId, {
    type: "mousePressed",
    point: scaledPoint,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await dispatchMouseEvent(tabId, {
    type: "mouseReleased",
    point: scaledPoint,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function dragBetweenPoints(
  tabId: number,
  start: ViewportPoint,
  end: ViewportPoint,
): Promise<void> {
  const zoom = await getViewportZoom(tabId);
  const scaledStart = await scalePoint(zoom, start);
  const steps = 12;
  await dispatchMouseEvent(tabId, {
    type: "mouseMoved",
    point: scaledStart,
    buttons: 0,
    button: "none",
  });
  await dispatchMouseEvent(tabId, {
    type: "mousePressed",
    point: scaledStart,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });

  for (let step = 1; step <= steps; step += 1) {
    const point = {
      x: start.x + ((end.x - start.x) * step) / steps,
      y: start.y + ((end.y - start.y) * step) / steps,
    };
    await dispatchMouseEvent(tabId, {
      type: "mouseMoved",
      point: await scalePoint(zoom, point),
      buttons: 1,
      button: "left",
    });
  }

  const scaledEnd = await scalePoint(zoom, end);
  await dispatchMouseEvent(tabId, {
    type: "mouseReleased",
    point: scaledEnd,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function insertText(tabId: number, text: string): Promise<void> {
  await sendCommand(tabId, "Input.insertText", { text });
}

export async function pressKeyCombo(
  tabId: number,
  keyCombo: string,
): Promise<void> {
  const keys = keyCombo
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean);
  let modifiers = 0;

  for (const key of keys) {
    const definition = getKeyDefinition(key);
    modifiers |= modifierBit(definition.key);
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: definition.text ? "keyDown" : "rawKeyDown",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      text: definition.text,
      unmodifiedText: definition.text,
      modifiers,
      location: definition.location ?? 0,
    });
  }

  for (const key of [...keys].reverse()) {
    const definition = getKeyDefinition(key);
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers,
      location: definition.location ?? 0,
    });
    modifiers &= ~modifierBit(definition.key);
  }
}

export async function typeText(tabId: number, text: string): Promise<void> {
  await insertText(tabId, text);
}

export async function captureTabScreenshot(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.windowId !== "number") {
    throw new Error("Unable to determine window for screenshot capture.");
  }

  const activeTabs = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  const activeTab = activeTabs[0];

  if (activeTab?.id === tabId) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    return sanitizeCapture(dataUrl);
  }

  const metrics = await sendCommand<{
    cssVisualViewport: { clientWidth: number; clientHeight: number };
  }>(tabId, "Page.getLayoutMetrics");
  const capture = await sendCommand<{ data: string }>(
    tabId,
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(metrics.cssVisualViewport.clientWidth),
        height: Math.ceil(metrics.cssVisualViewport.clientHeight),
        scale: 1,
      },
    },
  );

  return capture.data;
}
