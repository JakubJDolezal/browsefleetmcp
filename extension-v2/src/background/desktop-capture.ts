import { TEST_DESKTOP_CAPTURE_STORAGE_KEY } from "../shared/protocol.js";
import {
  closeOffscreenDocumentIfIdle,
  ensureOffscreenDocument,
  sendOffscreenRequest,
} from "./offscreen.js";

let captureChain: Promise<void> = Promise.resolve();

function runCaptureExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = captureChain.then(task, task);
  captureChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
      await closeOffscreenDocumentIfIdle();
    }
  });
}
