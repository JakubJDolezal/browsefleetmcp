import type { ToolResult } from "@/tools/tool";

export type ToolErrorType =
  | "tool_not_found"
  | "transport_unavailable"
  | "session_missing"
  | "session_in_use"
  | "focus_lock_timeout"
  | "navigation_blocked"
  | "chrome_api_error"
  | "page_interaction_failed"
  | "unknown";

export type ToolErrorPayload = {
  errorType: ToolErrorType;
  message: string;
  toolName?: string;
  details?: Record<string, unknown>;
};

export class BrowseFleetToolError extends Error {
  readonly errorType: ToolErrorType;
  readonly details?: Record<string, unknown>;

  constructor(
    errorType: ToolErrorType,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrowseFleetToolError";
    this.errorType = errorType;
    this.details = details;
  }
}

function matches(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function classifyToolError(
  error: unknown,
  options: {
    toolName?: string;
    details?: Record<string, unknown>;
  } = {},
): ToolErrorPayload {
  const inferredDetails =
    typeof error === "object" && error !== null && "cleanup" in error
      ? { cleanup: (error as { cleanup?: unknown }).cleanup }
      : undefined;

  if (error instanceof BrowseFleetToolError) {
    return {
      errorType: error.errorType,
      message: error.message,
      toolName: options.toolName,
      details: {
        ...error.details,
        ...inferredDetails,
        ...options.details,
      },
    };
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  let errorType: ToolErrorType = "unknown";

  if (
    matches(message, [
      /Tool ".*" not found/i,
    ])
  ) {
    errorType = "tool_not_found";
  } else if (
    matches(message, [
      /No connection to the BrowseFleetMCP extension control channel/i,
      /Lost connection to the BrowseFleetMCP broker/i,
      /No connected browser session/i,
      /No connected tab/i,
      /WebSocket is not open/i,
      /socket hang up/i,
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /EPIPE/i,
    ])
  ) {
    errorType = "transport_unavailable";
  } else if (
    matches(message, [
      /No browser session is currently selected/i,
      /Session ".*" is not currently connected/i,
      /Session ".*" not found/i,
      /is not available in the background worker/i,
    ])
  ) {
    errorType = "session_missing";
  } else if (
    matches(message, [
      /already in use by another client/i,
    ])
  ) {
    errorType = "session_in_use";
  } else if (
    matches(message, [
      /global focus lock/i,
      /focus lock/i,
    ])
  ) {
    errorType = "focus_lock_timeout";
  } else if (
    matches(message, [
      /Navigation timed out/i,
      /must use an "http:", "https:", or "about:" URL/i,
      /cannot host a BrowseFleetMCP session/i,
    ])
  ) {
    errorType = "navigation_blocked";
  } else if (
    matches(message, [
      /No tab with given id/i,
      /Debugger is not attached/i,
      /Content script did not become ready/i,
      /Receiving end does not exist/i,
      /Cannot access a chrome-extension:\/\/ URL/i,
    ])
  ) {
    errorType = "chrome_api_error";
  } else if (options.toolName?.startsWith("browser_")) {
    errorType = "page_interaction_failed";
  }

  return {
    errorType,
    message,
    toolName: options.toolName,
    details: {
      ...inferredDetails,
      ...options.details,
    },
  };
}

export function createToolErrorResult(
  error: unknown,
  options: {
    toolName?: string;
    details?: Record<string, unknown>;
  } = {},
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(classifyToolError(error, options), null, 2),
      },
    ],
    isError: true,
  };
}
