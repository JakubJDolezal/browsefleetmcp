import { zodToJsonSchema } from "zod-to-json-schema";

import { GetConsoleLogsTool, ScreenshotTool } from "@/tool-schemas";

import { Tool } from "./tool";

type ConsoleLogEntry = {
  type: string;
  timestamp: number;
  message: string;
};

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const getConsoleLogs: Tool = {
  schema: {
    name: GetConsoleLogsTool.shape.name.value,
    description: GetConsoleLogsTool.shape.description.value,
    inputSchema: zodToJsonSchema(GetConsoleLogsTool.shape.arguments),
  },
  handle: async (context, _params) => {
    const consoleLogs = await context.sendSocketMessage<ConsoleLogEntry[]>(
      "browser_get_console_logs",
      {},
    );
    const text: string = consoleLogs
      .map((log) => JSON.stringify(log))
      .join("\n");
    return {
      content: [{ type: "text", text }],
    };
  },
};

export const screenshot: Tool = {
  schema: {
    name: ScreenshotTool.shape.name.value,
    description: ScreenshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(ScreenshotTool.shape.arguments),
  },
  handle: async (context, _params) => {
    const screenshot = await context.sendSocketMessage<string>(
      "browser_screenshot",
      {},
    );
    return {
      content: [
        {
          type: "image",
          data: screenshot,
          mimeType: "image/png",
        },
      ],
    };
  },
};

export const screenScreenshot: Tool = {
  schema: {
    name: "browser_screen_screenshot",
    description:
      "Compatibility alias for browser_screenshot. Captures a PNG screenshot of the current rendered browser page only and does not capture anything outside the browser.",
    inputSchema: emptyObjectSchema,
  },
  handle: async (context, _params) => {
    const sendSocketMessage = context.sendSocketMessage.bind(context) as (
      type: string,
      payload: Record<string, never>,
    ) => Promise<string>;

    const screenshot = await sendSocketMessage("browser_screen_screenshot", {});
    return {
      content: [
        {
          type: "image",
          data: screenshot,
          mimeType: "image/png",
        },
      ],
    };
  },
};
