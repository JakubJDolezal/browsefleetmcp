export const FOCUS_REQUIRED_TOOL_NAMES = [
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_press_key",
  "browser_select_option",
  "browser_type",
] as const;

const focusRequiredToolNameSet = new Set<string>(FOCUS_REQUIRED_TOOL_NAMES);

export function isFocusRequiredToolName(name: string): boolean {
  return focusRequiredToolNameSet.has(name);
}

export function withFocusLockDescription(
  name: string,
  description: string,
): string {
  if (!isFocusRequiredToolName(name)) {
    return description;
  }

  return `${description} Requires browser focus and runs behind a global focus lock.`;
}
