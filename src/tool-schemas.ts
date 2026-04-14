import { z } from "zod";
import { withFocusLockDescription } from "@/focus-tools";

const emptyArguments = z.object({}).strict();

export const NavigateTool = z.object({
  name: z.literal("browser_navigate"),
  description: z.literal("Navigate the current browser session to a URL."),
  arguments: z.object({
    url: z.string(),
  }),
});

export const GoBackTool = z.object({
  name: z.literal("browser_go_back"),
  description: z.literal("Navigate back in the current browser session history."),
  arguments: emptyArguments,
});

export const GoForwardTool = z.object({
  name: z.literal("browser_go_forward"),
  description: z.literal(
    "Navigate forward in the current browser session history.",
  ),
  arguments: emptyArguments,
});

export const WaitTool = z.object({
  name: z.literal("browser_wait"),
  description: z.literal("Wait for a number of seconds."),
  arguments: z.object({
    time: z.number(),
  }),
});

export const PressKeyTool = z.object({
  name: z.literal("browser_press_key"),
  description: z.literal(
    withFocusLockDescription(
      "browser_press_key",
      "Press a keyboard key or key combination.",
    ),
  ),
  arguments: z.object({
    key: z.string(),
  }),
});

export const SnapshotTool = z.object({
  name: z.literal("browser_snapshot"),
  description: z.literal(
    "Capture a simplified accessibility snapshot of the current page for navigation.",
  ),
  arguments: emptyArguments,
});

export const ClickTool = z.object({
  name: z.literal("browser_click"),
  description: z.literal(
    withFocusLockDescription(
      "browser_click",
      "Click an element in the current page.",
    ),
  ),
  arguments: z.object({
    element: z.string(),
    ref: z.string(),
  }),
});

export const DragTool = z.object({
  name: z.literal("browser_drag"),
  description: z.literal(
    withFocusLockDescription(
      "browser_drag",
      "Drag from one element to another.",
    ),
  ),
  arguments: z.object({
    startElement: z.string(),
    startRef: z.string(),
    endElement: z.string(),
    endRef: z.string(),
  }),
});

export const HoverTool = z.object({
  name: z.literal("browser_hover"),
  description: z.literal(
    withFocusLockDescription(
      "browser_hover",
      "Hover over an element.",
    ),
  ),
  arguments: z.object({
    element: z.string(),
    ref: z.string(),
  }),
});

export const TypeTool = z.object({
  name: z.literal("browser_type"),
  description: z.literal(
    withFocusLockDescription(
      "browser_type",
      "Type text into an element.",
    ),
  ),
  arguments: z.object({
    element: z.string(),
    ref: z.string(),
    text: z.string(),
    submit: z.boolean().optional().default(false),
  }),
});

export const SelectOptionTool = z.object({
  name: z.literal("browser_select_option"),
  description: z.literal(
    withFocusLockDescription(
      "browser_select_option",
      "Select one or more options in a select element.",
    ),
  ),
  arguments: z.object({
    element: z.string(),
    ref: z.string(),
    values: z.array(z.string()),
  }),
});

export const GetConsoleLogsTool = z.object({
  name: z.literal("browser_get_console_logs"),
  description: z.literal("Read the buffered browser console logs."),
  arguments: emptyArguments,
});

export const ScreenshotTool = z.object({
  name: z.literal("browser_screenshot"),
  description: z.literal(
    "Capture a PNG screenshot of the current rendered browser page.",
  ),
  arguments: emptyArguments,
});
