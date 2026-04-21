import { BrowserManager } from "../browser/browser-manager";
import {
  DomQueryMatch,
  DomQueryResult,
  InteractiveElement,
  PageSignals,
  PageState,
} from "../types";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "what",
  "when",
  "where",
  "into",
  "have",
  "there",
  "about",
  "would",
  "could",
  "should",
  "please",
  "show",
  "find",
  "check",
  "does",
  "after",
  "before",
  "been",
  "were",
  "are",
]);

function truncate(text: string, max = 160): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 2 && !STOP_WORDS.has(item));
}

function buildSummary(
  title: string,
  url: string,
  interactiveCount: number,
  inputCount: number,
  hasModal: boolean,
  signals: PageSignals,
): string {
  const parts = [
    `Page "${title || "Untitled"}" at ${url}.`,
    `Visible interactive elements: ${interactiveCount}.`,
    `Visible form inputs: ${inputCount}.`,
    hasModal ? "A modal or overlay appears to be visible." : "No modal is obvious.",
  ];

  if (signals.loginPromptLikely) {
    parts.push("Login prompt is likely present.");
  }
  if (signals.captchaLikely) {
    parts.push("Captcha challenge might be present.");
  }
  if (signals.paymentStepLikely) {
    parts.push("Payment or checkout confirmation step is likely visible.");
  }
  if (signals.destructiveActionLikely) {
    parts.push("Potential destructive actions are visible.");
  }

  return parts.join(" ");
}

export class PageInspector {
  constructor(private readonly browser: BrowserManager) {}

  async getPageState(): Promise<PageState> {
    const page = this.browser.getPage();

    const raw = await page.evaluate(() => {
      const win = window as Window & {
        __agentRuntime?: {
          counter: number;
          documentToken: string;
        };
      };

      if (!win.__agentRuntime) {
        const seed = Math.floor(performance.timeOrigin || Date.now()).toString(36);
        win.__agentRuntime = {
          counter: 0,
          documentToken: seed,
        };
      }

      const assignElementId = (element: HTMLElement): string => {
        const existing = element.getAttribute("data-agent-id");
        if (existing) {
          return existing;
        }

        win.__agentRuntime!.counter += 1;
        const id = `el_${win.__agentRuntime!.documentToken}_${win.__agentRuntime!.counter}`;
        element.setAttribute("data-agent-id", id);
        return id;
      };

      const normalizeWhitespace = (value: unknown): string => {
        if (value === null || value === undefined) {
          return "";
        }

        if (typeof value === "string") {
          return value.replace(/\s+/g, " ").trim();
        }

        if (
          typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint"
        ) {
          return String(value).replace(/\s+/g, " ").trim();
        }

        if (typeof value === "object" && "baseVal" in (value as Record<string, unknown>)) {
          const base = (value as { baseVal?: unknown }).baseVal;
          if (typeof base === "string") {
            return base.replace(/\s+/g, " ").trim();
          }
        }

        return "";
      };

      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        if (Number.parseFloat(style.opacity || "1") < 0.05) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) {
          return false;
        }
        return (
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= window.innerHeight &&
          rect.left <= window.innerWidth
        );
      };

      const inferRole = (element: HTMLElement): string | null => {
        const explicitRole = element.getAttribute("role");
        if (explicitRole) {
          return explicitRole;
        }

        const tag = element.tagName.toLowerCase();
        if (tag === "a" && element.getAttribute("href")) {
          return "link";
        }
        if (tag === "button") {
          return "button";
        }
        if (tag === "textarea") {
          return "textbox";
        }
        if (tag === "select") {
          return "combobox";
        }
        if (tag === "input") {
          const type = (element.getAttribute("type") || "text").toLowerCase();
          if (["button", "submit", "reset"].includes(type)) {
            return "button";
          }
          if (["checkbox", "radio"].includes(type)) {
            return type;
          }
          return "textbox";
        }
        if (element.getAttribute("contenteditable") === "true") {
          return "textbox";
        }
        return null;
      };

      const isPotentiallyInteractive = (element: HTMLElement): boolean => {
        const tag = element.tagName.toLowerCase();
        const role = (element.getAttribute("role") || "").toLowerCase();
        const tabIndexRaw = element.getAttribute("tabindex");
        const tabIndex = tabIndexRaw !== null ? Number.parseInt(tabIndexRaw, 10) : Number.NaN;
        const style = window.getComputedStyle(element);

        if (["a", "button", "input", "select", "textarea", "summary"].includes(tag)) {
          return true;
        }

        if (
          [
            "button",
            "link",
            "menuitem",
            "tab",
            "option",
            "row",
            "gridcell",
            "treeitem",
            "listitem",
            "checkbox",
            "radio",
            "switch",
            "combobox",
            "textbox",
          ].includes(role)
        ) {
          return true;
        }

        if (Number.isFinite(tabIndex) && tabIndex >= 0) {
          return true;
        }

        if (element.hasAttribute("onclick") || element.hasAttribute("jsaction")) {
          return true;
        }

        if (element.getAttribute("contenteditable") === "true") {
          return true;
        }

        if (style.cursor === "pointer") {
          return true;
        }

        return false;
      };

      const resolveAriaLabelledBy = (element: HTMLElement): string => {
        const labelledBy = element.getAttribute("aria-labelledby");
        if (!labelledBy) {
          return "";
        }

        const parts = labelledBy
          .split(/\s+/)
          .map((id) => normalizeWhitespace(document.getElementById(id)?.textContent))
          .filter(Boolean);

        return parts.join(" ");
      };

      const readElementValue = (element: HTMLElement): string => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          return normalizeWhitespace(element.value);
        }
        return "";
      };

      const elementName = (element: HTMLElement): string => {
        const ariaLabel = normalizeWhitespace(element.getAttribute("aria-label"));
        if (ariaLabel) {
          return ariaLabel;
        }

        const labelledBy = resolveAriaLabelledBy(element);
        if (labelledBy) {
          return labelledBy;
        }

        const placeholder = normalizeWhitespace(element.getAttribute("placeholder"));
        if (placeholder) {
          return placeholder;
        }

        const value = readElementValue(element);
        if (value && value.length < 80) {
          return value;
        }

        const alt = normalizeWhitespace(element.getAttribute("alt"));
        if (alt) {
          return alt;
        }

        const title = normalizeWhitespace(element.getAttribute("title"));
        if (title) {
          return title;
        }

        return normalizeWhitespace(element.innerText || element.textContent);
      };

      const interactiveSelector = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "[role='button']",
        "[role='link']",
        "[role='menuitem']",
        "[role='tab']",
        "[role='option']",
        "[role='row']",
        "[role='gridcell']",
        "[role='treeitem']",
        "[role='listitem']",
        "[tabindex]:not([tabindex='-1'])",
        "[onclick]",
        "[jsaction]",
        "[contenteditable='true']",
      ].join(",");

      const interactiveElements = Array.from(
        document.querySelectorAll<HTMLElement>(interactiveSelector),
      )
        .filter((element) => isVisible(element) && isPotentiallyInteractive(element))
        .map((element, orderIndex) => {
          const tag = element.tagName.toLowerCase();
          const role = inferRole(element);
          const name = normalizeWhitespace(elementName(element));
          const descriptionParts: string[] = [];
          let priority = 0;

          if (name) {
            descriptionParts.push(name);
          }
          if (tag === "input") {
            descriptionParts.push(
              `input type ${(element.getAttribute("type") || "text").toLowerCase()}`,
            );
          }
          if (element.getAttribute("aria-expanded") === "true") {
            descriptionParts.push("expanded");
          }
          if (role && ["row", "option", "listitem", "treeitem", "gridcell"].includes(role)) {
            priority += 4;
          }
          if (["a", "button"].includes(tag)) {
            priority += 2;
          }
          if (name.length >= 20) {
            priority += 2;
          }
          if (name.length >= 60) {
            priority += 1;
          }
          if (name.length <= 2) {
            priority -= 1;
          }
          if (element.getAttribute("aria-haspopup") === "true") {
            priority += 1;
          }

          const enabled =
            !element.hasAttribute("disabled") &&
            element.getAttribute("aria-disabled") !== "true";

          const rect = element.getBoundingClientRect();
          const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
          const areaRatio = (rect.width * rect.height) / viewportArea;
          const looksLikeHugeContainer =
            !role &&
            !["a", "button", "input", "select", "textarea", "tr", "li", "td"].includes(tag) &&
            name.length > 240 &&
            areaRatio > 0.25;

          if (looksLikeHugeContainer) {
            return null;
          }

          return {
            elementId: assignElementId(element),
            tag,
            role,
            name: name || "(no label)",
            description: normalizeWhitespace(descriptionParts.join(" | ")),
            visible: true,
            enabled,
            _priority: priority,
            _orderIndex: orderIndex,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((left, right) => {
          if (right._priority !== left._priority) {
            return right._priority - left._priority;
          }
          return left._orderIndex - right._orderIndex;
        });

      const dedupInteractive = new Map<string, (typeof interactiveElements)[number]>();
      for (const item of interactiveElements) {
        if (!dedupInteractive.has(item.elementId)) {
          dedupInteractive.set(item.elementId, item);
        }
      }

      const formInputs = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,textarea,select",
        ),
      )
        .filter((element) => isVisible(element as HTMLElement))
        .map((element) => {
          const html = element as HTMLElement;
          return {
            elementId: assignElementId(html),
            type: (element.getAttribute("type") || element.tagName.toLowerCase()).toLowerCase(),
            name: normalizeWhitespace(
              element.getAttribute("name") ||
                element.getAttribute("aria-label") ||
                element.id ||
                "",
            ),
            placeholder: normalizeWhitespace(element.getAttribute("placeholder")),
            valuePreview: readElementValue(element).slice(0, 80),
            required: element.hasAttribute("required"),
            disabled:
              element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
          };
        });

      const textSelector = "h1,h2,h3,h4,p,li,label,[role='heading'],article,main,section";
      const textBlocks: { text: string; tag: string }[] = [];
      const seenText = new Set<string>();

      for (const element of Array.from(document.querySelectorAll<HTMLElement>(textSelector))) {
        if (!isVisible(element)) {
          continue;
        }

        const text = normalizeWhitespace(element.innerText || element.textContent);
        if (!text) {
          continue;
        }
        if (text.length < 20 && !element.tagName.match(/^H[1-4]$/)) {
          continue;
        }
        if (seenText.has(text)) {
          continue;
        }

        seenText.add(text);
        textBlocks.push({
          text,
          tag: element.tagName.toLowerCase(),
        });

        if (textBlocks.length >= 24) {
          break;
        }
      }

      const bodyText = normalizeWhitespace(document.body.innerText || "");
      const bodyLower = bodyText.toLowerCase();

      const hasModal = Array.from(
        document.querySelectorAll<HTMLElement>(
          "dialog,[role='dialog'],[aria-modal='true'],[class*='modal'],[id*='modal']",
        ),
      ).some((element) => isVisible(element));

      const signals = {
        loginPromptLikely:
          Array.from(document.querySelectorAll<HTMLInputElement>("input[type='password']")).some(
            (element) => isVisible(element),
          ) ||
          bodyLower.includes("sign in") ||
          bodyLower.includes("log in"),
        captchaLikely:
          document.querySelector(
            "[class*='captcha'],[id*='captcha'],iframe[src*='captcha'],[data-sitekey]",
          ) !== null,
        paymentStepLikely:
          bodyLower.includes("payment") ||
          bodyLower.includes("card number") ||
          bodyLower.includes("confirm order") ||
          bodyLower.includes("place order"),
        destructiveActionLikely:
          bodyLower.includes("delete") ||
          bodyLower.includes("permanently remove") ||
          bodyLower.includes("irreversible"),
      };

      return {
        url: window.location.href,
        title: document.title || "",
        pageToken: win.__agentRuntime!.documentToken,
        hasModal,
        interactiveElements: Array.from(dedupInteractive.values())
          .slice(0, 120)
          .map(({ _priority, _orderIndex, ...item }) => item),
        formInputs: formInputs.slice(0, 80),
        textBlocks,
        signals,
      };
    });

    const state: PageState = {
      url: raw.url,
      title: raw.title || "Untitled",
      timestamp: new Date().toISOString(),
      pageToken: raw.pageToken,
      hasModal: raw.hasModal,
      interactiveElements: raw.interactiveElements as InteractiveElement[],
      formInputs: raw.formInputs,
      textBlocks: raw.textBlocks,
      signals: raw.signals as PageSignals,
      summary: buildSummary(
        raw.title || "Untitled",
        raw.url,
        raw.interactiveElements.length,
        raw.formInputs.length,
        raw.hasModal,
        raw.signals as PageSignals,
      ),
    };

    return state;
  }

  async queryDom(question: string, maxResults = 8): Promise<DomQueryResult> {
    const state = await this.getPageState();
    const tokens = tokenize(question);
    const lowerQuestion = question.toLowerCase();
    const matches: DomQueryMatch[] = [];

    const pushMatch = (
      source: DomQueryMatch["source"],
      label: string,
      details: string,
      elementId?: string,
    ) => {
      const haystack = `${label} ${details}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 1;
        }
      }
      if (score === 0 && tokens.length > 0) {
        return;
      }

      matches.push({
        score: tokens.length === 0 ? 1 : score,
        source,
        elementId,
        label: truncate(label, 120),
        details: truncate(details, 160),
      });
    };

    for (const element of state.interactiveElements) {
      pushMatch(
        "interactive",
        element.name,
        `${element.description} [tag=${element.tag}, role=${element.role ?? "none"}]`,
        element.elementId,
      );
    }

    for (const input of state.formInputs) {
      pushMatch(
        "form",
        input.name || input.placeholder || input.type,
        `placeholder=${input.placeholder || "none"}, type=${input.type}, value=${input.valuePreview || "empty"}`,
        input.elementId,
      );
    }

    for (const text of state.textBlocks) {
      pushMatch("text", text.text, `tag=${text.tag}`);
    }

    const listIntent =
      /(first|latest|recent|top|last|перв|последн|спис|писем|сообщен|ваканс|заказ|items?)/i.test(
        lowerQuestion,
      );
    if (listIntent) {
      let bonus = 2;
      for (const element of state.interactiveElements) {
        if (!element.role) {
          continue;
        }
        if (!["row", "listitem", "option", "treeitem", "gridcell"].includes(element.role)) {
          continue;
        }
        matches.push({
          score: bonus,
          source: "interactive",
          elementId: element.elementId,
          label: truncate(element.name, 120),
          details: truncate(
            `${element.description} [tag=${element.tag}, role=${element.role}]`,
            160,
          ),
        });
        bonus = Math.max(1, bonus - 0.1);
        if (bonus <= 1.1) {
          // Keep only a compact fallback set.
          break;
        }
      }
    }

    if (listIntent) {
      for (const match of matches) {
        const low = `${match.label} ${match.details}`.toLowerCase();
        if (
          low.includes("role=row") ||
          low.includes("role=listitem") ||
          low.includes("role=option") ||
          low.includes("role=treeitem") ||
          low.includes("[tag=tr")
        ) {
          match.score += 4;
        }
        if (
          low.includes("role=link") &&
          /(входящ|черновик|корзин|ярлык|labels|inbox|drafts|trash|spam)/i.test(low)
        ) {
          match.score -= 2;
        }
        if (match.label.length > 180) {
          match.score -= 1;
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const trimmed = matches.slice(0, maxResults);

    let answer = "No strong DOM matches found for this question.";
    const rowLikeVisible = state.interactiveElements.filter((element) =>
      ["row", "listitem", "option", "treeitem", "gridcell"].includes(element.role ?? ""),
    ).length;

    if (trimmed.length > 0) {
      const top = trimmed[0];
      answer = `Found ${trimmed.length} relevant matches. Top match: "${top.label}" (${top.source}, score ${top.score}).`;
    }
    if (listIntent && rowLikeVisible < 3) {
      answer +=
        " It looks like the page is not in a full list view now. Return to the list view (go_back or visible Back/Close control), then refresh page state.";
    }

    return {
      question,
      answer,
      matches: trimmed,
      signals: state.signals,
    };
  }
}
