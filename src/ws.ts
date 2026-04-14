import { WebSocketServer } from "ws";

import { getAuthToken, getWsPortCandidates } from "@/config";

async function listenOnPort(
  port: number,
  expectedAuthToken?: string,
): Promise<WebSocketServer> {
  return await new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      port,
      verifyClient: expectedAuthToken
        ? (info: { req: { url?: string | undefined } }) => {
            const requestUrl = new URL(info.req.url ?? "/", "ws://127.0.0.1");
            return requestUrl.searchParams.get("authToken") === expectedAuthToken;
          }
        : undefined,
    });
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export async function createWebSocketServer(): Promise<WebSocketServer> {
  let lastError: unknown;
  const expectedAuthToken = getAuthToken();

  for (const port of getWsPortCandidates()) {
    try {
      return await listenOnPort(port, expectedAuthToken);
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Unable to bind a BrowseFleetMCP WebSocket server.");
}
