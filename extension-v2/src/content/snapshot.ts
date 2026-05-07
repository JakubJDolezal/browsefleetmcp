type SnapshotState = {
  generation: number;
  refs: Map<string, string>;
  stableRefs: Map<string, string>;
};

const state: SnapshotState = {
  generation: 0,
  refs: new Map(),
  stableRefs: new Map(),
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

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

function getAssociatedLabelText(element: HTMLElement): string {
  const labels = (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).labels;
  const labelText = labels
    ? Array.from(labels)
        .map((label) => normalizeText(label.innerText || label.textContent))
        .filter(Boolean)
        .join(" ")
    : "";
  if (labelText) {
    return labelText;
  }

  const id = element.id;
  if (id) {
    const explicitLabel = document.querySelector(`label[for=${quoted(id)}]`);
    const explicitText = normalizeText(
      explicitLabel instanceof HTMLElement
        ? explicitLabel.innerText || explicitLabel.textContent
        : explicitLabel?.textContent,
    );
    if (explicitText) {
      return explicitText;
    }
  }

  const wrappingLabel = element.closest("label");
  const wrappingText = normalizeText(wrappingLabel?.textContent ?? "");
  if (wrappingText) {
    return wrappingText;
  }

  return "";
}

function getFieldLabel(element: HTMLElement): string {
  const role = getRole(element);
  return (
    getAssociatedLabelText(element) ||
    getName(element, role) ||
    normalizeText(element.getAttribute("name")) ||
    normalizeText(element.getAttribute("id"))
  );
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

function getStableRef(element: HTMLElement): string {
  const selector = buildSelector(element);
  const ref = `bf${stableHash(selector)}`;
  state.stableRefs.set(ref, selector);
  return ref;
}

function getResolvedHref(element: HTMLElement): string | undefined {
  const link = element.closest("a[href], area[href]") as
    | HTMLAnchorElement
    | HTMLAreaElement
    | null;
  const href = link?.href;
  if (!href || href.trim().toLowerCase().startsWith("javascript:")) {
    return undefined;
  }
  return href;
}

function elementSummary(element: HTMLElement) {
  const role = getRole(element);
  return {
    ref: getStableRef(element),
    role,
    name: getName(element, role),
    label: getFieldLabel(element),
    tagName: element.tagName.toLowerCase(),
    text: normalizeText(element.innerText || element.textContent),
    disabled:
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? element.disabled
        : false,
  };
}

function isClickTargetCandidate(element: HTMLElement): boolean {
  if (!isVisible(element)) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  const role = getRole(element);
  if (
    ["a", "button", "input", "summary"].includes(tagName) ||
    ["button", "link"].includes(role) ||
    element.hasAttribute("onclick")
  ) {
    return true;
  }

  return window.getComputedStyle(element).cursor === "pointer";
}

export type ClickFallbackCandidate = {
  selector: string;
  reason: "target" | "descendant" | "ancestor";
  role: string;
  tagName: string;
  text: string;
  name: string;
  href?: string;
};

export function getClickFallbackCandidates(payload: {
  selector: string;
}): ClickFallbackCandidate[] {
  const element = querySelectorDeep(payload.selector);
  if (!element) {
    throw new Error(`Element not found for selector: ${payload.selector}`);
  }

  const candidates: Array<{
    element: HTMLElement;
    reason: ClickFallbackCandidate["reason"];
  }> = [];
  const seen = new Set<HTMLElement>();
  const addCandidate = (
    candidate: HTMLElement | null | undefined,
    reason: ClickFallbackCandidate["reason"],
  ) => {
    if (!candidate || seen.has(candidate) || !isClickTargetCandidate(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push({ element: candidate, reason });
  };

  addCandidate(element, "target");

  for (const descendant of Array.from(
    element.querySelectorAll(
      "a[href], button, input, summary, [role=button], [role=link], [onclick]",
    ),
  )) {
    if (descendant instanceof HTMLElement) {
      addCandidate(descendant, "descendant");
    }
  }

  let ancestor = element.parentElement;
  while (ancestor) {
    addCandidate(ancestor, "ancestor");
    ancestor = ancestor.parentElement;
  }

  return candidates.slice(0, 12).map(({ element: candidate, reason }) => {
    const role = getRole(candidate);
    return {
      selector: buildSelector(candidate),
      reason,
      role,
      tagName: candidate.tagName.toLowerCase(),
      text: normalizeText(candidate.innerText || candidate.textContent).slice(
        0,
        300,
      ),
      name: getName(candidate, role).slice(0, 300),
      href: getResolvedHref(candidate),
    };
  });
}

function matchesText(value: string, query: string, exact = false): boolean {
  const normalizedValue = normalizeText(value).toLowerCase();
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return false;
  }
  return exact
    ? normalizedValue === normalizedQuery
    : normalizedValue.includes(normalizedQuery);
}

function getVisibleText(): string {
  const pieces: string[] = [];
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    const text = normalizeText(current.textContent);
    if (
      text &&
      parent &&
      isVisible(parent) &&
      !["script", "style", "noscript"].includes(parent.tagName.toLowerCase())
    ) {
      pieces.push(text);
    }
    current = walker.nextNode();
  }
  return normalizeText(pieces.join(" "));
}

function getFormFields(form: HTMLFormElement) {
  return Array.from(
    form.querySelectorAll("input, textarea, select, button"),
  )
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .filter(isVisible)
    .map((element) => {
      const summary = elementSummary(element);
      return {
        ...summary,
        type:
          element instanceof HTMLInputElement
            ? element.type
            : element.tagName.toLowerCase(),
        value:
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element.value
            : undefined,
        options:
          element instanceof HTMLSelectElement
            ? Array.from(element.options).map((option) => ({
                text: normalizeText(option.text),
                value: option.value,
                selected: option.selected,
              }))
            : undefined,
      };
    });
}

type ProductCardCandidate = {
  element: HTMLElement;
  score: number;
  text: string;
  title: string;
  titleElement?: HTMLElement;
  href?: string;
  hrefElement?: HTMLAnchorElement;
  price?: string;
  article?: string;
  sku?: string;
  image?: { src: string; alt: string };
  actions: string[];
  actionRefs: Array<{ ref: string; label: string; href?: string }>;
};

const PRICE_PATTERN =
  /(?:[$€£]\s?\d[\d,.]*|\b(?:USD|EUR|GBP|MYR|RM|SGD)\s?\d[\d,.]*)/i;
const ART_NUMBER_PATTERN =
  /\bArt\.?\s*no\.?\s*([A-Z0-9][A-Z0-9._/-]{2,})\b/i;
const ARTICLE_PATTERN =
  /\b(?:article|item|code|sku|part)(?:\s+(?:no\.?|number)|\s*#|\s*:)?\s+([A-Z0-9][A-Z0-9._/-]{2,})\b/i;
const PRODUCT_CODE_PATTERN = /\b[A-Z]-\d{5,}\b/i;
const ACTION_PATTERN =
  /\b(?:view|article|details?|buy|cart|basket|inquiry|quote|request|select|configure)\b/i;

function getVisibleDescendants<T extends HTMLElement>(
  element: HTMLElement,
  selector: string,
  predicate: (candidate: Element) => candidate is T,
): T[] {
  return Array.from(element.querySelectorAll(selector))
    .filter(predicate)
    .filter(isVisible);
}

function getProductTitle(
  element: HTMLElement,
  links: HTMLAnchorElement[],
): string {
  const headings = getVisibleDescendants(
    element,
    "h1, h2, h3, h4, h5, h6, [role=heading]",
    (candidate): candidate is HTMLElement => candidate instanceof HTMLElement,
  )
    .map((heading) => normalizeText(heading.innerText || heading.textContent))
    .filter(Boolean)
    .filter((text) => text.length <= 220);
  if (headings.length > 0) {
    return headings.sort((left, right) => right.length - left.length)[0]!;
  }

  const linkLabels = links
    .map((link) => normalizeText(link.innerText || link.textContent || link.title))
    .filter(Boolean)
    .filter((text) => text.length >= 6 && text.length <= 220)
    .filter((text) => !ACTION_PATTERN.test(text));
  if (linkLabels.length > 0) {
    return linkLabels.sort((left, right) => right.length - left.length)[0]!;
  }

  return normalizeText(element.innerText || element.textContent)
    .split(/[.!?]\s+/)[0]!
    .slice(0, 220);
}

function getProductHref(
  title: string,
  links: HTMLAnchorElement[],
): string | undefined {
  return getProductHrefElement(title, links)?.href;
}

function getProductHrefElement(
  title: string,
  links: HTMLAnchorElement[],
): HTMLAnchorElement | undefined {
  const titleLink = links.find((link) =>
    normalizeText(link.innerText || link.textContent || link.title).includes(
      title.slice(0, 80),
    ),
  );
  if (titleLink?.href) {
    return titleLink;
  }

  const productLink = links.find((link) =>
    /product|article|item|sku|p-\d/i.test(
      `${link.href} ${link.innerText || link.textContent || ""}`,
    ),
  );
  return productLink ?? links[0];
}

function getProductTitleElement(
  element: HTMLElement,
  title: string,
  links: HTMLAnchorElement[],
): HTMLElement | undefined {
  const titlePrefix = title.slice(0, 80);
  const headings = getVisibleDescendants(
    element,
    "h1, h2, h3, h4, h5, h6, [role=heading]",
    (candidate): candidate is HTMLElement => candidate instanceof HTMLElement,
  );
  return (
    headings.find((heading) =>
      normalizeText(heading.innerText || heading.textContent).includes(titlePrefix),
    ) ??
    links.find((link) =>
      normalizeText(link.innerText || link.textContent || link.title).includes(
        titlePrefix,
      ),
    )
  );
}

function scoreProductElement(
  element: HTMLElement,
  query: string | undefined,
): ProductCardCandidate | undefined {
  if (!isVisible(element) || element.closest("nav, header, footer")) {
    return undefined;
  }

  const text = normalizeText(element.innerText || element.textContent);
  if (text.length < 20 || text.length > 1600 || isProbablyNoiseText(text)) {
    return undefined;
  }

  const links = getVisibleDescendants(
    element,
    "a[href]",
    (candidate): candidate is HTMLAnchorElement =>
      candidate instanceof HTMLAnchorElement,
  ).filter((link) => !link.href.toLowerCase().startsWith("javascript:"));
  const buttons = getVisibleDescendants(
    element,
    "button, [role=button], input[type=button], input[type=submit]",
    (candidate): candidate is HTMLElement => candidate instanceof HTMLElement,
  );
  const images = getVisibleDescendants(
    element,
    "img",
    (candidate): candidate is HTMLImageElement =>
      candidate instanceof HTMLImageElement,
  );

  if (links.length === 0 && images.length === 0) {
    return undefined;
  }
  if (links.length > 12 || buttons.length > 8) {
    return undefined;
  }

  const title = getProductTitle(element, links);
  if (!title || ACTION_PATTERN.test(title)) {
    return undefined;
  }

  let score = 0;
  if (["article", "li", "tr"].includes(element.tagName.toLowerCase())) {
    score += 1;
  }
  if (/\b(product|article|item|sku|catalog|tile|card)\b/i.test(element.className)) {
    score += 2;
  }
  if (images.length > 0) {
    score += 1;
  }
  if (links.length > 0) {
    score += 1;
  }
  if (PRICE_PATTERN.test(text)) {
    score += 2;
  }
  if (
    ART_NUMBER_PATTERN.test(text) ||
    ARTICLE_PATTERN.test(text) ||
    PRODUCT_CODE_PATTERN.test(text)
  ) {
    score += 2;
  }
  if (links.some((link) => /product|article|item|p-\d/i.test(link.href))) {
    score += 2;
  }
  if (buttons.some((button) => ACTION_PATTERN.test(button.innerText || ""))) {
    score += 1;
  }
  if (query) {
    score += text.toLowerCase().includes(query.toLowerCase()) ? 2 : -2;
  }

  if (score < 3) {
    return undefined;
  }

  const price = text.match(PRICE_PATTERN)?.[0];
  const article =
    text.match(ART_NUMBER_PATTERN)?.[1] ??
    text.match(ARTICLE_PATTERN)?.[1] ??
    text.match(PRODUCT_CODE_PATTERN)?.[0];
  const image = images[0]
    ? {
        src: images[0].currentSrc || images[0].src,
        alt: normalizeText(images[0].alt),
      }
    : undefined;

  const actionControls = [...links, ...buttons]
    .map((control) => ({
      control,
      label: normalizeText(control.innerText || control.textContent),
    }))
    .filter((entry) => entry.label && ACTION_PATTERN.test(entry.label))
    .slice(0, 6);
  const titleElement = getProductTitleElement(element, title, links);
  const hrefElement = getProductHrefElement(title, links);

  return {
    element,
    score,
    text,
    title,
    titleElement,
    href: getProductHref(title, links),
    hrefElement,
    price,
    article,
    sku: article,
    image,
    actions: actionControls.map((entry) => entry.label),
    actionRefs: actionControls.map(({ control, label }) => ({
      ref: getStableRef(control),
      label,
      href: control instanceof HTMLAnchorElement ? control.href : undefined,
    })),
  };
}

export function extractProductCards(payload: {
  query?: string;
  maxCards?: number;
}) {
  const maxCards = Math.min(Math.max(Number(payload.maxCards ?? 20), 1), 50);
  const query = normalizeText(payload.query);
  const selectors = [
    "[data-product]",
    "[data-product-id]",
    "[class*='product' i]",
    "[class*='article' i]",
    "[class*='item' i]",
    "[class*='card' i]",
    "article",
    "li",
    "tr",
    "section",
    "div",
  ].join(",");
  const candidates = Array.from(document.querySelectorAll(selectors))
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .map((element) => scoreProductElement(element, query || undefined))
    .filter((candidate): candidate is ProductCardCandidate => Boolean(candidate))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.text.length - right.text.length;
    });

  const selected: ProductCardCandidate[] = [];
  for (const candidate of candidates) {
    if (
      selected.some(
        (existing) =>
          existing.element.contains(candidate.element) ||
          candidate.element.contains(existing.element),
      )
    ) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= maxCards) {
      break;
    }
  }

  return {
    url: window.location.href,
    title: document.title,
    query: query || undefined,
    cards: selected.map((candidate) => ({
      ref: getStableRef(candidate.element),
      titleRef: candidate.titleElement
        ? getStableRef(candidate.titleElement)
        : undefined,
      hrefRef: candidate.hrefElement ? getStableRef(candidate.hrefElement) : undefined,
      title: candidate.title,
      href: candidate.href,
      price: candidate.price,
      article: candidate.article,
      sku: candidate.sku,
      image: candidate.image,
      actions: candidate.actions,
      actionRefs: candidate.actionRefs,
      text: candidate.text.slice(0, 700),
      score: candidate.score,
    })),
  };
}

export function generatePageSnapshot() {
  const elements = Array.from(
    iterateElements(document.body ?? document.documentElement),
  )
    .filter(shouldIncludeElement)
    .map(elementSummary);

  const forms = Array.from(document.forms).map((form, index) => ({
    ref: getStableRef(form),
    index,
    name: normalizeText(form.getAttribute("name")),
    id: normalizeText(form.id),
    action: form.action,
    method: form.method,
    fields: getFormFields(form),
  }));

  return {
    url: window.location.href,
    title: document.title,
    visibleText: getVisibleText().slice(0, 20_000),
    forms,
    elements,
  };
}

export function findElementsByQuery(payload: {
  label?: string;
  text?: string;
  role?: string;
  exact?: boolean;
}) {
  const exact = Boolean(payload.exact);
  return Array.from(iterateElements(document.body ?? document.documentElement))
    .filter(shouldIncludeElement)
    .filter((element) => {
      const summary = elementSummary(element);
      if (payload.role && summary.role !== payload.role) {
        return false;
      }
      if (payload.label && !matchesText(summary.label, payload.label, exact)) {
        return false;
      }
      if (
        payload.text &&
        !matchesText(`${summary.name} ${summary.text}`, payload.text, exact)
      ) {
        return false;
      }
      return Boolean(payload.label || payload.text || payload.role);
    })
    .map(elementSummary);
}

function findFieldByLabel<T extends HTMLElement>(
  label: string,
  exact: boolean,
  predicate: (element: HTMLElement) => element is T,
): T {
  const matches = Array.from(
    iterateElements(document.body ?? document.documentElement),
  )
    .filter(predicate)
    .filter(isVisible)
    .filter((element) => matchesText(getFieldLabel(element), label, exact));

  if (matches.length === 0) {
    throw new Error(`No visible field found for label "${label}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple visible fields matched label "${label}".`);
  }
  return matches[0]!;
}

export function setInputByLabel(payload: {
  label: string;
  value: string;
  exact?: boolean;
}): void {
  const element = findFieldByLabel(
    payload.label,
    Boolean(payload.exact),
    (candidate): candidate is HTMLInputElement | HTMLTextAreaElement =>
      candidate instanceof HTMLInputElement ||
      candidate instanceof HTMLTextAreaElement,
  );
  element.value = payload.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function selectOptionByLabel(payload: {
  label: string;
  option: string;
  exact?: boolean;
}): void {
  const element = findFieldByLabel(
    payload.label,
    Boolean(payload.exact),
    (candidate): candidate is HTMLSelectElement =>
      candidate instanceof HTMLSelectElement,
  );
  const option = Array.from(element.options).find(
    (candidate) =>
      matchesText(candidate.text, payload.option, Boolean(payload.exact)) ||
      matchesText(candidate.value, payload.option, Boolean(payload.exact)),
  );
  if (!option) {
    throw new Error(`No option "${payload.option}" found for "${payload.label}".`);
  }
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function clickByText(payload: {
  text: string;
  role?: string;
  exact?: boolean;
}): void {
  const candidates = Array.from(
    iterateElements(document.body ?? document.documentElement),
  )
    .filter((element) => {
      if (!isVisible(element)) {
        return false;
      }
      const role = getRole(element);
      if (payload.role && role !== payload.role) {
        return false;
      }
      const clickable =
        ["button", "link"].includes(role) ||
        element instanceof HTMLButtonElement ||
        element instanceof HTMLAnchorElement ||
        element instanceof HTMLInputElement ||
        element.getAttribute("role") === "button";
      return (
        clickable &&
        matchesText(
          `${getName(element, role)} ${element.innerText || element.textContent}`,
          payload.text,
          Boolean(payload.exact),
        )
      );
    });

  if (candidates.length === 0) {
    throw new Error(`No clickable element found for text "${payload.text}".`);
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple clickable elements matched text "${payload.text}".`);
  }
  candidates[0]!.click();
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
  const selector = state.refs.get(ariaRef) ?? state.stableRefs.get(ariaRef);
  if (!selector) {
    throw new Error(`Unknown aria ref "${ariaRef}". Generate a new snapshot.`);
  }
  return selector;
}
