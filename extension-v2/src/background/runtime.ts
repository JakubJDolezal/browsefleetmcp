import {
  type ContentRequest,
  isExtensionError,
} from "../shared/protocol.js";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTabMessage<T>(
  tabId: number,
  message: ContentRequest,
): Promise<T> {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (isExtensionError(response)) {
    throw new Error(response.message);
  }
  return response as T;
}

export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendTabMessage(tabId, { type: "ping" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["dist/content/index.js"],
    });
  }

  const timeoutAt = Date.now() + 3_000;
  while (Date.now() < timeoutAt) {
    try {
      await sendTabMessage(tabId, { type: "ping" });
      return;
    } catch {
      await wait(100);
    }
  }

  throw new Error("Content script did not become ready.");
}

export async function runTabHistoryNavigation(
  tabId: number,
  direction: "back" | "forward",
): Promise<void> {
  const api =
    direction === "back" ? chrome.tabs.goBack : chrome.tabs.goForward;
  if (typeof api === "function") {
    await api(tabId);
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (nextDirection: "back" | "forward") => {
      if (nextDirection === "back") {
        history.back();
        return;
      }

      history.forward();
    },
    args: [direction],
  });
}

export async function waitForTabComplete(
  tabId: number,
  timeoutMs = 30_000,
): Promise<any> {
  const currentTab = await chrome.tabs.get(tabId);
  if (currentTab?.status === "complete") {
    return currentTab;
  }

  return await new Promise<any>((resolve, reject) => {
    let timeoutId = 0;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      clearTimeout(timeoutId);
    };

    const handleUpdate = async (
      updatedTabId: number,
      changeInfo: { status?: string },
    ) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      cleanup();
      resolve(await chrome.tabs.get(tabId));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Navigation timed out."));
    }, timeoutMs) as unknown as number;

    chrome.tabs.onUpdated.addListener(handleUpdate);
  });
}

export async function withPossibleNavigation(
  tabId: number,
  action: () => Promise<void>,
): Promise<boolean> {
  let navigationStarted = false;
  const handleNavigate = (details: { tabId: number; frameId: number }) => {
    if (details.tabId === tabId && details.frameId === 0) {
      navigationStarted = true;
    }
  };

  chrome.webNavigation.onBeforeNavigate.addListener(handleNavigate);
  try {
    await action();
  } finally {
    chrome.webNavigation.onBeforeNavigate.removeListener(handleNavigate);
  }

  return navigationStarted;
}
