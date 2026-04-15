type SnapshotState = {
  generation: number;
  refs: Map<string, string>;
};

const state: SnapshotState = {
  generation: 0,
  refs: new Map(),
};

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "option",
  "select",
  "summary",
  "textarea",
]);

const ATTRIBUTE_CANDIDATES = [
  "data-testid",
  "data-test",
  "data-qa",
  "name",
  "aria-label",
];

const STRUCTURAL_ROLES = new Set([
  "banner",
  "contentinfo",
  "generic",
  "group",
  "list",
  "listitem",
  "main",
  "navigation",
  "none",
  "presentation",
  "region",
  "separator",
  "tablist",
]);

function quoted(value: string): string {
  return JSON.stringify(value);
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const style = window.getComputedStyle(htmlElement);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse"
  ) {
    return false;
  }

  const rect = htmlElement.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function uniqueInRoot(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function buildLocalSelector(element: Element, root: ParentNode): string {
  const htmlElement = element as HTMLElement;
  if (htmlElement.id) {
    const selector = `#${CSS.escape(htmlElement.id)}`;
    if (uniqueInRoot(root, selector)) {
      return selector;
    }
  }

  for (const attributeName of ATTRIBUTE_CANDIDATES) {
    const attributeValue = htmlElement.getAttribute(attributeName);
    if (!attributeValue) {
      continue;
    }

    const selector = `[${attributeName}=${quoted(attributeValue)}]`;
    if (uniqueInRoot(root, selector)) {
      return selector;
    }
  }

  const segments: string[] = [];
  let current: Element | null = element;
  while (
    current &&
    current !== root &&
    current !== document.documentElement &&
    current.nodeType === Node.ELEMENT_NODE
  ) {
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (sibling) => sibling.tagName === current?.tagName,
        )
      : [];
    const index = siblings.indexOf(current) + 1;
    const segment = `${current.tagName.toLowerCase()}:nth-of-type(${index})`;
    segments.unshift(segment);

    const selector = segments.join(" > ");
    if (uniqueInRoot(root, selector)) {
      return selector;
    }

    current = current.parentElement;
  }

  return segments.join(" > ");
}

export function buildSelector(element: Element): string {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    const hostSelector = buildSelector(root.host);
    const localSelector = buildLocalSelector(element, root);
    return `${hostSelector} >>> ${localSelector}`;
  }

  return buildLocalSelector(element, document);
}

export function querySelectorDeep(selector: string): HTMLElement | null {
  const parts = selector.split(/\s*>>>\s*/);
  let currentRoot: ParentNode = document;
  let currentElement: HTMLElement | null = null;

  for (const part of parts) {
    const nextElement = currentRoot.querySelector(part) as HTMLElement | null;
    if (!nextElement) {
      return null;
    }

    currentElement = nextElement;
    currentRoot = nextElement.shadowRoot ?? nextElement;
  }

  return currentElement;
}

function getRole(element: HTMLElement): string {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  switch (element.tagName.toLowerCase()) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "input":
      return element.getAttribute("type") === "checkbox"
        ? "checkbox"
        : element.getAttribute("type") === "radio"
          ? "radio"
          : "textbox";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "img":
      return "img";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    default:
      return "generic";
  }
}

export function normalizeText(text: unknown): string {
  if (typeof text === "string") {
    return text.replace(/\s+/g, " ").trim();
  }

  if (
    typeof text === "number" ||
    typeof text === "boolean" ||
    typeof text === "bigint"
  ) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  return "";
}

export function isProbablyNoiseText(text: string): boolean {
  return (
    text.length >= 120 &&
    ((text.includes("{") &&
      text.includes("}") &&
      text.includes(":") &&
      text.includes(";")) ||
      /(^|[\s(])@(?:media|supports|keyframes)\b/.test(text) ||
      /(^|[\s(])[.#][-\w]+(?:__[-\w]+)?\s*[{,:]/.test(text) ||
      /\bfunction\b(?:\s+[$\w]+)?\s*\(/.test(text))
  );
}

export function shouldUseTextFallback(role: string, text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || isProbablyNoiseText(normalized)) {
    return false;
  }

  if (STRUCTURAL_ROLES.has(role) && normalized.length > 160) {
    return false;
  }

  return true;
}

function getName(element: HTMLElement, role: string): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const normalized = normalizeText(labelText);
    if (normalized) {
      return normalized;
    }
  }

  const candidates = [
    { value: element.getAttribute("aria-label"), source: "explicit" },
    { value: element.getAttribute("alt"), source: "explicit" },
    { value: element.getAttribute("title"), source: "explicit" },
    { value: (element as HTMLInputElement).placeholder, source: "field" },
    { value: (element as HTMLInputElement).value, source: "field" },
    { value: element.innerText, source: "text" },
    { value: element.textContent, source: "text" },
  ];

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate.value);
    if (normalized) {
      if (
        candidate.source === "text" &&
        !shouldUseTextFallback(role, normalized)
      ) {
        continue;
      }
      return normalized;
    }
  }

  return "";
}

function shouldIncludeElement(element: HTMLElement): boolean {
  if (!isVisible(element)) {
    return false;
  }

  if (
    INTERACTIVE_TAGS.has(element.tagName.toLowerCase()) ||
    element.isContentEditable ||
    element.hasAttribute("role") ||
    element.hasAttribute("aria-label") ||
    element.hasAttribute("aria-labelledby")
  ) {
    return true;
  }

  return /^h[1-6]$/i.test(element.tagName);
}

function* iterateElements(root: ParentNode): Generator<HTMLElement> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as HTMLElement | null;
  while (current) {
    if (current instanceof HTMLElement) {
      yield current;
      if (current.shadowRoot) {
        yield* iterateElements(current.shadowRoot);
      }
    }
    current = walker.nextNode() as HTMLElement | null;
  }
}

export function generateAriaSnapshot(): string {
  state.generation += 1;
  state.refs.clear();

  const lines: string[] = [];
  let index = 0;
  for (const element of iterateElements(document.body ?? document.documentElement)) {
    if (!shouldIncludeElement(element)) {
      continue;
    }

    index += 1;
    const ref = `s${state.generation}e${index}`;
    const selector = buildSelector(element);
    state.refs.set(ref, selector);

    const role = getRole(element);
    const name = getName(element, role);
    const disabled =
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? element.disabled
        : false;
    const suffix = disabled ? " disabled" : "";
    const label = name ? ` ${quoted(name)}` : "";
    lines.push(`- ${role}${label} [ref=${ref}]${suffix}`);
  }

  return lines.join("\n");
}

export function getSelectorForAriaRef(ariaRef: string): string {
  const selector = state.refs.get(ariaRef);
  if (!selector) {
    throw new Error(`Unknown aria ref "${ariaRef}". Generate a new snapshot.`);
  }
  return selector;
}
