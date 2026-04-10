import {
  createExtensionError,
  type ConsoleEntry,
  type ContentRequest,
} from "../shared/protocol.js";
import {
  generateAriaSnapshot,
  getSelectorForAriaRef,
  querySelectorDeep,
} from "./snapshot.js";

const consoleEntries: ConsoleEntry[] = [];
const MAX_CONSOLE_ENTRIES = 100;
const CONSOLE_CAPTURE_KEY = "__browsefleetmcpConsoleCaptureInstalled__";

function pushConsoleEntry(type: string, args: unknown[]): void {
  consoleEntries.push({
    type,
    timestamp: Date.now(),
    message: args
      .map((arg) => {
        if (typeof arg === "string") {
          return arg;
        }

        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" "),
  });

  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    consoleEntries.shift();
  }
}

function installConsoleCapture(): void {
  const captureState = window as Window & { [CONSOLE_CAPTURE_KEY]?: boolean };
  if (captureState[CONSOLE_CAPTURE_KEY]) {
    return;
  }
  captureState[CONSOLE_CAPTURE_KEY] = true;

  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      pushConsoleEntry(level, args);
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    pushConsoleEntry("exception", [event.message]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    pushConsoleEntry("exception", [event.reason]);
  });
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function getElementOrThrow(selector: string): HTMLElement {
  const element = querySelectorDeep(selector);
  if (!element) {
    throw new Error(`Element not found for selector: ${selector}`);
  }
  return element;
}

function isClickableAtCenter(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hitElement = document.elementFromPoint(x, y);
  return !!hitElement && (hitElement === element || element.contains(hitElement));
}

function getElementCenter(selector: string, clickable = false): {
  x: number;
  y: number;
} {
  const element = getElementOrThrow(selector);
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`Element has no visible box: ${selector}`);
  }

  if (clickable && !isClickableAtCenter(element)) {
    throw new Error(`Element is not clickable at its center point: ${selector}`);
  }

  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

async function waitForStableDOM(payload: {
  minStableMs: number;
  maxMutations: number;
  maxWaitMs: number;
}): Promise<void> {
  const startTime = Date.now();
  let lastMutationAt = Date.now();
  let mutationCount = 0;

  await new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      mutationCount += 1;
      lastMutationAt = Date.now();
    });

    observer.observe(document.documentElement ?? document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    const interval = window.setInterval(() => {
      const now = Date.now();
      const hitMutationBudget =
        payload.maxMutations > 0 && mutationCount >= payload.maxMutations;
      const isStable = now - lastMutationAt >= payload.minStableMs;
      if (
        now - startTime >= payload.maxWaitMs ||
        hitMutationBudget ||
        isStable
      ) {
        observer.disconnect();
        window.clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

async function handleContentRequest(message: ContentRequest): Promise<unknown> {
  switch (message.type) {
    case "ping":
      return true;
    case "generateAriaSnapshot":
      return generateAriaSnapshot();
    case "getSelectorForAriaRef":
      return getSelectorForAriaRef(message.payload.ariaRef);
    case "scrollIntoView":
      getElementOrThrow(message.payload.selector).scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
      await nextFrame();
      return null;
    case "getElementCoordinates":
      return getElementCenter(
        message.payload.selector,
        Boolean(message.payload.options?.clickable),
      );
    case "selectText": {
      const element = getElementOrThrow(message.payload.selector);
      element.focus();
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        element.select();
      } else {
        const selection = window.getSelection();
        if (!selection) {
          throw new Error("Unable to access window selection.");
        }
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return null;
    }
    case "waitForStableDOM":
      await waitForStableDOM(message.payload);
      return null;
    case "getInputType": {
      const element = getElementOrThrow(message.payload.selector);
      return element instanceof HTMLInputElement
        ? element.type.toLowerCase()
        : null;
    }
    case "setInputValue": {
      const element = getElementOrThrow(message.payload.selector);
      if (!(element instanceof HTMLInputElement)) {
        throw new Error("Target element is not an input.");
      }
      element.value = message.payload.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return null;
    }
    case "selectOption": {
      const element = getElementOrThrow(message.payload.selector);
      if (!(element instanceof HTMLSelectElement)) {
        throw new Error("Target element is not a select.");
      }
      const wantedValues = new Set(message.payload.values);
      let matched = 0;
      for (const option of Array.from(element.options)) {
        const shouldSelect =
          wantedValues.has(option.value) || wantedValues.has(option.text);
        option.selected = shouldSelect;
        if (shouldSelect) {
          matched += 1;
        }
      }
      if (matched === 0) {
        throw new Error("No matching option found.");
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return null;
    }
    case "getConsoleLogs":
      return [...consoleEntries];
  }
}

installConsoleCapture();

chrome.runtime.onMessage.addListener(
  (
    message: ContentRequest,
    _sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => {
    void handleContentRequest(message)
      .then((response) => sendResponse(response))
      .catch((error) =>
        sendResponse(createExtensionError(String(error instanceof Error ? error.message : error))),
      );
    return true;
  },
);
