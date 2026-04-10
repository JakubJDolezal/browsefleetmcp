import {
  createExtensionError,
  type OffscreenRequest,
} from "../shared/protocol.js";

const DATA_URL_PREFIX = "data:image/png;base64,";

function sanitizeCapture(dataUrl: string): string {
  return dataUrl.startsWith(DATA_URL_PREFIX)
    ? dataUrl.slice(DATA_URL_PREFIX.length)
    : dataUrl;
}

async function captureDesktopFrame(streamId: string): Promise<string> {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
        maxWidth: 16_384,
        maxHeight: 16_384,
      },
    },
  } as MediaStreamConstraints;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = document.createElement("video");

  try {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () =>
        reject(new Error("Unable to initialize the desktop capture stream."));
    });

    await video.play();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("Desktop capture returned an empty frame.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create a canvas context for desktop capture.");
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return sanitizeCapture(canvas.toDataURL("image/png"));
  } finally {
    video.pause();
    video.srcObject = null;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: OffscreenRequest,
    _sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type !== "offscreen/capture-desktop") {
      return undefined;
    }

    void captureDesktopFrame(message.payload.streamId)
      .then((capture) => sendResponse(capture))
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error);
        sendResponse(createExtensionError(message));
      });

    return true;
  },
);
