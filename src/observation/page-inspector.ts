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

function hasVacancySignals(haystack: string): boolean {
  return /(\u043e\u0442\u043a\u043b\u0438\u043a|apply|salary|\u0437\u0430\u0440\u043f\u043b\u0430\u0442|experience|\u043e\u043f\u044b\u0442|location|\u043b\u043e\u043a\u0430\u0446|remote|\u0443\u0434\u0430\u043b\u0435\u043d|per month|\u0437\u0430\s+\u043c\u0435\u0441\u044f\u0446|\u0440\u0443\u0431|\u20bd|\$|\u20ac)/i.test(
    haystack,
  );
}

function hasRoleSignals(haystack: string): boolean {
  return /(engineer|developer|scientist|analyst|manager|architect|qa|devops|designer|product|data|ai|ml|\u0438\u043d\u0436\u0435\u043d\u0435\u0440|\u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u0447\u0438\u043a|\u0430\u043d\u0430\u043b\u0438\u0442\u0438\u043a|\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440|\u0430\u0440\u0445\u0438\u0442\u0435\u043a\u0442\u043e\u0440|\u0434\u0438\u0437\u0430\u0439\u043d\u0435\u0440)/i.test(
    haystack,
  );
}

function isCompanyPromoVacancyCard(haystack: string): boolean {
  return (
    /(\u0430\u043a\u0442\u0438\u0432\u043d\w*\s+\u0432\u0430\u043a\u0430\u043d\u0441\u0438\w*|active\s+vacanc(?:y|ies)|\u043f\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c|view)/i.test(
      haystack,
    ) &&
    !hasVacancySignals(haystack)
  );
}

function isResumePromoCard(haystack: string): boolean {
  return /(\u0433\u043e\u0442\u043e\u0432\u043e\u0435\s+\u0440\u0435\u0437\u044e\u043c\u0435|\u0440\u0435\u043f\u0435\u0442\u0438\u0446\u0438\u044f\s+\u0441\u043e\u0431\u0435\u0441\u0435\u0434\u043e\u0432\u0430\u043d\u0438\u044f|\u043a\u0430\u0440\u044c\u0435\u0440\u043d\w*\s+\u043a\u043e\u043d\u0441\u0443\u043b\u044c\u0442|\u043d\u0430\u0441\u0442\u0430\u0432\u043d\u0438\u043a|\u043c\u0435\u043d\u0442\u043e\u0440|\u0434\u043e\u0432\u0435\u0440\u044c\u0442\u0435\s+\u0441\u043e\u0441\u0442\u0430\u0432\u043b\u0435\u043d\u0438\u0435\s+\u0440\u0435\u0437\u044e\u043c\u0435|\u0441\u043a\u0438\u0434\u043a|\u0434\u043e\s+\d{1,2}\.\d{1,2})/i.test(
    haystack,
  );
}

function isLikelyResumeEntry(haystack: string): boolean {
  if (isResumePromoCard(haystack)) {
    return false;
  }
  return /(\u0440\u0435\u0437\u044e\u043c|resume|cv|\u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d|\u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c|\u043f\u043e\u0434\u043d\u044f\u0442\u044c\s+\u0432\s+\u043f\u043e\u0438\u0441\u043a\u0435|\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\w*|\u0436\u0435\u043b\u0430\u0435\u043c\u0430\u044f\s+\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442\u044c|\u0436\u0435\u043b\u0430\u0435\u043c\u0430\u044f\s+\u0437\u0430\u0440\u043f\u043b\u0430\u0442\u0430)/i.test(
    haystack,
  );
}

function isResumeCreationControl(haystack: string): boolean {
  return /((create|new|add)\s+resume|resume\s+builder|\u0441\u043e\u0437\u0434\u0430\u0442\u044c\s+\u0440\u0435\u0437\u044e\u043c\u0435|\u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c\s+\u0440\u0435\u0437\u044e\u043c\u0435|\u043d\u043e\u0432\u043e\u0435\s+\u0440\u0435\u0437\u044e\u043c\u0435)/i.test(
    haystack,
  );
}

function hasExplicitListCue(question: string): boolean {
  return /(items?|list|rows?|cards?|messages?|vacanc|jobs?|orders?|emails?|results?|спис|ряд|карточ|сообщен|письм|ваканс|заказ|результат)/i.test(
    question,
  );
}

function isVacancyRequirementsQuestion(question: string): boolean {
  return /(requirement|responsibilit|qualification|skills?|experience|about the role|\u043e\u043f\u0438\u0441\u0430\u043d\u0438|\u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d|\u043e\u0431\u044f\u0437\u0430\u043d\u043d\u043e\u0441\u0442|\u043d\u0430\u0432\u044b\u043a|\u043e\u043f\u044b\u0442|\u0441\u0442\u0435\u043a)/i.test(
    question,
  );
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
      /(first|latest|recent|top|last|items?|list|rows?|messages?|vacanc|jobs?|orders?|\u043f\u0435\u0440\u0432|\u043f\u043e\u0441\u043b\u0435\u0434\u043d|\u0441\u043f\u0438\u0441|\u043f\u0438\u0441\u0435\u043c|\u0441\u043e\u043e\u0431\u0449\u0435\u043d|\u0432\u0430\u043a\u0430\u043d\u0441|\u0437\u0430\u043a\u0430\u0437)/i.test(
        lowerQuestion,
      );
    const vacancyIntent = /(vacanc|job|position|role|\u0440\u0430\u0431\u043e\u0442|\u0432\u0430\u043a\u0430\u043d\u0441|\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442)/i.test(
      lowerQuestion,
    );
    const onVacancyPage = /\/vacancy\/\d+/i.test(state.url.toLowerCase());
    const resumeIntent = /(resume|cv|\u0440\u0435\u0437\u044e\u043c|\u043f\u0440\u043e\u0444\u0438\u043b)/i.test(
      lowerQuestion,
    );
    const resumeFactsIntent =
      resumeIntent &&
      /(skill|experience|education|summary|role|\u043d\u0430\u0432\u044b\u043a|\u043e\u043f\u044b\u0442|\u043e\u0431\u0440\u0430\u0437\u043e\u0432\u0430\u043d|\u043e\u0431\u043e\s+\u043c\u043d\u0435|\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442)/i.test(
        lowerQuestion,
      );
    const vacancyDetailIntent =
      vacancyIntent &&
      /(title|company|requirement|salary|location|skills?|experience|\u043d\u0430\u0437\u0432\u0430\u043d|\u043a\u043e\u043c\u043f\u0430\u043d|\u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d|\u0437\u0430\u0440\u043f\u043b\u0430\u0442|\u043b\u043e\u043a\u0430\u0446|\u043d\u0430\u0432\u044b\u043a|\u043e\u043f\u044b\u0442|\u0441\u0441\u044b\u043b\u043a)/i.test(
        lowerQuestion,
      );
    const vacancyRequirementsIntent =
      (vacancyIntent || onVacancyPage) && isVacancyRequirementsQuestion(lowerQuestion);
    const listIntentForNavigationHints = hasExplicitListCue(lowerQuestion);
    const applyIntent =
      vacancyIntent &&
      /(apply|respond|quick apply|send application|\u043e\u0442\u043a\u043b\u0438\u043a|\u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c\s+\u0440\u0435\u0437\u044e\u043c\u0435|\u043f\u043e\u0434\u0430\u0442\u044c\s+\u0437\u0430\u044f\u0432\u043a\u0443)/i.test(
        lowerQuestion,
      );
    const coverLetterIntent =
      vacancyIntent &&
      /(cover[\s-]*letter|motivation|message to employer|\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0434|\u043f\u0438\u0441\u044c\u043c\u043e\s+\u0440\u0430\u0431\u043e\u0442\u043e\u0434\u0430\u0442\u0435\u043b\u044e|\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439\s+\u043a\s+\u043e\u0442\u043a\u043b\u0438\u043a\u0443)/i.test(
        lowerQuestion,
      );

    if (listIntentForNavigationHints) {
      let bonus = vacancyDetailIntent ? 1.5 : 2;
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
        const minBonus = vacancyDetailIntent ? 0.8 : 1;
        const stopAt = vacancyDetailIntent ? 0.9 : 1.1;
        bonus = Math.max(minBonus, bonus - 0.1);
        if (bonus <= stopAt) {
          // Keep only a compact fallback set.
          break;
        }
      }
    }

    if (listIntentForNavigationHints) {
      for (const match of matches) {
        const low = `${match.label} ${match.details}`.toLowerCase();
        const hasRowLikeRole =
          low.includes("role=row") ||
          low.includes("role=listitem") ||
          low.includes("role=option") ||
          low.includes("role=treeitem") ||
          low.includes("[tag=tr");
        const vacancySignal = hasVacancySignals(low);
        const roleSignal = hasRoleSignals(low);
        const companyPromoCard = isCompanyPromoVacancyCard(low);

        if (hasRowLikeRole) {
          if (vacancyDetailIntent) {
            match.score += vacancySignal || roleSignal ? 1.8 : 0.4;
          } else {
            match.score += 4;
          }
        }
        if (vacancyIntent) {
          if (low.includes("role=link") || low.includes("role=button")) {
            match.score += 0.9;
          }
          if (vacancySignal) {
            match.score += 2.2;
          }
          if (roleSignal) {
            match.score += 1.4;
          }
          if (
            /(\u043f\u0435\u0440\u0435\u0439\u0442\u0438\s+\u043a\s+\u043e\u0441\u043d\u043e\u0432\u043d\u043e\u043c\u0443\s+\u043a\u043e\u043d\u0442\u0435\u043d\u0442\u0443|\u043f\u043e\u0438\u0441\u043a|search|\u0443\u0434\u0430\u043b\u0438\u0442\u044c\s+\u0438\u0437\s+\u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0433\u043e|filters?|\u0444\u0438\u043b\u044c\u0442\u0440|sorting|\u0441\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u043a|\u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a)/i.test(
              low,
            )
          ) {
            match.score -= 2.5;
          }
          if (
            /(hh\s*pro|готовое\s+резюме|репетиция\s+собеседования|карьерн\w*\s+консульт|ментор|наставник|доверьте\s+составление\s+резюме|подписк|скидк)/i.test(
              low,
            ) &&
            !vacancySignal &&
            !roleSignal
          ) {
            match.score -= 8;
          }
        }
        if (vacancyDetailIntent) {
          if (low.includes("role=link") && (vacancySignal || roleSignal)) {
            match.score += 2.5;
          }
          if (roleSignal) {
            match.score += 1.8;
          }
          if (vacancySignal) {
            match.score += 2.2;
          }
          if (companyPromoCard) {
            match.score -= 6;
          }
          if (/(\u043d\u0430\u0439\u0434\u0435\u043d\u043e\s+\d+\s+\u0432\u0430\u043a\u0430\u043d\u0441|found\s+\d+\s+vacanc)/i.test(low)) {
            match.score -= 3;
          }
        }
        if (resumeIntent) {
          if (isResumePromoCard(low)) {
            match.score -= 8;
          }
          if (isResumeCreationControl(low)) {
            match.score -= resumeFactsIntent ? 9 : 6;
          }
          if (isLikelyResumeEntry(low)) {
            match.score += 4;
          }
          if (
            resumeFactsIntent &&
            /(\u043d\u0430\u0432\u044b\u043a|\u043e\u043f\u044b\u0442|\u043e\u0431\u0440\u0430\u0437\u043e\u0432\u0430\u043d|\u043e\u0431\u043e\s+\u043c\u043d\u0435|experience|skills?|education|summary)/i.test(
              low,
            )
          ) {
            match.score += 2.5;
          }
        }

        if (
          low.includes("role=link") &&
          /(\u0432\u0445\u043e\u0434\u044f\u0449|\u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a|\u043a\u043e\u0440\u0437\u0438\u043d|\u044f\u0440\u043b\u044b\u043a|labels|inbox|drafts|trash|spam)/i.test(
            low,
          )
        ) {
          match.score -= 2;
        }
        if (match.label.length > 180) {
          match.score -= 1;
        }
      }
    }

    if (
      applyIntent ||
      coverLetterIntent ||
      vacancyDetailIntent ||
      vacancyRequirementsIntent
    ) {
      for (const match of matches) {
        const low = `${match.label} ${match.details}`.toLowerCase();

        if (applyIntent) {
          if (
            /(apply|quick apply|respond|response|send application|\u043e\u0442\u043a\u043b\u0438\u043a|\u043e\u0442\u043a\u043b\u0438\u043a\u043d\u0443\u0442\u044c\u0441\u044f|\u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c\s+\u043e\u0442\u043a\u043b\u0438\u043a|\u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c\s+\u0440\u0435\u0437\u044e\u043c\u0435|\u043f\u043e\u0434\u0430\u0442\u044c\s+\u0437\u0430\u044f\u0432\u043a\u0443)/i.test(
              low,
            )
          ) {
            match.score += 6;
          }
          if (low.includes("role=button") || low.includes("role=link")) {
            match.score += 1.5;
          }
        }

        if (coverLetterIntent) {
          if (
            /(cover[\s-]*letter|motivation|message to employer|\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0434|\u043f\u0438\u0441\u044c\u043c\u043e\s+\u0440\u0430\u0431\u043e\u0442\u043e\u0434\u0430\u0442\u0435\u043b\u044e|\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439\s+\u043a\s+\u043e\u0442\u043a\u043b\u0438\u043a\u0443)/i.test(
              low,
            )
          ) {
            match.score += 7;
          }
          if (
            match.source === "form" ||
            low.includes("role=textbox") ||
            low.includes("tag=textarea")
          ) {
            match.score += 2.2;
          }
        }

        if (vacancyDetailIntent || vacancyRequirementsIntent) {
          if (
            /(requirement|responsibilit|qualification|skills?|experience|about the role|\u043e\u043f\u0438\u0441\u0430\u043d\u0438|\u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d|\u043e\u0431\u044f\u0437\u0430\u043d\u043d\u043e\u0441\u0442|\u043d\u0430\u0432\u044b\u043a|\u043e\u043f\u044b\u0442|\u0441\u0442\u0435\u043a)/i.test(
              low,
            )
          ) {
            match.score += 3;
          }
          if (match.source === "text") {
            match.score += 1.2;
          }
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
    } else if (vacancyDetailIntent || vacancyRequirementsIntent) {
      const detailBlock = state.textBlocks.find((item) =>
        /(requirement|responsibilit|qualification|skills?|experience|about the role|\u043e\u043f\u0438\u0441\u0430\u043d\u0438|\u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d|\u043e\u0431\u044f\u0437\u0430\u043d\u043d\u043e\u0441\u0442|\u043d\u0430\u0432\u044b\u043a|\u043e\u043f\u044b\u0442|\u0441\u0442\u0435\u043a)/i.test(
          item.text,
        ),
      );
      if (detailBlock) {
        const syntheticMatch: DomQueryMatch = {
          score: 3.5,
          source: "text",
          label: truncate(detailBlock.text, 120),
          details: `tag=${detailBlock.tag}`,
        };
        trimmed.push(syntheticMatch);
        answer = `Found contextual vacancy details in visible text: "${syntheticMatch.label}".`;
      }
    }
    const searchResultsLike =
      /\/search\/vacancy/i.test(state.url) ||
      state.textBlocks.some((item) =>
        /(\u043d\u0430\u0439\u0434\u0435\u043d\u043e\s+\d+\s+\u0432\u0430\u043a\u0430\u043d\u0441|found\s+\d+\s+vacanc)/i.test(
          item.text.toLowerCase(),
        ),
      );
    if (listIntentForNavigationHints && rowLikeVisible < 3 && !searchResultsLike) {
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
