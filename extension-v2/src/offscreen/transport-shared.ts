export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const SOCKET_CONNECT_TIMEOUT_MS = 2_000;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER_RATIO = 0.3;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function normalizeCloseCode(code?: number): number | undefined {
  return typeof code === "number" && code > 0 ? code : undefined;
}

export function normalizeCloseReason(reason?: string): string | undefined {
  if (typeof reason !== "string") {
    return undefined;
  }

  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function describeDisconnect(
  fallbackMessage: string,
  closeCode?: number,
  closeReason?: string,
): string {
  const normalizedCode = normalizeCloseCode(closeCode);
  const normalizedReason = normalizeCloseReason(closeReason);

  if (normalizedCode && normalizedReason) {
    return `${fallbackMessage} (code ${normalizedCode}: ${normalizedReason})`;
  }

  if (normalizedCode) {
    return `${fallbackMessage} (code ${normalizedCode})`;
  }

  if (normalizedReason) {
    return `${fallbackMessage} (${normalizedReason})`;
  }

  return fallbackMessage;
}

export function computeReconnectDelayMs(
  retryCount: number,
  random: () => number,
): number {
  const exponentialDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1),
  );
  const jitterMultiplier =
    1 + (random() * 2 - 1) * RECONNECT_JITTER_RATIO;
  return Math.max(
    RECONNECT_BASE_DELAY_MS,
    Math.round(exponentialDelay * jitterMultiplier),
  );
}
