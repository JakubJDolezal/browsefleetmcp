import {
  isExtensionError,
  type OffscreenRequest,
  type OffscreenStatus,
} from "../shared/protocol.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_RESPONSE_TIMEOUT_MS = 2_000;

function getOffscreenDocumentUrl(chromeApi: typeof chrome): string {
  return chromeApi.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
}

export async function hasOffscreenDocument(
  chromeApi: typeof chrome = chrome,
): Promise<boolean> {
  if (typeof chromeApi.runtime.getContexts !== "function") {
    return false;
  }

  const contexts = await chromeApi.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [getOffscreenDocumentUrl(chromeApi)],
  });
  return contexts.length > 0;
}

async function sendRuntimeMessageWithTimeout<T>(
  message: OffscreenRequest,
  chromeApi: typeof chrome = chrome,
  timeoutMs: number = OFFSCREEN_RESPONSE_TIMEOUT_MS,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error("BrowseFleetMCP offscreen document did not respond."));
    }, timeoutMs);

    chromeApi.runtime.sendMessage(message)
      .then((response: unknown) => {
        globalThis.clearTimeout(timeoutId);
        resolve(response as T);
      })
      .catch((error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

async function createOffscreenDocument(
  chromeApi: typeof chrome = chrome,
): Promise<void> {
  try {
    await chromeApi.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification:
        "Maintain persistent BrowseFleetMCP session transport and desktop capture.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Only a single offscreen")) {
      throw error;
    }
  }
}

export async function ensureOffscreenDocument(
  chromeApi: typeof chrome = chrome,
): Promise<void> {
  if (await hasOffscreenDocument(chromeApi)) {
    try {
      await sendRuntimeMessageWithTimeout<OffscreenStatus>(
        { type: "offscreen/get-status" },
        chromeApi,
      );
      return;
    } catch {
      if (typeof chromeApi.offscreen?.closeDocument === "function") {
        try {
          await chromeApi.offscreen.closeDocument();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("No current offscreen document")) {
            throw error;
          }
        }
      }
    }
  }

  await createOffscreenDocument(chromeApi);
  await sendRuntimeMessageWithTimeout<OffscreenStatus>(
    { type: "offscreen/get-status" },
    chromeApi,
  );
}

export async function sendOffscreenRequest<T>(
  message: OffscreenRequest,
  chromeApi: typeof chrome = chrome,
): Promise<T> {
  if (message.type !== "offscreen/get-status") {
    await ensureOffscreenDocument(chromeApi);
  }

  const response = await sendRuntimeMessageWithTimeout<unknown>(
    message,
    chromeApi,
  );
  if (isExtensionError(response)) {
    throw new Error(response.message);
  }

  return response as T;
}

export async function getOffscreenStatus(
  chromeApi: typeof chrome = chrome,
): Promise<OffscreenStatus> {
  await ensureOffscreenDocument(chromeApi);
  return await sendOffscreenRequest<OffscreenStatus>(
    { type: "offscreen/get-status" },
    chromeApi,
  );
}

export async function closeOffscreenDocumentIfIdle(
  chromeApi: typeof chrome = chrome,
): Promise<void> {
  if (typeof chromeApi.offscreen?.closeDocument !== "function") {
    return;
  }

  if (typeof chromeApi.runtime.getContexts === "function") {
    if (!(await hasOffscreenDocument(chromeApi))) {
      return;
    }
  }

  const status = await getOffscreenStatus(chromeApi);
  if (status.activeSessionCount > 0 || status.keepAlive) {
    return;
  }

  try {
    await chromeApi.offscreen.closeDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No current offscreen document")) {
      return;
    }
    throw error;
  }
}
