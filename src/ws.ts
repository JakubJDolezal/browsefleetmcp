import { WebSocketServer } from "ws";

import { mcpConfig } from "@/config";

export async function createWebSocketServer(
  port: number = mcpConfig.defaultWsPort,
): Promise<WebSocketServer> {
  return await new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port });
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
