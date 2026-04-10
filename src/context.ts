import { WebSocket } from "ws";

import { mcpConfig } from "@/config";
import { sendSocketMessage } from "@/messaging";

export const noConnectionMessage = `No connection to the BrowseFleetMCP extension. To proceed, connect a tab by clicking the BrowseFleetMCP extension icon in the browser toolbar and choosing connect.`;

export class Context {
  constructor(private readonly socketProvider: () => WebSocket | undefined) {}

  get ws(): WebSocket {
    const ws = this.socketProvider();
    if (ws?.readyState !== WebSocket.OPEN) {
      throw new Error(noConnectionMessage);
    }
    return ws;
  }

  hasWs(): boolean {
    return this.socketProvider()?.readyState === WebSocket.OPEN;
  }

  async sendSocketMessage<T>(
    type: string,
    payload?: unknown,
    options: { timeoutMs?: number } = { timeoutMs: 30000 },
  ) {
    try {
      return await sendSocketMessage<T>(this.ws, type, payload, options);
    } catch (e) {
      if (e instanceof Error && e.message === mcpConfig.errors.noConnectedTab) {
        throw new Error(noConnectionMessage);
      }
      throw e;
    }
  }

  async close() {
    const ws = this.socketProvider();
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
