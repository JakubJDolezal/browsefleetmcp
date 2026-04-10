import type { SessionRecord } from "../shared/protocol.js";

type FocusTarget = Pick<SessionRecord, "sessionId" | "tabId" | "windowId">;

export const FOCUS_REQUIRED_SOCKET_REQUEST_TYPES = new Set([
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_press_key",
  "browser_type",
]);

export function socketRequestRequiresFocus(type: string): boolean {
  return FOCUS_REQUIRED_SOCKET_REQUEST_TYPES.has(type);
}

export class FocusLock {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly chromeApi: typeof chrome,
    private readonly focusSettleMs = 0,
    private readonly setTimer: (
      callback: () => void,
      delayMs: number,
    ) => unknown = globalThis.setTimeout.bind(globalThis),
  ) {}

  async run<T>(target: FocusTarget, action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: (() => void) | undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      await this.focus(target);
      if (this.focusSettleMs > 0) {
        await new Promise<void>((resolve) => {
          this.setTimer(resolve, this.focusSettleMs);
        });
      }
      return await action();
    } finally {
      release?.();
    }
  }

  async focus(target: FocusTarget): Promise<void> {
    await this.chromeApi.windows.update(target.windowId, { focused: true });
    await this.chromeApi.tabs.update(target.tabId, { active: true });
  }
}
