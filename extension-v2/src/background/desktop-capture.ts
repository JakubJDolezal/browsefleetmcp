import {
  isExtensionError,
  type OffscreenRequest,
  TEST_DESKTOP_CAPTURE_STORAGE_KEY,
} from "../shared/protocol.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

function getOffscreenDocumentUrl(): string {
  return chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
}

let captureChain: Promise<void> = Promise.resolve();

function runCaptureExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = captureChain.then(task, task);
  captureChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome.runtime.getContexts !== "function") {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [getOffscreenDocumentUrl()],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture desktop screenshots for BrowseFleetMCP tool calls.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Only a single offscreen")) {
      throw error;
    }
  }
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    if (typeof chrome.runtime.getContexts === "function") {
      if (!(await hasOffscreenDocument())) {
        return;
      }
    }

    await chrome.offscreen.closeDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No current offscreen document")) {
      return;
    }
    throw error;
  }
}

async function chooseDesktopSource(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ["screen", "window", "tab"],
      (streamId: string) => {
        if (!streamId) {
          reject(new Error("Desktop capture was canceled."));
          return;
        }

        resolve(streamId);
      },
    );
  });
}

async function sendOffscreenRequest<T>(message: OffscreenRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (isExtensionError(response)) {
    throw new Error(response.message);
  }

  return response as T;
}

async function getDesktopCaptureOverride(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(TEST_DESKTOP_CAPTURE_STORAGE_KEY);
  const value = stored[TEST_DESKTOP_CAPTURE_STORAGE_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function captureDesktopScreenshot(): Promise<string> {
  return await runCaptureExclusive(async () => {
    const overrideCapture = await getDesktopCaptureOverride();
    if (overrideCapture) {
      return overrideCapture;
    }

    await ensureOffscreenDocument();

    try {
      const streamId = await chooseDesktopSource();
      return await sendOffscreenRequest<string>({
        type: "offscreen/capture-desktop",
        payload: { streamId },
      });
    } finally {
      await closeOffscreenDocument();
    }
  });
}
