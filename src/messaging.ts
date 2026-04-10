import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

type MessageResponseEnvelope<T> = {
  type: "messageResponse";
  payload?: {
    requestId?: string;
    result?: T;
    error?: string;
  };
};

function parseMessage(message: WebSocket.RawData): unknown {
  return JSON.parse(message.toString());
}

function isResponseEnvelope<T>(
  value: unknown,
  requestId: string,
): value is MessageResponseEnvelope<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const response = value as MessageResponseEnvelope<T>;
  return (
    response.type === "messageResponse" &&
    response.payload?.requestId === requestId
  );
}

export async function sendSocketMessage<T>(
  ws: WebSocket,
  type: string,
  payload?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("No connected browser session.");
  }

  const requestId = randomUUID();
  const timeoutMs = options.timeoutMs ?? 30_000;

  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      ws.off("message", handleMessage);
      ws.off("close", handleClose);
      ws.off("error", handleError);
    };

    const handleMessage = (rawMessage: WebSocket.RawData) => {
      let parsedMessage: unknown;
      try {
        parsedMessage = parseMessage(rawMessage);
      } catch {
        return;
      }

      if (!isResponseEnvelope<T>(parsedMessage, requestId)) {
        return;
      }

      cleanup();
      if (parsedMessage.payload?.error) {
        reject(new Error(parsedMessage.payload.error));
        return;
      }

      resolve(parsedMessage.payload?.result as T);
    };

    const handleClose = () => {
      cleanup();
      reject(new Error("Browser session disconnected."));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${type}" response.`));
    }, timeoutMs);

    ws.on("message", handleMessage);
    ws.once("close", handleClose);
    ws.once("error", handleError);
    ws.send(
      JSON.stringify({
        id: requestId,
        type,
        payload,
      }),
    );
  });
}
