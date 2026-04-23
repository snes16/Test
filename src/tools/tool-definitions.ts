import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Locator, Page } from "playwright";
import { z } from "zod";
import { parseRequestedItemCount } from "../agent/task-policy";
import {
  InboxCandidate,
  MessageClassification,
  PageState,
  ToolExecutionResult,
  VisitedMessage,
} from "../types";
import { ToolContext, ToolSpec } from "./tool-registry";

const ELEMENT_ID_SCHEMA = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);

const FINAL_PAYMENT_ACTION_RE =
  /(?:^|\b)pay(?:\b|\s*now)|confirm(?:\s+and)?\s+pay|place\s+order|submit\s+order|complete\s+(?:purchase|order)|buy\s+now|оплатить|подтверд(?:ить|ите)\s+(?:оплат|заказ)|оформить\s+заказ|списать\s+средства/i;

const DESTRUCTIVE_ACTION_RE =
  /delete|erase|destroy|purge|permanently\s+remove|clear\s+all|удалить|стереть|уничтожить|очистить\s+все|безвозврат/i;

const EXPLICIT_DESTRUCTIVE_GOAL_RE =
  /delete|remove|trash|archive|unsubscribe|spam|удал|очист|архив|спам|отпис/i;

const AUTH_DONE_RESPONSE_RE =
  /done|ready|continue|logged\s*in|resolved|completed|готов|выполн|продолж/i;

const EXPLICIT_APPROVAL_RE =
  /^(yes|y|approve|approved|confirm|confirmed|разрешаю|подтверждаю|да)\b/i;

const REJECT_RESPONSE_RE =
  /^(no|n|stop|cancel|abort|block|blocked|нет|не|стоп|отмена)\b/i;

function compact(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function hasLikelyLoginChallenge(state: PageState): boolean {
  if (!state.signals.loginPromptLikely) {
    return false;
  }
  return state.formInputs.some((input) => input.type.toLowerCase() === "password");
}

function isRejectResponse(answer: string): boolean {
  if (!answer.trim()) {
    return true;
  }
  return REJECT_RESPONSE_RE.test(answer.trim());
}

async function pauseForAuthenticationChallenge(
  context: ToolContext,
  actionName: string,
  state: PageState,
  trigger: "captcha" | "login",
): Promise<ToolExecutionResult> {
  const question =
    trigger === "captcha"
      ? "Security gate: captcha detected. Solve it manually in the browser, then type DONE to continue. Type STOP to block the task."
      : "Security gate: login required. Sign in manually in the browser, then type DONE to continue. Type STOP to block the task.";

  const answer = (await context.askUserInput(question)).trim();
  if (isRejectResponse(answer)) {
    return {
      ok: false,
      observation: {
        message: `Runtime security gate blocked ${actionName}: ${trigger} requires manual user handling.`,
        trigger,
        action: actionName,
        userResponse: answer || "(empty)",
        currentUrl: state.url,
        currentTitle: state.title,
      },
      control: {
        type: "blocked",
        reason: `${trigger} requires user handling.`,
      },
    };
  }

  if (AUTH_DONE_RESPONSE_RE.test(answer)) {
    return {
      ok: false,
      observation: {
        message:
          `Runtime security gate paused ${actionName} until manual ${trigger} handling. ` +
          "User marked it as done; refresh page state and continue.",
        trigger,
        action: actionName,
        userResponse: answer,
        currentUrl: state.url,
        currentTitle: state.title,
        nextActionHint: "Call get_page_state to continue after manual authentication/captcha.",
      },
    };
  }

  return {
    ok: false,
    observation: {
      message:
        `Runtime security gate requires explicit confirmation for ${trigger}. ` +
        "Type DONE after manual handling or STOP to block.",
      trigger,
      action: actionName,
      userResponse: answer || "(empty)",
      currentUrl: state.url,
      currentTitle: state.title,
    },
    control: {
      type: "blocked",
      reason: `Manual ${trigger} handling was not confirmed.`,
    },
  };
}

async function requestIrreversibleActionApproval(
  context: ToolContext,
  actionName: string,
  state: PageState,
  reason: string,
  controlLabel: string,
): Promise<ToolExecutionResult | null> {
  const prompt =
    `Security gate: ${reason}. Target control: "${controlLabel || "(no label)"}". ` +
    "Type YES to allow this action once, or STOP to block.";

  const answer = (await context.askUserInput(prompt)).trim();
  if (EXPLICIT_APPROVAL_RE.test(answer)) {
    return null;
  }

  return {
    ok: false,
    observation: {
      message: `Runtime security gate blocked ${actionName}.`,
      reason,
      target: controlLabel || "(no label)",
      userResponse: answer || "(empty)",
      currentUrl: state.url,
      currentTitle: state.title,
    },
    control: {
      type: "blocked",
      reason: `${reason} User did not provide explicit approval.`,
    },
  };
}

async function enforceRuntimeSecurityGate(
  context: ToolContext,
  input: {
    actionName: "click_element" | "type_text" | "press_key";
    elementId?: string;
    key?: string;
  },
): Promise<ToolExecutionResult | null> {
  let state: PageState;
  try {
    state = await context.inspector.getPageState();
  } catch {
    // Avoid blocking on transient inspection failures.
    return null;
  }

  if (state.signals.captchaLikely) {
    return pauseForAuthenticationChallenge(context, input.actionName, state, "captcha");
  }

  if (hasLikelyLoginChallenge(state)) {
    return pauseForAuthenticationChallenge(context, input.actionName, state, "login");
  }

  if (input.actionName === "click_element" && input.elementId) {
    const target = state.interactiveElements.find((item) => item.elementId === input.elementId);
    if (target) {
      const label = compact(`${target.name} ${target.description}`, 220);
      if (state.signals.paymentStepLikely && FINAL_PAYMENT_ACTION_RE.test(label)) {
        return requestIrreversibleActionApproval(
          context,
          input.actionName,
          state,
          "Potential payment confirmation action detected",
          label,
        );
      }

      if (
        state.signals.destructiveActionLikely &&
        DESTRUCTIVE_ACTION_RE.test(label) &&
        !EXPLICIT_DESTRUCTIVE_GOAL_RE.test(context.userGoal)
      ) {
        return requestIrreversibleActionApproval(
          context,
          input.actionName,
          state,
          "Potential destructive action detected",
          label,
        );
      }
    }
  }

  if (input.actionName === "press_key") {
    const key = (input.key ?? "").toLowerCase();
    const enterLike = key === "enter" || key.endsWith("+enter");
    if (enterLike && state.signals.paymentStepLikely) {
      return requestIrreversibleActionApproval(
        context,
        input.actionName,
        state,
        "Enter key on a payment-like step may confirm payment",
        `key=${input.key ?? "Enter"}`,
      );
    }
  }

  return null;
}

function ensureHttpUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^about:/.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

async function findElementLocator(
  getLocator: () => Locator,
  refresh: () => Promise<void>,
): Promise<Locator> {
  let locator = getLocator();
  if ((await locator.count()) === 0) {
    await refresh();
    locator = getLocator();
  }
  return locator;
}

async function probeElementState(locator: Locator): Promise<{
  found: boolean;
  visible: boolean;
  enabled: boolean;
}> {
  const handle = await locator.elementHandle({ timeout: 1200 }).catch(() => null);
  if (!handle) {
    return {
      found: false,
      visible: false,
      enabled: false,
    };
  }

  try {
    return await handle.evaluate((element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") >= 0.05 &&
        rect.width >= 2 &&
        rect.height >= 2;

      const enabled =
        !html.hasAttribute("disabled") && html.getAttribute("aria-disabled") !== "true";

      return {
        found: true,
        visible,
        enabled,
      };
    });
  } finally {
    await handle.dispose();
  }
}

function isListLikeElement(tag: string, role: string | null): boolean {
  if (["tr", "li", "td"].includes(tag)) {
    return true;
  }
  if (!role) {
    return false;
  }
  return ["row", "listitem", "option", "treeitem", "gridcell"].includes(role);
}

function recoveryCandidates(
  interactiveElements: Array<{
    elementId: string;
    tag: string;
    role: string | null;
    name: string;
  }>,
  max = 8,
): Array<{ elementId: string; tag: string; role: string | null; name: string }> {
  const rowLike = interactiveElements.filter((element) =>
    isListLikeElement(element.tag, element.role),
  );
  const source = rowLike.length > 0 ? rowLike : interactiveElements;
  return source.slice(0, max).map((element) => ({
    elementId: element.elementId,
    tag: element.tag,
    role: element.role,
    name: element.name,
  }));
}

function classifyCartControlIntent(label: string): "add" | "already_in_cart" | "other" {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "other";
  }

  if (/(^|\s)(в корзине|in cart|already in cart|уже в корзине)(\s|$)/i.test(normalized)) {
    return "already_in_cart";
  }

  const hasCartWord = /(cart|basket|bag|корзин)/i.test(normalized);
  const hasAddIntent = hasCartWord
    ? /(add|put|place|добав|полож|закин|в\s*корзин|to\s+(?:cart|basket|bag)|into\s+(?:cart|basket|bag)|in\s+(?:cart|basket|bag))/i.test(
        normalized,
      )
    : false;

  const hasBuyIntent = /(^|\s)(buy|купить)(\s|$)|buy-btn|btn-buy|кнопка купить/i.test(normalized);

  if (hasAddIntent || hasBuyIntent) {
    return "add";
  }

  const looksLikeNavigation =
    /(go\s+to|view|open|my\s+cart|checkout|перейти|открыть|просмотр|оформ)/i.test(normalized);
  if (looksLikeNavigation) {
    return "other";
  }

  return "other";
}

function cartPageHasItems(state: PageState): boolean {
  const lowerUrl = state.url.toLowerCase();
  const lowerTitle = state.title.toLowerCase();
  const cartLike =
    /\/cart(?:\/|\?|$)/i.test(lowerUrl) ||
    /\b(cart|basket|корзин)\b/i.test(`${lowerUrl} ${lowerTitle}`);
  if (!cartLike) {
    return false;
  }

  const genericLink = /(вернуться|главн|home|каталог|catalog|поиск|search|доставка|контакт|контакты|акции|услов|помощ|support|войти|login|регистрац|profile|профиль|избран|сравн)/i;

  const productLinks = state.interactiveElements.filter(
    (element) =>
      element.visible &&
      element.enabled &&
      element.tag === "a" &&
      element.name.trim().length >= 16 &&
      !genericLink.test(element.name),
  );

  const hasCartControls = state.interactiveElements.some((element) =>
    /(удалить|remove|checkout|оформ|к оплате|перейти к оформлению|order|заказ)/i.test(
      element.name,
    ),
  );

  return productLinks.length > 0 && hasCartControls;
}

function isResumeSelectionQuestion(question: string): boolean {
  const normalized = question.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  const mentionsResume = /(resume|cv|резюм|профил)/i.test(normalized);
  if (!mentionsResume) {
    return false;
  }

  return /(which|what|choose|select|pick|use|како|какой|какую|выбери|выбрать|использ)/i.test(
    normalized,
  );
}

function detectSingleVisibleResumeOption(
  state: PageState,
): { elementId: string; label: string } | null {
  const rawCandidates = state.interactiveElements.filter(
    (element) =>
      element.visible &&
      element.enabled &&
      /(resume|cv|резюм)/i.test(`${element.name} ${element.description}`),
  );

  const uniqueByLabel = new Map<string, { elementId: string; label: string }>();
  for (const candidate of rawCandidates) {
    const label = compact(`${candidate.name} ${candidate.description}`, 160);
    const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length < 6) {
      continue;
    }
    if (
      /(new\s+resume|create\s+resume|add\s+resume|создать\s+резюме|добавить\s+резюме|готовое\s+резюме|репетиция\s+собеседования|карьерн\w*\s+консульт|ментор|наставник|доверьте\s+составление\s+резюме|скидк|до\s+\d{1,2}\.\d{1,2})/i.test(
        normalized,
      )
    ) {
      continue;
    }
    if (!uniqueByLabel.has(normalized)) {
      uniqueByLabel.set(normalized, {
        elementId: candidate.elementId,
        label,
      });
    }
  }

  if (uniqueByLabel.size !== 1) {
    return null;
  }
  return Array.from(uniqueByLabel.values())[0] ?? null;
}

function isVacancySearchListPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return (
    normalized === "/search/vacancy" ||
    normalized.startsWith("/search/vacancy/") ||
    normalized.includes("/vacancy/search") ||
    normalized.includes("/search/job") ||
    normalized.includes("/jobs/search")
  );
}

function extractVacancyIdFromPath(pathname: string): string | null {
  const normalized = pathname.toLowerCase();
  const idMatch =
    normalized.match(/\/vacanc(?:y|ies)\/(\d{4,})/) ??
    normalized.match(/\/job\/(\d{4,})/) ??
    normalized.match(/\/jobs\/(\d{4,})/) ??
    normalized.match(/\/(?:работ|ваканс)[^/]*\/(\d{4,})/);
  return idMatch?.[1] ?? null;
}

function isLikelyVacancyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (isVacancySearchListPath(pathname)) {
      return false;
    }
    if (extractVacancyIdFromPath(pathname)) {
      return true;
    }
    if (pathname.includes("/vacancy/") || pathname.includes("/job/") || pathname.includes("/career/")) {
      return true;
    }
    if (
      (pathname.includes("/vacancy") || pathname.includes("/job")) &&
      parsed.searchParams.has("id")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function vacancyFingerprintFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (isVacancySearchListPath(pathname)) {
      return null;
    }

    const vacancyId = extractVacancyIdFromPath(pathname);
    if (vacancyId) {
      return `vacancy:${vacancyId}`;
    }

    if (pathname.includes("/vacancy/") || pathname.includes("/job/") || pathname.includes("/career/")) {
      return `url:${`${parsed.origin}${parsed.pathname}`.toLowerCase()}`;
    }
    return null;
  } catch {
    const normalized = url.toLowerCase();
    const idMatch = normalized.match(/\/vacanc(?:y|ies)\/(\d{4,})|\/job\/(\d{4,})/);
    if (idMatch?.[1] || idMatch?.[2]) {
      return `vacancy:${idMatch[1] ?? idMatch[2]}`;
    }
    return null;
  }
}

function vacancyFingerprintFromText(text: string): string | null {
  const normalized = normalizeFingerprintPart(text).replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 40) {
    return null;
  }

  if (
    /(найдено\s+\d+\s+ваканс|found\s+\d+\s+vacanc)/i.test(normalized) &&
    !/(отклик|apply|salary|зарплат)/i.test(normalized)
  ) {
    return null;
  }

  const hasRoleSignals =
    /(engineer|developer|scientist|analyst|manager|architect|qa|devops|designer|product|data|ai|ml|инженер|разработчик|аналитик|менеджер|архитектор|тестиров|дизайнер)/i.test(
      normalized,
    );
  const hasDetailSignals =
    /(отклик|apply|experience|опыт|salary|зарплат|per month|за месяц|удален|remote|руб|₽|\$|€|location|локац|гибрид|офис)/i.test(
      normalized,
    );
  if (!(hasRoleSignals && hasDetailSignals)) {
    return null;
  }

  if (
    /(активн\w*\s+ваканси\w*\s+посмотр|active\s+vacanc(?:y|ies)\s+view)/i.test(normalized) &&
    !/(отклик|apply|salary|зарплат|опыт|experience)/i.test(normalized)
  ) {
    return null;
  }

  return `vacancy:list:${stableHash(normalized.slice(0, 260))}`;
}

function sanitizeCurrentVacancyFingerprint(current: string | null): string | null {
  if (!current) {
    return null;
  }
  if (current.startsWith("url:") && current.toLowerCase().includes("/search/vacancy")) {
    return null;
  }
  return current;
}

function classifyJobControlIntent(label: string): "apply" | "other" {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "other";
  }

  if (
    /(apply|quick apply|respond|response|send application|отклик|откликнуться|отправить отклик|отправить резюме|подать заявку)/i.test(
      normalized,
    )
  ) {
    return "apply";
  }

  return "other";
}

function isLikelyCoverLetterLabel(label: string): boolean {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return /(cover[\s-]*letter|motivation|message to employer|сопровод|письмо работодателю|комментарий к отклику)/i.test(
    normalized,
  );
}

function isResumePromoCardLabel(label: string): boolean {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return /(подписк|преимуществ\w*\s+подписк|готовое\s+резюме|репетиция\s+собеседования|карьерн\w*\s+консульт|ментор|наставник|доверьте\s+составление\s+резюме|скидк|до\s+\d{1,2}\.\d{1,2})/i.test(
    normalized,
  );
}

function isLikelyResumeEntryLabel(label: string): boolean {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || isResumePromoCardLabel(normalized)) {
    return false;
  }
  return /(резюм|resume|cv|обновлен|редактировать|поднять\s+в\s+поиске|просмотр\w*|желаемая\s+должность|желаемая\s+зарплата|постоянная\s+работа|fullstack|разработчик|инженер|уровень\s+дохода|удал[её]нно|опыт\s+работы)/i.test(
    normalized,
  );
}

function isMeaningfulVacancyExtraction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  if (normalized.length >= 280) {
    return true;
  }

  const hasRoleSignals =
    /(engineer|developer|scientist|analyst|manager|architect|qa|devops|designer|product|data|ai|ml|инженер|разработчик|аналитик|менеджер|архитектор|тестиров|дизайнер)/i.test(
      normalized,
    );
  const hasDetailSignals =
    /(requirement|responsibilit|qualification|skills?|experience|salary|location|about the role|отклик|требован|обязанност|навык|опыт|зарплат|локац)/i.test(
      normalized,
    );

  return hasRoleSignals && hasDetailSignals;
}

function isLikelyProfileResumeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      /\/(applicant|candidate)\/(?:resumes?|profile)(?:\/|$)/i.test(path) ||
      /\/profile\/(?:me|resume)?(?:\/|$)/i.test(path) ||
      /\/resume(?:\/|$)/i.test(path) ||
      /\/cv(?:\/|$)/i.test(path)
    );
  } catch {
    return false;
  }
}

function isLikelyApplicationResponseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      /\/applicant\/vacancy_response(?:\/|$)/i.test(path) ||
      /\/vacancy\/response(?:\/|$)/i.test(path) ||
      /\/application(?:\/|$)/i.test(path) ||
      /\/apply(?:\/|$)/i.test(path)
    );
  } catch {
    return false;
  }
}

function isLikelyProfileContextExtraction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 140) {
    return false;
  }

  const hasProfileSignals =
    /(summary|about|profile|experience|skills?|education|position|роль|должност|опыт\s+работы|навык|образован|обо\s+мне)/i.test(
      normalized,
    );
  if (!hasProfileSignals) {
    return false;
  }

  const hasTechnicalSpecifics =
    /(python|typescript|javascript|java|go|sql|docker|kubernetes|aws|gcp|azure|ml|ai|llm|nlp|cv|data|инженер|разработчик|аналитик)/i.test(
      normalized,
    );

  return hasTechnicalSpecifics || normalized.length >= 280;
}

function isLikelyResumeDetailUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      (/^\/resume\/[a-z0-9_-]{6,}(?:\/|$)/i.test(path) ||
        /^\/cv\/[a-z0-9_-]{6,}(?:\/|$)/i.test(path)) &&
      !/^\/(?:resume|cv)\/edit\//i.test(path)
    );
  } catch {
    return false;
  }
}

function hasRoleOrTechSignals(text: string): boolean {
  return /(engineer|developer|scientist|analyst|manager|architect|fullstack|frontend|backend|data|ml|ai|llm|python|typescript|javascript|react|vue|java|go|sql|инженер|разработчик|аналитик|архитектор|фуллстек|фронтенд|бэкенд|дата|данн)/i.test(
    text,
  );
}

function hasProfileDetailSignals(text: string): boolean {
  return /(experience|опыт|skills?|навык|education|образован|salary|зарплат|доход|employment|занятост|contacts?|контакт|summary|о\s+себе|о\s+мне|responsibilit|обязанност)/i.test(
    text,
  );
}

function isLikelyProfileContextFromState(state: PageState): boolean {
  const evidence = [
    state.title,
    ...state.textBlocks.slice(0, 18).map((item) => item.text),
    ...state.interactiveElements.slice(0, 36).map((item) => `${item.name} ${item.description}`),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!evidence || evidence.length < 80) {
    return false;
  }

  if (isLikelyProfileContextExtraction(evidence)) {
    return true;
  }

  const roleOrTech = hasRoleOrTechSignals(evidence);
  const profileDetails = hasProfileDetailSignals(evidence);
  if (roleOrTech && profileDetails) {
    return true;
  }

  return false;
}

function tryMarkProfileContextExtracted(context: ToolContext, state: PageState): void {
  const job = context.runtimeStats.jobApplication;
  if (!job.enabled || job.profileContextExtracted) {
    return;
  }
  if (!isLikelyProfileResumeUrl(state.url)) {
    return;
  }

  if (isLikelyResumeDetailUrl(state.url)) {
    const titleAndText = `${state.title} ${state.summary}`.replace(/\s+/g, " ").trim();
    if (titleAndText.length >= 16 && hasRoleOrTechSignals(titleAndText)) {
      job.profileContextExtracted = true;
      return;
    }
  }

  if (isLikelyProfileContextFromState(state)) {
    job.profileContextExtracted = true;
  }
}

async function clickNestedApplyControl(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((element) => {
      const root = element as HTMLElement;
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (node: HTMLElement): boolean => {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      };
      const isEnabled = (node: HTMLElement): boolean =>
        !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true";
      const isApplyLike = (text: string): boolean =>
        /(apply|quick apply|respond|response|send application|отклик|откликнуться|отправить отклик|отправить резюме|подать заявку|vacancy[-_].*response|vacancy-serp__vacancy_response|vacancy_response)/i.test(
          text,
        );

      const candidates: HTMLElement[] = [];
      if (root) {
        candidates.push(root);
      }
      for (const node of Array.from(
        root.querySelectorAll<HTMLElement>(
          "button,a,[role='button'],input[type='submit'],input[type='button']",
        ),
      )) {
        candidates.push(node);
      }

      for (const candidate of candidates) {
        if (!isVisible(candidate) || !isEnabled(candidate)) {
          continue;
        }
        const label = [
          normalize(candidate.innerText || candidate.textContent || ""),
          normalize(candidate.getAttribute("aria-label")),
          normalize(candidate.getAttribute("title")),
          normalize(candidate.getAttribute("name")),
          normalize(candidate.getAttribute("data-qa")),
        ]
          .filter(Boolean)
          .join(" ");
        if (!label) {
          continue;
        }
        if (isApplyLike(label)) {
          candidate.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function clickNestedPrimaryLink(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((element) => {
      const root = element as HTMLElement;
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (node: HTMLElement): boolean => {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      };

      const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));
      if (links.length === 0) {
        return false;
      }

      const scored = links
        .map((link) => {
          const href = normalize(link.getAttribute("href") || link.href);
          if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
            return null;
          }

          let score = 0;
          const label = normalize(link.innerText || link.textContent || "");
          if (label.length >= 8) {
            score += Math.min(label.length, 80);
          }
          if (/vacanc|job|career|работ|ваканс|position/i.test(href)) {
            score += 140;
          }
          if (/vacanc|job|engineer|работ|ваканс|инженер/i.test(label)) {
            score += 80;
          }
          if (link.target === "_blank") {
            score += 20;
          }
          return {
            link,
            score,
          };
        })
        .filter((item): item is { link: HTMLAnchorElement; score: number } => item !== null)
        .sort((left, right) => right.score - left.score);

      for (const item of scored) {
        const candidate = item.link;
        if (!isVisible(candidate)) {
          continue;
        }
        candidate.click();
        return true;
      }

      return false;
    })
    .catch(() => false);
}

async function clickVisibleApplyControl(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (node: HTMLElement): boolean => {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      };
      const isEnabled = (node: HTMLElement): boolean =>
        !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true";
      const isApplyLike = (text: string): boolean =>
        /(apply|quick apply|respond|response|send application|отклик|откликнуться|отправить отклик|отправить резюме|подать заявку|vacancy[-_].*response|vacancy-serp__vacancy_response|vacancy_response)/i.test(
          text,
        );

      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button,a,[role='button'],input[type='submit'],input[type='button']",
        ),
      );
      for (const control of controls) {
        if (!isVisible(control) || !isEnabled(control)) {
          continue;
        }
        const label = [
          normalize(control.innerText || control.textContent || ""),
          normalize(control.getAttribute("aria-label")),
          normalize(control.getAttribute("title")),
          normalize(control.getAttribute("name")),
          normalize(control.getAttribute("data-qa")),
        ]
          .filter(Boolean)
          .join(" ");
        if (!label) {
          continue;
        }
        if (isApplyLike(label)) {
          control.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function detectApplyConfirmation(
  page: Page,
  locator: Locator,
): Promise<{ confirmed: boolean; evidence: string | null }> {
  const confirmationRe =
    /(вы\s+откликнул|отклик\s+отправлен|резюме\s+отправлен|уже\s+откликнул|отменить\s+отклик|application\s+sent|already\s+applied|withdraw\s+application|applied\s+success)/i;

  const fromControl = await locator
    .evaluate((element) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const html = element as HTMLElement;
      const className = (() => {
        const raw = html.className;
        if (typeof raw === "string") {
          return raw;
        }
        if (typeof (raw as { baseVal?: string } | null)?.baseVal === "string") {
          return (raw as { baseVal?: string }).baseVal ?? "";
        }
        return "";
      })();

      return [
        normalize(html.innerText || html.textContent || ""),
        normalize(html.getAttribute("aria-label")),
        normalize(html.getAttribute("title")),
        normalize(className),
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 400);
    })
    .catch(() => "");
  if (fromControl && confirmationRe.test(fromControl)) {
    return {
      confirmed: true,
      evidence: fromControl,
    };
  }

  const fromPage = await page
    .evaluate(() => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const body = normalize(document.body?.innerText || "");
      return body.slice(0, 2400);
    })
    .catch(() => "");

  if (fromPage && confirmationRe.test(fromPage)) {
    return {
      confirmed: true,
      evidence: fromPage.slice(0, 260),
    };
  }

  return {
    confirmed: false,
    evidence: null,
  };
}

function resolveCurrentVacancyFingerprint(
  current: string | null,
  beforeUrl: string,
  afterUrl: string,
  fallbackText = "",
): string | null {
  const fromAfterUrl = vacancyFingerprintFromUrl(afterUrl);
  if (fromAfterUrl) {
    return fromAfterUrl;
  }
  const fromBeforeUrl = vacancyFingerprintFromUrl(beforeUrl);
  if (fromBeforeUrl) {
    return fromBeforeUrl;
  }
  const fromText = vacancyFingerprintFromText(fallbackText);
  if (fromText) {
    return fromText;
  }
  return sanitizeCurrentVacancyFingerprint(current);
}

function jobProgress(context: ToolContext): {
  enabled: boolean;
  targetApplyCount: number;
  profileContextExtracted: boolean;
  openedVacancies: number;
  extractedVacancies: number;
  appliedVacancies: number;
  coverLetters: number;
  currentVacancyFingerprint: string | null;
} {
  const job = context.runtimeStats.jobApplication;
  return {
    enabled: job.enabled,
    targetApplyCount: job.targetApplyCount,
    profileContextExtracted: job.profileContextExtracted,
    openedVacancies: job.openedVacancyFingerprints.size,
    extractedVacancies: job.extractedVacancyFingerprints.size,
    appliedVacancies: job.appliedVacancyFingerprints.size,
    coverLetters: job.coverLetterVacancyFingerprints.size,
    currentVacancyFingerprint: job.currentVacancyFingerprint,
  };
}

function normalizeFingerprintPart(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9@._:/ -]/g, "")
    .trim();
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

function extractThreadOrMessageIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const keys = [
      "th",
      "thread",
      "threadId",
      "messageId",
      "message",
      "msg",
      "mid",
      "id",
      "conversation",
      "conv",
    ];
    for (const key of keys) {
      const value = parsed.searchParams.get(key);
      if (value && value.length >= 5) {
        return normalizeFingerprintPart(value);
      }
    }

    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    if (hash) {
      const splitIndex = hash.indexOf("?");
      const hashPath = splitIndex >= 0 ? hash.slice(0, splitIndex) : hash;
      const hashQuery = splitIndex >= 0 ? hash.slice(splitIndex + 1) : "";

      const hashSegments = hashPath
        .split(/[\/:&]/)
        .map(normalizeFingerprintPart)
        .filter(Boolean);

      for (const segment of hashSegments) {
        if (segment.length >= 12 && /[a-z0-9]/.test(segment)) {
          return segment;
        }
      }

      if (hashQuery) {
        const hashParams = new URLSearchParams(hashQuery);
        for (const key of keys) {
          const value = hashParams.get(key);
          if (value && value.length >= 5) {
            return normalizeFingerprintPart(value);
          }
        }
      }
    }

    const pathMatch = parsed.pathname.match(
      /(?:thread|message|messages|mail|conversation|conv|m)\/([A-Za-z0-9._-]{6,})/i,
    );
    if (pathMatch?.[1]) {
      return normalizeFingerprintPart(pathMatch[1]);
    }

    const longToken = `${parsed.pathname}/${parsed.hash}`.match(/([A-Za-z0-9_-]{16,})/);
    if (longToken?.[1]) {
      return normalizeFingerprintPart(longToken[1]);
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeThreadHintToFingerprint(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) {
    return null;
  }

  const fromUrl = extractThreadOrMessageIdFromUrl(raw);
  if (fromUrl) {
    return `url:${fromUrl}`;
  }

  const normalized = normalizeFingerprintPart(raw);
  if (normalized.length >= 10 && /[a-z0-9]/.test(normalized)) {
    return `url:${normalized}`;
  }

  return null;
}

function buildPreviewFingerprint(preview: string, url: string): string {
  let contextPart = normalizeFingerprintPart(url);
  try {
    const parsed = new URL(url);
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const hashRoot = hash.split("/")[0] ?? "";
    contextPart = normalizeFingerprintPart(`${parsed.origin}${parsed.pathname}#${hashRoot}`);
  } catch {
    // Fallback to raw url normalization.
  }

  const base = `${contextPart}|${normalizeFingerprintPart(preview)}`;
  return `preview:${stableHash(base)}`;
}

function buildFallbackFingerprint(fields: {
  sender: string;
  subject: string;
  timestampLabel: string;
  snippet: string;
}): string {
  const base = [
    normalizeFingerprintPart(fields.sender),
    normalizeFingerprintPart(fields.subject),
    normalizeFingerprintPart(fields.timestampLabel),
    normalizeFingerprintPart(fields.snippet),
  ].join("|");
  return `fallback:${stableHash(base)}`;
}

function looksLikeUiNoise(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("почтапоискtab") ||
    normalized.includes("перейти к содержимому") ||
    normalized.includes("gmail используется") ||
    normalized.includes("отправить отзыв") ||
    normalized.includes("разрешите уведомления gmail")
  );
}

function sanitizeSubject(value: string): string {
  if (!value) {
    return "";
  }

  let clean = value.replace(/\s+/g, " ").trim();
  clean = clean.replace(/\s*-\s*[^-]+@[^-]+\s*-\s*gmail\s*$/i, "").trim();

  if (looksLikeUiNoise(clean)) {
    return "";
  }

  if (clean.length < 3) {
    return "";
  }

  return clean.slice(0, 180);
}

function sanitizeSender(value: string): string {
  if (!value) {
    return "";
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch?.[0]) {
    return emailMatch[0].toLowerCase();
  }

  let clean = value.replace(/\s+/g, " ").trim();
  clean = clean.replace(/\s*(отказаться от рассылки|ответить|ещ[её] кому:.*)$/i, "").trim();
  if (looksLikeUiNoise(clean)) {
    return "";
  }
  if (clean.length < 2) {
    return "";
  }
  return clean.slice(0, 120);
}

function parseInboxPreviewHints(preview: string): {
  senderHint: string;
  subjectHint: string;
} {
  const parts = preview
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const senderFromFirst = sanitizeSender(parts[0] ?? "");
  const subjectFromSecond = sanitizeSubject(parts[1] ?? "");
  const subjectFromFirst = sanitizeSubject(parts[0] ?? "");

  const senderHint = senderFromFirst;
  const subjectHint = subjectFromSecond || (senderFromFirst ? subjectFromFirst : "");

  return { senderHint, subjectHint };
}

function extractFirstEmail(value: string): string {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() ?? "";
}

function deriveSubjectFromExtractedText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const removedUi = normalized
    .replace(/Перейти к содержимому[^.]{0,300}/i, "")
    .replace(/ПочтаПоискTABСправкаОбучениеОтправить отзыв в Google/gi, "")
    .replace(/Разрешите уведомления Gmail[^.]{0,200}/i, "")
    .trim();

  const subjectPattern =
    /(?:тема|subject)\s*[:\-]\s*([^|,.;]{4,160})/i;
  const subjectMatch = removedUi.match(subjectPattern);
  if (subjectMatch?.[1]) {
    return sanitizeSubject(subjectMatch[1]);
  }

  const sentence = removedUi
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .find((item) => item.length >= 6 && item.length <= 180 && !looksLikeUiNoise(item));

  if (sentence) {
    return sanitizeSubject(sentence);
  }

  return "";
}

function resolveMessageIdentity(
  pending: {
    subjectHint?: string;
    senderHint?: string;
    preview?: string;
  } | null,
  metadata: {
    subject: string;
    sender: string;
    title: string;
    snippet: string;
  },
  extractedText: string,
): {
  subject: string;
  sender: string;
  snippet: string;
} {
  const sender = [
    sanitizeSender(pending?.senderHint ?? ""),
    sanitizeSender(metadata.sender),
    sanitizeSender(extractFirstEmail(extractedText)),
  ].find((item) => item.length > 0) ?? "";

  const subject = [
    sanitizeSubject(pending?.subjectHint ?? ""),
    sanitizeSubject(metadata.subject),
    sanitizeSubject(metadata.title),
    deriveSubjectFromExtractedText(extractedText),
  ].find((item) => item.length > 0) ?? "Без темы";

  const snippet = (
    sanitizeSubject(pending?.preview ?? "") ||
    sanitizeSubject(metadata.snippet) ||
    sanitizeSubject(extractedText)
  ).slice(0, 240);

  return {
    subject,
    sender,
    snippet,
  };
}

function classifyMessageText(
  extractedText: string,
  subject: string,
  sender: string,
  options?: {
    treatVerificationAsSuspicious?: boolean;
  },
): MessageClassification {
  const text = `${subject}\n${sender}\n${extractedText}`.toLowerCase();
  const treatVerificationAsSuspicious = Boolean(options?.treatVerificationAsSuspicious);
  const suspiciousHints = [
    "limited time",
    "act now",
    "buy now",
    "winner",
    "congratulations",
    "free gift",
    "earn money",
    "investment opportunity",
    "unsubscribe",
    "promo code",
    "special offer",
    "casino",
    "crypto",
    "loan approval",
    "claim reward",
    "click here",
    "вы выиграли",
    "поздравляем",
    "ограниченное предложение",
    "только сегодня",
    "промокод",
    "спецпредложение",
    "бонус",
    "лотерея",
    "казино",
    "крипто",
    "одобрение займа",
    "быстрый займ",
    "заработок",
    "инвестиции",
    "перейдите по ссылке",
    "нажмите здесь",
    "в спам",
    "отписаться",
  ];
  const score = suspiciousHints.reduce(
    (accumulator, hint) => (text.includes(hint) ? accumulator + 1 : accumulator),
    0,
  );

  const hasVerificationKeyword =
    /(verification\s*code|otp|one[-\s]?time\s*(?:code|pass(?:word)?)|two[-\s]?factor|2fa|security code|login code|код[^\s]{0,8}\s+подтвержд|код[^\s]{0,8}\s+вход|код[^\s]{0,8}\s+авторизац|одноразов[^\s]{0,8}\s+код|код[^\s]{0,8}\s+из\s+sms)/i.test(
      text,
    );
  const hasCodePattern =
    /\b(?:code|otp|парол|код)\b[^\n\r]{0,40}\b\d{4,8}\b/i.test(text) ||
    /\b\d{4,8}\b[^\n\r]{0,40}\b(?:code|otp|парол|код)\b/i.test(text);
  const isVerificationLike = hasVerificationKeyword && hasCodePattern;

  if (treatVerificationAsSuspicious && isVerificationLike) {
    return "suspicious";
  }

  return score >= 2 ? "suspicious" : "normal";
}

async function attemptMailboxCleanupAction(
  context: ToolContext,
): Promise<{
  attempted: boolean;
  succeeded: boolean;
  actionLabel: string | null;
}> {
  const page = context.browser.getPage();
  const clicked = await page
    .evaluate(() => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      };

      const enabled = (element: HTMLElement): boolean =>
        !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";

      const destructiveLabel = (element: HTMLElement): string => {
        return normalize(
          [
            element.innerText,
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-tooltip"),
            element.getAttribute("data-tooltip-override"),
          ]
            .filter(Boolean)
            .join(" "),
        );
      };

      const deleteLike = (label: string): boolean =>
        /(delete|trash|remove|spam|junk|mark as spam|move to spam|удал|корзин|спам|в\s+спам|мусор)/i.test(
          label,
        );
      const permanentLike = (label: string): boolean =>
        /(permanent|forever|hard\s*delete|безвозврат|навсегда)/i.test(label);

      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button,[role='button'],input[type='button'],input[type='submit']",
        ),
      );

      const scored = controls
        .filter((control) => visible(control) && enabled(control))
        .map((control) => {
          const label = destructiveLabel(control);
          if (!label || !deleteLike(label) || permanentLike(label)) {
            return null;
          }
          let score = 0;
          if (/(spam|junk|спам|в\s+спам)/i.test(label)) {
            score += 20;
          }
          if (/(delete|trash|remove|удал|корзин|мусор)/i.test(label)) {
            score += 10;
          }
          if (/toolbar|actions|панель/i.test(control.className || "")) {
            score += 3;
          }
          return { control, label, score };
        })
        .filter((item): item is { control: HTMLElement; label: string; score: number } =>
          Boolean(item),
        )
        .sort((left, right) => right.score - left.score);

      const target = scored[0];
      if (!target) {
        return {
          clicked: false,
          label: null,
        };
      }

      target.control.click();
      return {
        clicked: true,
        label: target.label,
      };
    })
    .catch(() => ({ clicked: false, label: null as string | null }));

  if (clicked.clicked) {
    await page.waitForTimeout(300);
  }

  return {
    attempted: clicked.clicked,
    succeeded: clicked.clicked,
    actionLabel: clicked.label,
  };
}

function collectInboxCandidates(state: PageState, visitedPreviews: Set<string>): InboxCandidate[] {
  const listLike = state.interactiveElements.filter((element) =>
    isListLikeElement(element.tag, element.role),
  );

  const primaryRows = listLike.filter(
    (element) => element.tag === "tr" || element.role === "row",
  );

  const source = (primaryRows.length >= 3 ? primaryRows : listLike).slice(0, 120);
  return source.map((element, rowIndex) => {
    const preview = `${element.name} ${element.description}`.replace(/\s+/g, " ").trim();
    const hints = parseInboxPreviewHints(element.name || preview);
    const previewFingerprint = buildPreviewFingerprint(preview, state.url);
    return {
      rowIndex,
      elementId: element.elementId,
      preview: preview.slice(0, 220),
      previewFingerprint,
      senderHint: hints.senderHint,
      subjectHint: hints.subjectHint,
      alreadyVisited: visitedPreviews.has(previewFingerprint),
    };
  });
}

function updateMailboxListState(context: ToolContext, state: PageState): InboxCandidate[] {
  const mailboxScan = context.runtimeStats.mailboxScan;
  if (!mailboxScan.enabled) {
    return [];
  }

  // Do not rebuild inbox candidates while an individual thread/message is open.
  if (extractThreadOrMessageIdFromUrl(state.url)) {
    return mailboxScan.latestListCandidates;
  }

  mailboxScan.listGeneration += 1;
  const candidates = collectInboxCandidates(state, mailboxScan.visitedPreviewFingerprints);
  mailboxScan.latestListCandidates = candidates;
  if (mailboxScan.nextCandidateIndex < 0) {
    mailboxScan.nextCandidateIndex = 0;
  }
  if (mailboxScan.nextCandidateIndex > candidates.length) {
    mailboxScan.nextCandidateIndex = candidates.length;
  }

  if (mailboxScan.visitedMessages.size >= mailboxScan.requestedCount) {
    mailboxScan.stage = "COMPLETE";
  } else if (candidates.length > 0) {
    const canMoveToNextStage = [
      "INBOX_LISTING",
      "REFRESH_LIST",
      "NEXT_UNIQUE",
      "BACK_TO_LIST",
    ].includes(mailboxScan.stage);
    if (canMoveToNextStage) {
      mailboxScan.stage =
        mailboxScan.visitedMessages.size === 0 ? "INBOX_LISTING" : "NEXT_UNIQUE";
    }
  }

  return candidates;
}

function pickNextUniqueCandidate(context: ToolContext): InboxCandidate | null {
  const mailboxScan = context.runtimeStats.mailboxScan;
  const candidates = mailboxScan.latestListCandidates;
  if (candidates.length === 0) {
    return null;
  }

  let index = Math.max(0, mailboxScan.nextCandidateIndex);
  while (index < candidates.length) {
    const candidate = candidates[index];
    if (!mailboxScan.visitedPreviewFingerprints.has(candidate.previewFingerprint)) {
      mailboxScan.nextCandidateIndex = index;
      return candidate;
    }
    index += 1;
  }

  mailboxScan.nextCandidateIndex = candidates.length;
  return null;
}

function mailboxProgress(context: ToolContext) {
  const mailboxScan = context.runtimeStats.mailboxScan;
  return {
    stage: mailboxScan.stage,
    requiredUniqueCount: mailboxScan.requestedCount,
    internalUniqueOpenedCount: mailboxScan.visitedMessages.size,
    remaining: Math.max(0, mailboxScan.requestedCount - mailboxScan.visitedMessages.size),
    duplicateSkips: mailboxScan.duplicateSkips,
    staleRecoveries: mailboxScan.staleRecoveries,
  };
}

function buildMailboxFinalSummary(messages: VisitedMessage[]): string {
  const suspicious = messages.filter((message) => message.classification === "suspicious");
  const normal = messages.filter((message) => message.classification === "normal");
  const cleanupMode = messages.some(
    (message) => message.deletionAttempted || message.deletionSucceeded,
  );
  const deletedSuspicious = suspicious.filter((message) => message.deletionSucceeded).length;
  const undeletedSuspicious = suspicious.length - deletedSuspicious;

  const formatEntry = (message: VisitedMessage, index: number): string => {
    const title = sanitizeSubject(message.subject) || sanitizeSubject(message.snippet) || "Без темы";
    const sender = sanitizeSender(message.sender);
    const senderPart = sender ? ` - ${sender}` : "";
    return `${index + 1}. ${title}${senderPart}`;
  };

  const normalLines =
    normal.length > 0
      ? normal.map((message, index) => formatEntry(message, index)).join("\n")
      : "нет";

  const suspiciousLines =
    suspicious.length > 0
      ? suspicious.map((message, index) => formatEntry(message, index)).join("\n")
      : "спам не обнаружен";

  const cleanupLine = cleanupMode
    ? `\nУдаление спама: удалено ${deletedSuspicious}, не удалено ${Math.max(0, undeletedSuspicious)}`
    : "";

  return (
    `Проверено писем: ${messages.length}\n` +
    `Нормальные (${normal.length}):\n${normalLines}\n` +
    `Подозрительные (${suspicious.length}):\n${suspiciousLines}` +
    cleanupLine
  );
}

async function readMessageMetadata(context: ToolContext): Promise<{
  url: string;
  title: string;
  subject: string;
  sender: string;
  timestampLabel: string;
  snippet: string;
}> {
  const page = context.browser.getPage();
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    };

    const pickFirstText = (selectors: string[]): string => {
      for (const selector of selectors) {
        const candidate = document.querySelector(selector);
        if (!visible(candidate)) {
          continue;
        }
        const text = normalize(candidate?.textContent || "");
        if (text.length > 0) {
          return text;
        }
      }
      return "";
    };

    const bodyText = normalize(document.body?.innerText || "");
    const snippet = bodyText.slice(0, 260);

    const subject =
      pickFirstText([
        "h2.hP",
        "h2[data-thread-perm-id]",
        "[data-thread-perm-id] h2",
        "[role='main'] h2",
        "[aria-label*='Тема']",
        "h1",
        "h2",
        "[role='heading']",
      ]) || normalize(document.title || "");

    const sender =
      pickFirstText([
        "span[email]",
        "span.gD[email]",
        "a[href^='mailto:']",
        "[data-hovercard-id]",
        "[email]",
        "[data-testid*='from']",
        "[class*='from']",
      ]) || "";

    const timestampLabel =
      pickFirstText([
        "time",
        "[datetime]",
        "[data-testid*='time']",
        "[class*='date']",
        "[class*='time']",
      ]) || "";

    return {
      url: window.location.href,
      title: normalize(document.title || ""),
      subject: subject.slice(0, 220),
      sender: sender.slice(0, 160),
      timestampLabel: timestampLabel.slice(0, 120),
      snippet,
    };
  });
}

async function forceReturnToInboxList(context: ToolContext): Promise<{
  returned: boolean;
  state: PageState | null;
}> {
  const page = context.browser.getPage();

  const readState = async (): Promise<PageState | null> => {
    try {
      return await context.inspector.getPageState();
    } catch {
      return null;
    }
  };

  const initial = await readState();
  if (initial && !extractThreadOrMessageIdFromUrl(initial.url)) {
    updateMailboxListState(context, initial);
    context.runtimeStats.mailboxScan.stage = "REFRESH_LIST";
    return { returned: true, state: initial };
  }

  const tryActions: Array<() => Promise<void>> = [
    async () => {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
    },
    async () => {
      await page.keyboard.press("Alt+Left");
    },
    async () => {
      await page.keyboard.press("Escape");
    },
  ];

  for (const action of tryActions) {
    try {
      await action();
    } catch {
      // Continue fallback chain.
    }
    await page.waitForTimeout(250);
    const state = await readState();
    if (state && !extractThreadOrMessageIdFromUrl(state.url)) {
      updateMailboxListState(context, state);
      context.runtimeStats.mailboxScan.stage = "REFRESH_LIST";
      return { returned: true, state };
    }
  }

  const finalState = await readState();
  return { returned: false, state: finalState };
}

export function createToolDefinitions(): ToolSpec[] {
  const navigateSchema = z.object({
    url: z.string().min(1).max(2048),
  });

  const goBackSchema = z.object({});

  const screenshotSchema = z.object({
    label: z.string().min(1).max(60).optional(),
    fullPage: z.boolean().optional().default(true),
  });

  const getPageStateSchema = z.object({
    note: z.string().max(500).optional(),
  });

  const queryDomSchema = z.object({
    question: z.string().min(3).max(500),
    maxResults: z.number().int().min(1).max(20).optional().default(8),
  });

  const clickElementSchema = z.object({
    elementId: ELEMENT_ID_SCHEMA,
    button: z.enum(["left", "right", "middle"]).optional().default("left"),
    doubleClick: z.boolean().optional().default(false),
  });

  const typeTextSchema = z.object({
    elementId: ELEMENT_ID_SCHEMA,
    text: z.string().max(5000),
    clearFirst: z.boolean().optional().default(true),
    submit: z.boolean().optional().default(false),
  });

  const pressKeySchema = z.object({
    key: z.string().min(1).max(40),
    times: z.number().int().min(1).max(5).optional().default(1),
  });

  const scrollSchema = z.object({
    direction: z.enum(["up", "down"]).optional().default("down"),
    pixels: z.number().int().min(100).max(3000).optional().default(700),
  });

  const waitSchema = z.object({
    seconds: z.number().min(0.2).max(30).optional().default(1.5),
    reason: z.string().max(200).optional(),
  });

  const extractTextSchema = z.object({
    elementId: ELEMENT_ID_SCHEMA.optional(),
    maxLength: z.number().int().min(100).max(10000).optional().default(1200),
  });

  const requestUserInputSchema = z.object({
    question: z.string().min(3).max(500),
  });

  const finishTaskSchema = z.object({
    status: z.enum(["completed", "blocked", "needs_user_input"]).optional().default("completed"),
    summary: z.string().min(5).max(2000),
    nextSteps: z.array(z.string().min(1).max(300)).optional().default([]),
  });

  const tools: ToolSpec[] = [
    {
      name: "navigate_to_url",
      description:
        "Navigate to a URL. Use this when you need to open a site, page, or a new destination.",
      schema: navigateSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description: "URL to open. If protocol is omitted, https:// will be added.",
          },
        },
        required: ["url"],
      },
      execute: async (args, context) => {
        const page = context.browser.getPage();
        const targetUrl = ensureHttpUrl(args.url);
        const response = await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        await page.waitForTimeout(350);
        const state = await context.inspector.getPageState();
        tryMarkProfileContextExtracted(context, state);
        if (context.runtimeStats.mailboxScan.enabled) {
          context.runtimeStats.mailboxScan.pendingCandidate = null;
          context.runtimeStats.mailboxScan.stage = "INBOX_LISTING";
          updateMailboxListState(context, state);
        }
        return {
          ok: true,
          observation: {
            url: state.url,
            title: state.title,
            statusCode: response?.status() ?? null,
            summary: state.summary,
            signals: state.signals,
            mailboxScan: context.runtimeStats.mailboxScan.enabled
              ? {
                  ...mailboxProgress(context),
                  candidates: context.runtimeStats.mailboxScan.latestListCandidates.slice(0, 20),
                }
              : undefined,
          },
        };
      },
    },
    {
      name: "go_back",
      description:
        "Try to return to the previous view. Uses browser history first, then generic fallback keys if needed.",
      schema: goBackSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
      execute: async (_args, context) => {
        let page = await context.browser.ensureActivePage();
        const attempts: string[] = [];
        const readState = async () => {
          try {
            page = await context.browser.ensureActivePage();
            const state = await context.inspector.getPageState();
            return {
              ...state,
              stateError: null as string | null,
            };
          } catch (error) {
            let safePage: Page | null = null;
            try {
              safePage = await context.browser.ensureActivePage();
              page = safePage;
            } catch {
              safePage = null;
            }
            const title = safePage ? (await safePage.title().catch(() => "")) || "Untitled" : "Untitled";
            const fallbackUrl = safePage ? safePage.url() : "";
            const message = error instanceof Error ? error.message : String(error);
            return {
              url: fallbackUrl,
              title,
              summary: `Page "${title}" at ${fallbackUrl || "unknown"}. Structured inspection failed.`,
              textBlocks: [] as Array<{ text: string; tag: string }>,
              stateError: message,
            };
          }
        };

        const beforeState = await readState();

        const hasChangedFromBefore = (nextState: typeof beforeState): boolean => {
          const beforeTopText = beforeState.textBlocks[0]?.text ?? "";
          const nextTopText = nextState.textBlocks[0]?.text ?? "";
          return (
            nextState.url !== beforeState.url ||
            nextState.title !== beforeState.title ||
            nextState.summary !== beforeState.summary ||
            nextTopText !== beforeTopText
          );
        };

        try {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
          attempts.push("history.goBack");
        } catch {
          attempts.push("history.goBack_failed");
        }
        await page.waitForTimeout(250);
        let state = await readState();

        if (!hasChangedFromBefore(state)) {
          try {
            await page.keyboard.press("Alt+Left");
            attempts.push("keyboard.Alt+Left");
          } catch {
            attempts.push("keyboard.Alt+Left_failed");
          }
          await page.waitForTimeout(300);
          state = await readState();
        }

        if (!hasChangedFromBefore(state)) {
          try {
            await page.keyboard.press("Escape");
            attempts.push("keyboard.Escape");
          } catch {
            attempts.push("keyboard.Escape_failed");
          }
          await page.waitForTimeout(250);
          state = await readState();
        }

        if (!hasChangedFromBefore(state)) {
          const openPages = context.browser
            .captureOpenPages()
            .filter((candidate) => !candidate.isClosed());
          if (openPages.length > 1 && !page.isClosed()) {
            try {
              await page.close({ runBeforeUnload: false });
              attempts.push("close_current_tab");
            } catch {
              attempts.push("close_current_tab_failed");
            }
            try {
              page = await context.browser.ensureActivePage();
              await page.bringToFront().catch(() => undefined);
              await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
              attempts.push("switch_to_previous_tab");
              state = await readState();
            } catch {
              attempts.push("switch_to_previous_tab_failed");
            }
          }
        }

        const changed = hasChangedFromBefore(state);
        if (!changed) {
          return {
            ok: false,
            observation: {
              message:
                "Не удалось вернуться к предыдущему виду. Найдите и нажмите видимую кнопку Назад/Закрыть на странице.",
              attempts,
              url: state.url,
              title: state.title,
              summary: state.summary,
              stateError: state.stateError,
              recoverable: true,
              mailboxScan: context.runtimeStats.mailboxScan.enabled
                ? mailboxProgress(context)
                : undefined,
            },
          };
        }

        context.runtimeStats.goBackActions += 1;
        if (context.runtimeStats.mailboxScan.enabled) {
          context.runtimeStats.mailboxScan.pendingCandidate = null;
          context.runtimeStats.mailboxScan.stage = "REFRESH_LIST";
          if ("interactiveElements" in state && Array.isArray(state.interactiveElements)) {
            tryMarkProfileContextExtracted(context, state as PageState);
            updateMailboxListState(context, state as PageState);
            context.runtimeStats.mailboxScan.stage = "REFRESH_LIST";
          }
        }

        return {
          ok: true,
          observation: {
            navigated: true,
            attempts,
            url: state.url,
            title: state.title,
            summary: state.summary,
            stateError: state.stateError,
            signals: "signals" in state ? (state.signals as PageState["signals"]) : undefined,
            mailboxScan: context.runtimeStats.mailboxScan.enabled
              ? {
                  ...mailboxProgress(context),
                  candidates: context.runtimeStats.mailboxScan.latestListCandidates.slice(0, 20),
                }
              : undefined,
          },
        };
      },
    },
    {
      name: "take_screenshot",
      description:
        "Capture a screenshot for validation or evidence. Use this after major actions or if uncertain.",
      schema: screenshotSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: {
            type: "string",
            description: "Optional short label for the screenshot filename.",
          },
          fullPage: {
            type: "boolean",
            description: "Capture full page if true, viewport only if false.",
            default: true,
          },
        },
        required: [],
      },
      execute: async (args, context) => {
        const page = context.browser.getPage();
        const screenshotDir = path.join(context.artifactsDir, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const label = (args.label ?? "capture").replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = path.join(screenshotDir, `${stamp}-${label}.png`);
        await page.screenshot({
          path: filePath,
          fullPage: args.fullPage,
        });
        return {
          ok: true,
          observation: {
            screenshotPath: filePath,
            url: page.url(),
          },
        };
      },
    },
    {
      name: "get_page_state",
      description:
        "Extract a compact structured page state: URL, title, visible interactive elements, forms, text, modal presence, and summary.",
      schema: getPageStateSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: {
            type: "string",
            description: "Optional note about what you are trying to inspect.",
          },
        },
        required: [],
      },
      execute: async (_args, context) => {
        const state = await context.inspector.getPageState();
        tryMarkProfileContextExtracted(context, state);
        const candidates = updateMailboxListState(context, state);
        return {
          ok: true,
          observation: {
            ...state,
            jobApplication: context.runtimeStats.jobApplication.enabled
              ? jobProgress(context)
              : undefined,
            mailboxScan: context.runtimeStats.mailboxScan.enabled
              ? {
                  ...mailboxProgress(context),
                  candidates: candidates.slice(0, 25),
                }
              : undefined,
          },
        };
      },
    },
    {
      name: "query_dom",
      description:
        "Ask a focused question about the current page DOM and receive concise matching evidence.",
      schema: queryDomSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            description: "Focused question about what is present on the page.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matching entries to return.",
            default: 8,
          },
        },
        required: ["question"],
      },
      execute: async (args, context) => {
        const result = await context.inspector.queryDom(args.question, args.maxResults);
        const stateAfterQuery = await context.inspector.getPageState();
        tryMarkProfileContextExtracted(context, stateAfterQuery);
        return {
          ok: true,
          observation: {
            ...result,
            jobApplication: context.runtimeStats.jobApplication.enabled
              ? jobProgress(context)
              : undefined,
          },
        };
      },
    },
    {
      name: "click_element",
      description: "Click a visible element by runtime-generated elementId.",
      schema: clickElementSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          elementId: {
            type: "string",
            description: "Runtime-generated element id from get_page_state or query_dom.",
          },
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            default: "left",
          },
          doubleClick: {
            type: "boolean",
            default: false,
          },
        },
        required: ["elementId"],
      },
      execute: async (args, context) => {
        let page = context.browser.getPage();
        const mailboxScan = context.runtimeStats.mailboxScan;
        const job = context.runtimeStats.jobApplication;
        const requestedCartAddCount = context.runtimeStats.policy.requestedCartAddCount;
        let targetElementId = args.elementId;
        let selectedCandidate: InboxCandidate | null = null;
        let cartIntentBefore: "add" | "already_in_cart" | "other" = "other";
        let jobIntentBefore: "apply" | "other" = "other";
        let clickedNestedPrimaryLink = false;
        let clickedNestedApplyControl = false;
        let fallbackApplyClick = false;
        let applyConfirmed = false;
        let applyConfirmationEvidence: string | null = null;
        let switchedToNewPage = false;
        let selectedNewPageUrl: string | null = null;

        const runtimeSecurityResult = await enforceRuntimeSecurityGate(context, {
          actionName: "click_element",
          elementId: args.elementId,
        });
        if (runtimeSecurityResult) {
          return runtimeSecurityResult;
        }

        if (
          mailboxScan.enabled &&
          mailboxScan.visitedMessages.size >= Math.max(1, mailboxScan.requestedCount)
        ) {
          mailboxScan.stage = "COMPLETE";
          return {
            ok: true,
            observation: {
              skippedAfterCompletion: true,
              requestedElementId: args.elementId,
              message: "Required unique message count already reached. Call finish_task.",
              mailboxScan: mailboxProgress(context),
            },
          };
        }

        const synchronizeMailboxCandidate = async () => {
          if (!mailboxScan.enabled) {
            return;
          }

          const stageNeedsInbox = [
            "INBOX_LISTING",
            "REFRESH_LIST",
            "NEXT_UNIQUE",
            "BACK_TO_LIST",
          ].includes(mailboxScan.stage);
          const inThreadView = Boolean(extractThreadOrMessageIdFromUrl(page.url()));

          if (!stageNeedsInbox) {
            return;
          }

          if (inThreadView) {
            const back = await forceReturnToInboxList(context);
            if (back.returned) {
              mailboxScan.pendingCandidate = null;
            }
          }

          const state = await context.inspector.getPageState();
          updateMailboxListState(context, state);
          const nextCandidate = pickNextUniqueCandidate(context);
          if (nextCandidate) {
            selectedCandidate = nextCandidate;
            targetElementId = nextCandidate.elementId;
          }
        };

        await synchronizeMailboxCandidate();

        if (
          mailboxScan.enabled &&
          Boolean(extractThreadOrMessageIdFromUrl(page.url())) &&
          (mailboxScan.stage === "OPEN_MESSAGE" || mailboxScan.stage === "EXTRACT")
        ) {
          return {
            ok: false,
            observation: {
              message:
                "Message is already open. Do not click another list row now; extract content or go back to inbox first.",
              requestedElementId: args.elementId,
              recoverable: true,
              mailboxScan: {
                ...mailboxProgress(context),
                candidates: mailboxScan.latestListCandidates.slice(0, 20),
              },
            },
          };
        }

        const selector = () => `[data-agent-id="${targetElementId}"]`;
        const buildRecoveryObservation = async (message: string) => {
          const freshState = await context.inspector.getPageState();
          const mailboxCandidates = updateMailboxListState(context, freshState);
          const nextCandidate = mailboxScan.enabled ? pickNextUniqueCandidate(context) : null;
          const candidates = recoveryCandidates(freshState.interactiveElements, 8);
          return {
            message,
            requestedElementId: args.elementId,
            elementId: targetElementId,
            nextSuggestedElementId: nextCandidate?.elementId ?? null,
            currentUrl: freshState.url,
            currentTitle: freshState.title,
            currentSummary: freshState.summary,
            visibleCandidates: candidates,
            nextActionHint:
              candidates.length > 0
                ? "Use one of visibleCandidates.elementId values for the next action."
                : "Call query_dom with a focused question, then choose a visible target.",
            recoverable: true,
            mailboxScan: mailboxScan.enabled
              ? {
                  ...mailboxProgress(context),
                  candidates: mailboxCandidates.slice(0, 20),
                }
              : undefined,
          };
        };
        const locator = await findElementLocator(
          () => page.locator(selector()).first(),
          async () => {
            await context.inspector.getPageState();
          },
        );

        if ((await locator.count()) === 0) {
          if (mailboxScan.enabled) {
            mailboxScan.staleRecoveries += 1;
            mailboxScan.stage = "REFRESH_LIST";
          }
          return {
            ok: false,
            observation: await buildRecoveryObservation(
              `Element ${targetElementId} was not found. It is likely stale after UI changes.`,
            ),
          };
        }

        const state = await probeElementState(locator);
        if (!state.visible) {
          if (mailboxScan.enabled) {
            mailboxScan.staleRecoveries += 1;
            mailboxScan.stage = "REFRESH_LIST";
          }
          return {
            ok: false,
            observation: await buildRecoveryObservation(
              `Element ${targetElementId} exists but is not visible in current view.`,
            ),
          };
        }
        if (!state.enabled) {
          const freshState = await context.inspector.getPageState();
          return {
            ok: false,
            observation: {
              message: `Element ${targetElementId} is disabled.`,
              requestedElementId: args.elementId,
              elementId: targetElementId,
              currentUrl: freshState.url,
              currentTitle: freshState.title,
            },
          };
        }

        try {
          const beforeUrl = page.url();
          const beforeTitle = await page.title().catch(() => "");
          const openPagesBeforeClick = context.browser.captureOpenPages();
          const meta = await locator.evaluate((element) => {
            const html = element as HTMLElement;
            const normalize = (value: string | null | undefined) =>
              (value ?? "").replace(/\s+/g, " ").trim();
            const className = (() => {
              const raw = html.className;
              if (typeof raw === "string") {
                return raw;
              }
              if (typeof (raw as { baseVal?: string } | null)?.baseVal === "string") {
                return (raw as { baseVal?: string }).baseVal ?? "";
              }
              return "";
            })();
            const toAbsolute = (href: string): string => {
              try {
                return new URL(href, window.location.href).toString();
              } catch {
                return href;
              }
            };

            const isVisible = (candidate: Element): boolean => {
              const node = candidate as HTMLElement;
              const style = window.getComputedStyle(node);
              if (style.display === "none" || style.visibility === "hidden") {
                return false;
              }
              const rect = node.getBoundingClientRect();
              return rect.width >= 2 && rect.height >= 2;
            };

            const tag = html.tagName.toLowerCase();
            const role = (html.getAttribute("role") || "").toLowerCase() || null;

            let peerCount = 1;
            const parent = html.parentElement;
            if (parent) {
              const peers = Array.from(parent.children).filter((child) => {
                const childHtml = child as HTMLElement;
                if (!isVisible(childHtml)) {
                  return false;
                }
                const childTag = childHtml.tagName.toLowerCase();
                const childRole = (childHtml.getAttribute("role") || "").toLowerCase();
                if (child === html) {
                  return true;
                }
                if (childTag === tag) {
                  return true;
                }
                if (role && childRole === role) {
                  return true;
                }
                return false;
              });
              peerCount = peers.length;
            }

            const threadAttrKeys = [
              "data-thread-id",
              "data-legacy-thread-id",
              "data-message-id",
              "data-legacy-last-message-id",
            ];
            let threadHint = "";

            for (const key of threadAttrKeys) {
              const value = normalize(html.getAttribute(key));
              if (value.length >= 6) {
                threadHint = value;
                break;
              }
            }

            if (!threadHint) {
              const annotatedChild = html.querySelector<HTMLElement>(
                "[data-thread-id],[data-legacy-thread-id],[data-message-id],[data-legacy-last-message-id]",
              );
              if (annotatedChild) {
                for (const key of threadAttrKeys) {
                  const value = normalize(annotatedChild.getAttribute(key));
                  if (value.length >= 6) {
                    threadHint = value;
                    break;
                  }
                }
              }
            }

            if (!threadHint) {
              const linkCandidates: string[] = [];
              if (html instanceof HTMLAnchorElement) {
                const ownHref = normalize(html.getAttribute("href") || html.href);
                if (ownHref) {
                  linkCandidates.push(ownHref);
                }
              }
              for (const anchor of Array.from(html.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
                const href = normalize(anchor.getAttribute("href") || anchor.href);
                if (href) {
                  linkCandidates.push(href);
                }
                if (linkCandidates.length >= 8) {
                  break;
                }
              }

              const preferred =
                linkCandidates.find((href) =>
                  /#|thread|message|mail|inbox|conversation|conv|fmfc/i.test(href),
                ) ??
                linkCandidates[0] ??
                "";
              if (preferred) {
                threadHint = toAbsolute(preferred);
              }
            }

            return {
              tag,
              role,
              textPreview: normalize(html.innerText || html.textContent || "").slice(0, 180),
              peerCount,
              threadHint: threadHint || null,
              ariaLabel: normalize(html.getAttribute("aria-label")),
              titleAttr: normalize(html.getAttribute("title")),
              idAttr: normalize(html.id || ""),
              classAttr: normalize(className).slice(0, 180),
            };
          });
          const cartControlLabel = [
            meta.textPreview,
            meta.ariaLabel,
            meta.titleAttr,
            meta.idAttr,
            meta.classAttr,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 280);
          if (job.enabled && /\/applicant\/resumes(?:\/|$|\?)/i.test(beforeUrl)) {
            if (isResumePromoCardLabel(cartControlLabel)) {
              const currentState = await context.inspector.getPageState();
              const visibleResumeCandidates = currentState.interactiveElements
                .filter((element) =>
                  isLikelyResumeEntryLabel(
                    `${compact(element.name, 120)} ${compact(element.description, 120)}`,
                  ),
                )
                .slice(0, 8)
                .map((element) => ({
                  elementId: element.elementId,
                  tag: element.tag,
                  role: element.role,
                  name: compact(element.name, 140),
                }));

              return {
                ok: false,
                observation: {
                  message:
                    "Selected element looks like a promotional card (resume service), not a user resume entry.",
                  requestedElementId: args.elementId,
                  elementId: targetElementId,
                  recoverable: true,
                  nextActionHint:
                    "Pick an actual resume item (title/role/experience), skip promo cards with discounts/services.",
                  visibleResumeCandidates,
                },
              };
            }
          }
          cartIntentBefore = classifyCartControlIntent(cartControlLabel);
          jobIntentBefore = classifyJobControlIntent(cartControlLabel);
          if (
            requestedCartAddCount !== null &&
            cartIntentBefore === "add" &&
            context.runtimeStats.cartAddActions >= requestedCartAddCount
          ) {
            context.runtimeStats.cartAddSkips += 1;
            return {
              ok: true,
              observation: {
                skippedCartAddLimit: true,
                requestedElementId: args.elementId,
                elementId: targetElementId,
                message:
                  `Cart add limit reached (${context.runtimeStats.cartAddActions}/${requestedCartAddCount}). Do not add more products.`,
                cartPolicy: {
                  requestedCartAddCount,
                  cartAddActions: context.runtimeStats.cartAddActions,
                  cartAddSkips: context.runtimeStats.cartAddSkips,
                },
                mailboxScan: mailboxScan.enabled ? mailboxProgress(context) : undefined,
              },
            };
          }

          const looksLikeListItem = isListLikeElement(meta.tag, meta.role);
          if (mailboxScan.enabled && looksLikeListItem) {
            const knownCandidate =
              mailboxScan.latestListCandidates.find(
                (candidate) => candidate.elementId === targetElementId,
              ) ?? selectedCandidate;
            const preview = knownCandidate?.preview ?? meta.textPreview;
            const previewFingerprint =
              knownCandidate?.previewFingerprint ?? buildPreviewFingerprint(preview, beforeUrl);
            const hintedOpenedFingerprint = normalizeThreadHintToFingerprint(meta.threadHint);

            if (hintedOpenedFingerprint && mailboxScan.visitedMessages.has(hintedOpenedFingerprint)) {
              mailboxScan.duplicateSkips += 1;
              mailboxScan.visitedPreviewFingerprints.add(previewFingerprint);
              mailboxScan.stage = "NEXT_UNIQUE";
              if (typeof knownCandidate?.rowIndex === "number") {
                mailboxScan.nextCandidateIndex = knownCandidate.rowIndex + 1;
              } else {
                mailboxScan.nextCandidateIndex = Math.max(0, mailboxScan.nextCandidateIndex + 1);
              }
              const nextCandidate = pickNextUniqueCandidate(context);
              return {
                ok: true,
                observation: {
                  skippedDuplicateThreadBeforeOpen: true,
                  requestedElementId: args.elementId,
                  elementId: targetElementId,
                  openedFingerprint: hintedOpenedFingerprint,
                  nextSuggestedElementId: nextCandidate?.elementId ?? null,
                  mailboxScan: {
                    ...mailboxProgress(context),
                    candidates: mailboxScan.latestListCandidates.slice(0, 20),
                  },
                },
              };
            }

            if (mailboxScan.visitedPreviewFingerprints.has(previewFingerprint)) {
              mailboxScan.duplicateSkips += 1;
              mailboxScan.stage = "NEXT_UNIQUE";
              if (typeof knownCandidate?.rowIndex === "number") {
                mailboxScan.nextCandidateIndex = knownCandidate.rowIndex + 1;
              } else {
                mailboxScan.nextCandidateIndex = Math.max(0, mailboxScan.nextCandidateIndex + 1);
              }
              const nextCandidate = pickNextUniqueCandidate(context);
              return {
                ok: true,
                observation: {
                  skippedDuplicate: true,
                  requestedElementId: args.elementId,
                  elementId: targetElementId,
                  nextSuggestedElementId: nextCandidate?.elementId ?? null,
                  previewFingerprint,
                  reason: "Message fingerprint already exists in visited_messages.",
                  mailboxScan: {
                    ...mailboxProgress(context),
                    candidates: mailboxScan.latestListCandidates.slice(0, 20),
                  },
                },
              };
            }

            mailboxScan.pendingCandidate = {
              elementId: targetElementId,
              preview,
              previewFingerprint,
              senderHint: knownCandidate?.senderHint ?? "",
              subjectHint: knownCandidate?.subjectHint ?? "",
              rowIndex: knownCandidate?.rowIndex ?? mailboxScan.nextCandidateIndex,
              listGeneration: mailboxScan.listGeneration,
              listUrl: beforeUrl,
            };
            if (typeof knownCandidate?.rowIndex === "number") {
              mailboxScan.nextCandidateIndex = knownCandidate.rowIndex + 1;
            }
            mailboxScan.stage = "OPEN_MESSAGE";
          }

          await locator.scrollIntoViewIfNeeded({ timeout: 2500 });
          if (job.enabled && looksLikeListItem && jobIntentBefore !== "apply") {
            clickedNestedPrimaryLink = await clickNestedPrimaryLink(locator);
          }
          if (job.enabled && jobIntentBefore === "apply" && !clickedNestedPrimaryLink) {
            clickedNestedApplyControl = await clickNestedApplyControl(locator);
          }
          if (!clickedNestedPrimaryLink && !clickedNestedApplyControl) {
            await locator.click({
              button: args.button,
              clickCount: args.doubleClick ? 2 : 1,
              timeout: 8000,
            });
          }
          await page.waitForTimeout(220);
          const tabSwitch = await context.browser.switchToNewlyOpenedPage(
            openPagesBeforeClick,
            beforeUrl,
          );
          if (tabSwitch.newPageDetected) {
            switchedToNewPage = tabSwitch.switched;
            selectedNewPageUrl = tabSwitch.selectedUrl;
            if (switchedToNewPage) {
              page = context.browser.getPage();
              await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => undefined);
            }
          }

          let afterUrl = page.url();
          let afterTitle = await page.title().catch(() => "");

          if (job.enabled) {
            const previewFingerprint = vacancyFingerprintFromText(meta.textPreview);
            const urlFingerprint =
              vacancyFingerprintFromUrl(afterUrl) ?? vacancyFingerprintFromUrl(beforeUrl);
            const openedFingerprint = resolveCurrentVacancyFingerprint(
              job.currentVacancyFingerprint,
              beforeUrl,
              afterUrl,
              meta.textPreview,
            );
            if (openedFingerprint) {
              job.currentVacancyFingerprint = openedFingerprint;
              const openedByNavigation = Boolean(urlFingerprint) && afterUrl !== beforeUrl;
              const openedByListSelection = looksLikeListItem && Boolean(previewFingerprint);
              if (openedByNavigation || openedByListSelection) {
                job.openedVacancyFingerprints.add(openedFingerprint);
              }
            }
          }

          if (requestedCartAddCount !== null) {
            let confirmedCartAdd = cartIntentBefore === "add";

            if (!confirmedCartAdd && afterUrl === beforeUrl && !switchedToNewPage) {
              const postClickLabel = await page
                .locator(selector())
                .first()
                .evaluate((element) => {
                  const html = element as HTMLElement;
                  const normalize = (value: string | null | undefined) =>
                    (value ?? "").replace(/\s+/g, " ").trim();
                  const className = (() => {
                    const raw = html.className;
                    if (typeof raw === "string") {
                      return raw;
                    }
                    if (typeof (raw as { baseVal?: string } | null)?.baseVal === "string") {
                      return (raw as { baseVal?: string }).baseVal ?? "";
                    }
                    return "";
                  })();
                  return [
                    normalize(html.innerText || html.textContent || ""),
                    normalize(html.getAttribute("aria-label")),
                    normalize(html.getAttribute("title")),
                    normalize(html.id || ""),
                    normalize(className),
                  ]
                    .filter(Boolean)
                    .join(" ")
                    .slice(0, 280);
                })
                .catch(() => "");

              const postIntent = classifyCartControlIntent(postClickLabel);
              if (cartIntentBefore !== "already_in_cart" && postIntent === "already_in_cart") {
                confirmedCartAdd = true;
              }
            }

            if (
              !confirmedCartAdd &&
              /\/cart(?:\/|\?|$)/i.test(afterUrl) &&
              !/\/cart(?:\/|\?|$)/i.test(beforeUrl) &&
              cartIntentBefore === "add"
            ) {
              confirmedCartAdd = true;
            }

            if (confirmedCartAdd) {
              if (
                requestedCartAddCount === null ||
                context.runtimeStats.cartAddActions < requestedCartAddCount
              ) {
                context.runtimeStats.cartAddActions += 1;
              }
            }
          }

          if (job.enabled && jobIntentBefore === "apply") {
            let confirmation = await detectApplyConfirmation(page, locator);

            if (!confirmation.confirmed) {
              const openPagesBeforeFallbackApply = context.browser.captureOpenPages();
              fallbackApplyClick = await clickVisibleApplyControl(page);
              if (fallbackApplyClick) {
                await page.waitForTimeout(220);
                const fallbackTabSwitch = await context.browser.switchToNewlyOpenedPage(
                  openPagesBeforeFallbackApply,
                  page.url(),
                );
                if (fallbackTabSwitch.newPageDetected && fallbackTabSwitch.switched) {
                  switchedToNewPage = true;
                  selectedNewPageUrl = fallbackTabSwitch.selectedUrl;
                  page = context.browser.getPage();
                  await page
                    .waitForLoadState("domcontentloaded", { timeout: 4000 })
                    .catch(() => undefined);
                }
                afterUrl = page.url();
                afterTitle = await page.title().catch(() => "");
                confirmation = await detectApplyConfirmation(page, locator);
              }
            }

            const transitionedToApplicationFlow =
              afterUrl !== beforeUrl && isLikelyApplicationResponseUrl(afterUrl);
            applyConfirmed = confirmation.confirmed || transitionedToApplicationFlow;
            applyConfirmationEvidence = confirmation.evidence;

            if (applyConfirmed) {
              const vacancyFingerprint = resolveCurrentVacancyFingerprint(
                job.currentVacancyFingerprint,
                beforeUrl,
                afterUrl,
              );
              if (vacancyFingerprint) {
                job.appliedVacancyFingerprints.add(vacancyFingerprint);
                job.currentVacancyFingerprint = vacancyFingerprint;
              }
            }
          }

          context.runtimeStats.clickedElementIds.add(targetElementId);
          const looksLikeListOpen =
            looksLikeListItem &&
            (afterUrl !== beforeUrl || afterTitle !== beforeTitle);
          if (looksLikeListOpen) {
            const signature =
              afterUrl !== beforeUrl
                ? `url:${afterUrl}`
                : `${meta.tag}|${meta.role ?? ""}|${meta.textPreview}`;
            if (!context.runtimeStats.clickedListSignatures.has(signature)) {
              context.runtimeStats.clickedListSignatures.add(signature);
              context.runtimeStats.clickedListItemIds.add(targetElementId);
            }

            if (mailboxScan.enabled && mailboxScan.pendingCandidate) {
              mailboxScan.pendingCandidate.openedUrl = afterUrl;
              const threadOrMessageId = extractThreadOrMessageIdFromUrl(afterUrl);
              if (threadOrMessageId) {
                const openedFingerprint = `url:${threadOrMessageId}`;
                if (mailboxScan.visitedMessages.has(openedFingerprint)) {
                  mailboxScan.duplicateSkips += 1;
                  if (mailboxScan.pendingCandidate?.previewFingerprint) {
                    mailboxScan.visitedPreviewFingerprints.add(
                      mailboxScan.pendingCandidate.previewFingerprint,
                    );
                  }
                  if (typeof mailboxScan.pendingCandidate?.rowIndex === "number") {
                    mailboxScan.nextCandidateIndex = mailboxScan.pendingCandidate.rowIndex + 1;
                  }
                  mailboxScan.pendingCandidate = null;
                  const back = await forceReturnToInboxList(context);
                  mailboxScan.stage = back.returned ? "NEXT_UNIQUE" : "BACK_TO_LIST";
                  const nextCandidate = pickNextUniqueCandidate(context);
                  return {
                    ok: true,
                    observation: {
                      duplicateThreadOpened: true,
                      requestedElementId: args.elementId,
                      elementId: targetElementId,
                      autoReturnedToList: back.returned,
                      nextSuggestedElementId: nextCandidate?.elementId ?? null,
                      openedFingerprint,
                      message:
                        "This message/thread was already inspected earlier. Go back and continue with the next unique row.",
                      mailboxScan: {
                        ...mailboxProgress(context),
                        candidates: mailboxScan.latestListCandidates.slice(0, 20),
                      },
                    },
                  };
                }
              }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/execution context was destroyed|most likely because of a navigation/i.test(message)) {
            await page.waitForTimeout(250);
            const recoveredState = await context.inspector.getPageState();
            const recoveredCandidates = updateMailboxListState(context, recoveredState);
            return {
              ok: true,
              observation: {
                clickedElementId: targetElementId,
                requestedElementId: args.elementId,
                recoveredFromNavigationRace: true,
                errorHint: message,
                currentUrl: recoveredState.url,
                postClickState: {
                  url: recoveredState.url,
                  title: recoveredState.title,
                  summary: recoveredState.summary,
                  topInteractiveElements: recoveredState.interactiveElements
                    .slice(0, 10)
                    .map((item) => ({
                      elementId: item.elementId,
                      tag: item.tag,
                      role: item.role,
                      name: item.name,
                    })),
                },
                mailboxScan: mailboxScan.enabled
                  ? {
                      ...mailboxProgress(context),
                      candidates: recoveredCandidates.slice(0, 20),
                    }
                  : undefined,
                jobApplication: job.enabled ? jobProgress(context) : undefined,
              },
            };
          }
          return {
            ok: false,
            observation: {
              message:
                `Failed to click element ${targetElementId}. Refresh page state and retry with a visible target.`,
              requestedElementId: args.elementId,
              elementId: targetElementId,
              error: message,
              recoverable: true,
              mailboxScan: mailboxScan.enabled ? mailboxProgress(context) : undefined,
            },
          };
        }
        await page.waitForTimeout(300);
        const postClickState = await context.inspector.getPageState();
        tryMarkProfileContextExtracted(context, postClickState);
        const candidates = updateMailboxListState(context, postClickState);
        return {
          ok: true,
          observation: {
            clickedElementId: targetElementId,
            requestedElementId: args.elementId,
            clickedNestedPrimaryLink,
            clickedNestedApplyControl,
            fallbackApplyClick,
            applyConfirmed: job.enabled && jobIntentBefore === "apply" ? applyConfirmed : undefined,
            applyConfirmationEvidence:
              job.enabled && jobIntentBefore === "apply" ? applyConfirmationEvidence : undefined,
            switchedToNewPage,
            selectedNewPageUrl,
            button: args.button,
            doubleClick: args.doubleClick,
            currentUrl: page.url(),
            postClickState: {
              url: postClickState.url,
              title: postClickState.title,
              summary: postClickState.summary,
              topInteractiveElements: postClickState.interactiveElements
                .slice(0, 10)
                .map((item) => ({
                  elementId: item.elementId,
                  tag: item.tag,
                  role: item.role,
                  name: item.name,
                })),
            },
            mailboxScan: mailboxScan.enabled
              ? {
                  ...mailboxProgress(context),
                  candidates: candidates.slice(0, 20),
                }
              : undefined,
            cartPolicy:
              requestedCartAddCount !== null
                ? {
                    requestedCartAddCount,
                    cartAddActions: context.runtimeStats.cartAddActions,
                    cartAddSkips: context.runtimeStats.cartAddSkips,
                  }
                : undefined,
            jobApplication: job.enabled ? jobProgress(context) : undefined,
          },
        };
      },
    },
    {
      name: "type_text",
      description:
        "Type text into an input-like element identified by runtime elementId. Optionally submit with Enter.",
      schema: typeTextSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          elementId: {
            type: "string",
            description: "Runtime-generated element id from get_page_state or query_dom.",
          },
          text: {
            type: "string",
            description: "Text content to enter.",
          },
          clearFirst: {
            type: "boolean",
            default: true,
          },
          submit: {
            type: "boolean",
            default: false,
          },
        },
        required: ["elementId", "text"],
      },
      execute: async (args, context) => {
        const runtimeSecurityResult = await enforceRuntimeSecurityGate(context, {
          actionName: "type_text",
          elementId: args.elementId,
        });
        if (runtimeSecurityResult) {
          return runtimeSecurityResult;
        }

        const page = context.browser.getPage();
        const job = context.runtimeStats.jobApplication;
        const selector = `[data-agent-id="${args.elementId}"]`;
        const buildRecoveryObservation = async (message: string) => {
          const freshState = await context.inspector.getPageState();
          const candidates = recoveryCandidates(
            freshState.interactiveElements.filter((element) =>
              ["textbox", "combobox"].includes(element.role ?? ""),
            ),
            8,
          );
          return {
            message,
            elementId: args.elementId,
            currentUrl: freshState.url,
            currentTitle: freshState.title,
            currentSummary: freshState.summary,
            visibleInputCandidates: candidates,
            nextActionHint:
              candidates.length > 0
                ? "Use one of visibleInputCandidates.elementId values."
                : "Call get_page_state and inspect visible formInputs before typing.",
          };
        };
        const locator = await findElementLocator(
          () => page.locator(selector).first(),
          async () => {
            await context.inspector.getPageState();
          },
        );

        if ((await locator.count()) === 0) {
          return {
            ok: false,
            observation: await buildRecoveryObservation(
              `Element ${args.elementId} was not found. It is likely stale after UI changes.`,
            ),
          };
        }

        const state = await probeElementState(locator);
        if (!state.visible) {
          return {
            ok: false,
            observation: await buildRecoveryObservation(
              `Element ${args.elementId} exists but is not visible in current view.`,
            ),
          };
        }
        if (!state.enabled) {
          return {
            ok: false,
            observation: {
              message: `Element ${args.elementId} is disabled and cannot receive input.`,
              elementId: args.elementId,
            },
          };
        }

        const inputMeta = await locator
          .evaluate((element) => {
            const html = element as HTMLElement;
            const normalize = (value: string | null | undefined) =>
              (value ?? "").replace(/\s+/g, " ").trim();
            const tag = html.tagName.toLowerCase();
            const role = normalize(html.getAttribute("role")).toLowerCase();
            const type =
              html instanceof HTMLInputElement ? normalize(html.type).toLowerCase() : "";
            const contentEditable =
              normalize(html.getAttribute("contenteditable")).toLowerCase() === "true";
            const inputLike =
              tag === "textarea" ||
              tag === "select" ||
              (tag === "input" &&
                !["button", "submit", "reset", "checkbox", "radio"].includes(type)) ||
              role === "textbox" ||
              role === "combobox" ||
              contentEditable;

            const label = [
              normalize(html.innerText || html.textContent || ""),
              normalize(html.getAttribute("aria-label")),
              normalize(html.getAttribute("placeholder")),
              normalize(html.getAttribute("title")),
              normalize(html.getAttribute("name")),
              normalize(type),
              normalize(html.id || ""),
            ]
              .filter(Boolean)
              .join(" ")
              .slice(0, 300);

            return {
              inputLike,
              tag,
              role,
              type,
              label,
            };
          })
          .catch(() => ({
            inputLike: false,
            tag: "",
            role: "",
            type: "",
            label: "",
          }));

        if (!inputMeta.inputLike) {
          return {
            ok: false,
            observation: await buildRecoveryObservation(
              `Element ${args.elementId} is not an input field (tag=${inputMeta.tag || "unknown"}, role=${inputMeta.role || "none"}).`,
            ),
          };
        }

        let coverLetterFieldDetected = false;
        if (job.enabled) {
          coverLetterFieldDetected = isLikelyCoverLetterLabel(inputMeta.label);
        }

        const interactionTrace: string[] = [];
        const supportsFill =
          inputMeta.tag === "input" ||
          inputMeta.tag === "textarea" ||
          inputMeta.role === "textbox" ||
          inputMeta.role === "combobox";

        try {
          await locator.scrollIntoViewIfNeeded({ timeout: 2500 });
          interactionTrace.push("scrollIntoViewIfNeeded:ok");
        } catch {
          interactionTrace.push("scrollIntoViewIfNeeded:skip");
        }

        try {
          await locator.focus({ timeout: 4000 });
          interactionTrace.push("focus:ok");
        } catch {
          interactionTrace.push("focus:fallback");
          try {
            await locator.click({ timeout: 3500, force: true });
            interactionTrace.push("click(force):ok");
          } catch {
            interactionTrace.push("click(force):failed");
          }
        }

        try {
          if (args.clearFirst) {
            if (supportsFill) {
              await locator.fill("");
              interactionTrace.push("clear:fill");
            } else {
              await page.keyboard.press("Control+A");
              await page.keyboard.press("Backspace");
              interactionTrace.push("clear:keyboard");
            }
          }

          if (supportsFill) {
            await locator.fill(args.text);
            interactionTrace.push("type:fill");
          } else {
            await locator.type(args.text, { delay: 20 });
            interactionTrace.push("type:keyboard");
          }

          if (args.submit) {
            try {
              await locator.press("Enter");
              interactionTrace.push("submit:locator-press");
            } catch {
              await page.keyboard.press("Enter");
              interactionTrace.push("submit:page-press");
            }
          }

          await page.waitForTimeout(250);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            observation: {
              ...(await buildRecoveryObservation(
                `Input interaction failed for ${args.elementId}.`,
              )),
              recoverable: true,
              error: message,
              interactionTrace,
            },
          };
        }

        if (job.enabled && coverLetterFieldDetected && args.text.trim().length >= 30) {
          const pageUrl = page.url();
          const vacancyFingerprint = resolveCurrentVacancyFingerprint(
            job.currentVacancyFingerprint,
            pageUrl,
            pageUrl,
          );
          if (vacancyFingerprint) {
            job.coverLetterVacancyFingerprints.add(vacancyFingerprint);
            job.currentVacancyFingerprint = vacancyFingerprint;
          }
        }

        return {
          ok: true,
          observation: {
            elementId: args.elementId,
            typedChars: args.text.length,
            submitted: args.submit,
            coverLetterFieldDetected,
            jobApplication: job.enabled ? jobProgress(context) : undefined,
          },
        };
      },
    },
    {
      name: "press_key",
      description: "Send a keyboard key press to the active page.",
      schema: pressKeySchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: {
            type: "string",
            description: "Playwright keyboard key value, e.g. Enter, Tab, Escape, ArrowDown.",
          },
          times: {
            type: "number",
            default: 1,
          },
        },
        required: ["key"],
      },
      execute: async (args, context) => {
        const runtimeSecurityResult = await enforceRuntimeSecurityGate(context, {
          actionName: "press_key",
          key: args.key,
        });
        if (runtimeSecurityResult) {
          return runtimeSecurityResult;
        }

        const page = context.browser.getPage();
        for (let i = 0; i < args.times; i += 1) {
          await page.keyboard.press(args.key);
        }
        await page.waitForTimeout(150);
        return {
          ok: true,
          observation: {
            key: args.key,
            times: args.times,
          },
        };
      },
    },
    {
      name: "scroll",
      description: "Scroll the page up or down by a pixel amount.",
      schema: scrollSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down"],
            default: "down",
          },
          pixels: {
            type: "number",
            default: 700,
          },
        },
        required: [],
      },
      execute: async (args, context) => {
        const page = context.browser.getPage();
        const direction = args.direction === "up" ? -1 : 1;
        await page.mouse.wheel(0, direction * args.pixels);
        await page.waitForTimeout(200);
        context.runtimeStats.scrollActions += 1;
        return {
          ok: true,
          observation: {
            direction: args.direction,
            pixels: args.pixels,
          },
        };
      },
    },
    {
      name: "wait",
      description: "Wait for a short duration for async UI updates.",
      schema: waitSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          seconds: {
            type: "number",
            default: 1.5,
          },
          reason: {
            type: "string",
          },
        },
        required: [],
      },
      execute: async (args, context) => {
        const page = context.browser.getPage();
        await page.waitForTimeout(args.seconds * 1000);
        return {
          ok: true,
          observation: {
            waitedSeconds: args.seconds,
            reason: args.reason ?? "unspecified",
          },
        };
      },
    },
    {
      name: "extract_text",
      description:
        "Extract visible text from a specific element by elementId, or from the whole page body if no elementId is provided.",
      schema: extractTextSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          elementId: {
            type: "string",
          },
          maxLength: {
            type: "number",
            default: 1200,
          },
        },
        required: [],
      },
      execute: async (args, context) => {
        const page = context.browser.getPage();
        const mailboxScan = context.runtimeStats.mailboxScan;
        const job = context.runtimeStats.jobApplication;
        const requestedCartAddCount = context.runtimeStats.policy.requestedCartAddCount;
        if (
          mailboxScan.enabled &&
          mailboxScan.visitedMessages.size >= Math.max(1, mailboxScan.requestedCount)
        ) {
          mailboxScan.stage = "COMPLETE";
          return {
            ok: true,
            observation: {
              elementId: args.elementId ?? null,
              skippedAfterCompletion: true,
              message: "Required unique message count already reached. Call finish_task.",
              mailboxScan: mailboxProgress(context),
            },
          };
        }

        let text = "";
        const currentUrlAtStart = page.url();
        const threadOrMessageIdAtStart = extractThreadOrMessageIdFromUrl(currentUrlAtStart);
        const pendingAtStart = mailboxScan.pendingCandidate;
        const openedAwayFromList = pendingAtStart
          ? currentUrlAtStart !== pendingAtStart.listUrl
          : false;
        const inMessageContext = Boolean(threadOrMessageIdAtStart || openedAwayFromList);

        if (mailboxScan.enabled) {
          if (!inMessageContext) {
            const nextCandidate = pickNextUniqueCandidate(context);
            mailboxScan.stage = "NEXT_UNIQUE";
            return {
              ok: false,
              observation: {
                message:
                  "Cannot extract from inbox list during mailbox scan. Open the next unique message row first.",
                elementId: args.elementId ?? null,
                recoverable: true,
                nextSuggestedElementId: nextCandidate?.elementId ?? null,
                mailboxScan: {
                  ...mailboxProgress(context),
                  candidates: mailboxScan.latestListCandidates.slice(0, 20),
                },
              },
            };
          }

          mailboxScan.stage = "EXTRACT";
          if (threadOrMessageIdAtStart) {
            const urlFingerprint = `url:${threadOrMessageIdAtStart}`;
            const existing = mailboxScan.visitedMessages.get(urlFingerprint);
            if (existing && existing.extractedText.length > 0) {
              mailboxScan.duplicateSkips += 1;
              const back = await forceReturnToInboxList(context);
              mailboxScan.stage = back.returned ? "NEXT_UNIQUE" : "BACK_TO_LIST";
              const nextCandidate = pickNextUniqueCandidate(context);
              return {
                ok: true,
                observation: {
                  elementId: args.elementId ?? null,
                  skippedDuplicateExtraction: true,
                  autoReturnedToList: back.returned,
                  nextSuggestedElementId: nextCandidate?.elementId ?? null,
                  fingerprint: urlFingerprint,
                  classification: existing.classification,
                  mailboxScan: {
                    ...mailboxProgress(context),
                    candidates: mailboxScan.latestListCandidates.slice(0, 20),
                  },
                },
              };
            }
          }
        }

        if (args.elementId) {
          const selector = `[data-agent-id="${args.elementId}"]`;
          const locator = await findElementLocator(
            () => page.locator(selector).first(),
            async () => {
              await context.inspector.getPageState();
            },
          );

          if ((await locator.count()) === 0) {
            if (mailboxScan.enabled) {
              mailboxScan.staleRecoveries += 1;
              mailboxScan.stage = "REFRESH_LIST";
            }
            return {
              ok: false,
              observation: {
                message: `Element ${args.elementId} was not found. Refresh page state first.`,
                elementId: args.elementId,
                recoverable: true,
                mailboxScan: mailboxScan.enabled ? mailboxProgress(context) : undefined,
              },
            };
          }

          const probe = await probeElementState(locator);
          if (!probe.visible) {
            const freshState = await context.inspector.getPageState();
            const rowLikeVisible = freshState.interactiveElements.filter((item) =>
              ["row", "listitem", "option", "treeitem", "gridcell"].includes(item.role ?? ""),
            ).length;

            if (rowLikeVisible < 4) {
              const fallbackText = await page.evaluate((maxLength) => {
                const normalize = (value: string | null | undefined) =>
                  (value ?? "").replace(/\s+/g, " ").trim();

                const candidates = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    "main,[role='main'],article,[role='article'],section,div",
                  ),
                );

                const visible = (element: HTMLElement): boolean => {
                  const style = window.getComputedStyle(element);
                  if (style.display === "none" || style.visibility === "hidden") {
                    return false;
                  }
                  const rect = element.getBoundingClientRect();
                  return rect.width >= 2 && rect.height >= 2;
                };

                let bestText = "";
                for (const element of candidates) {
                  if (!visible(element)) {
                    continue;
                  }
                  const text = normalize(element.innerText || element.textContent || "");
                  if (text.length > bestText.length) {
                    bestText = text;
                  }
                }

                if (!bestText) {
                  bestText = normalize(document.body.innerText || document.body.textContent || "");
                }
                return bestText.slice(0, maxLength);
              }, args.maxLength);

              return {
                ok: true,
                observation: {
                  elementId: args.elementId,
                  extractedText: fallbackText,
                  fallbackUsed: true,
                  fallbackReason:
                    "Requested element became hidden after UI transition. Extracted visible main content instead.",
                  currentUrl: freshState.url,
                  currentTitle: freshState.title,
                },
              };
            }

            return {
              ok: false,
              observation: {
                message:
                  `Element ${args.elementId} exists but is not visible in current view. ` +
                  "Do not read hidden/stale elements; refresh page state and choose a visible target.",
                elementId: args.elementId,
                nextActionHint:
                  "Call get_page_state and choose a currently visible list row elementId, then open next item.",
                currentUrl: freshState.url,
                currentTitle: freshState.title,
                recoverable: true,
                mailboxScan: mailboxScan.enabled ? mailboxProgress(context) : undefined,
              },
            };
          }

          try {
            await locator.scrollIntoViewIfNeeded({ timeout: 2500 });
          } catch {
            // Non-fatal for extraction if text can still be read.
          }

          text = await locator.evaluate(
            (element, maxLength) => {
              const normalize = (value: string | null | undefined) =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const value = normalize(
                (element as HTMLElement).innerText || element.textContent || "",
              );
              return value.slice(0, maxLength);
            },
            args.maxLength,
          );
        } else {
          text = await page.evaluate((maxLength) => {
            const normalize = (value: string | null | undefined) =>
              (value ?? "").replace(/\s+/g, " ").trim();
            const value = normalize(document.body.innerText || document.body.textContent || "");
            return value.slice(0, maxLength);
          }, args.maxLength);
        }

        const wasExtractedBefore = args.elementId
          ? context.runtimeStats.extractedElementIds.has(args.elementId)
          : false;
        if (args.elementId) {
          context.runtimeStats.extractedElementIds.add(args.elementId);
        }

        if (
          requestedCartAddCount !== null &&
          !wasExtractedBefore &&
          context.runtimeStats.cartAddActions < requestedCartAddCount &&
          /(^|\s)(в корзине|in cart|already in cart|уже в корзине)(\s|$)/i.test(text)
        ) {
          context.runtimeStats.cartAddActions += 1;
        }

        if (job.enabled) {
          const currentUrl = page.url();
          if (isLikelyProfileResumeUrl(currentUrl)) {
            if (isLikelyProfileContextExtraction(text)) {
              job.profileContextExtracted = true;
            }
          } else {
            const vacancyFingerprint = resolveCurrentVacancyFingerprint(
              job.currentVacancyFingerprint,
              currentUrl,
              currentUrl,
              args.elementId ? text : "",
            );
            if (vacancyFingerprint) {
              job.openedVacancyFingerprints.add(vacancyFingerprint);
              if (isMeaningfulVacancyExtraction(text)) {
                job.extractedVacancyFingerprints.add(vacancyFingerprint);
              }
              job.currentVacancyFingerprint = vacancyFingerprint;
            }
          }
        }

        if (mailboxScan.enabled) {
          const metadata = await readMessageMetadata(context);
          const threadOrMessageId = extractThreadOrMessageIdFromUrl(metadata.url);
          const pending = mailboxScan.pendingCandidate;
          const identity = resolveMessageIdentity(
            pending
              ? {
                  senderHint: pending.senderHint,
                  subjectHint: pending.subjectHint,
                  preview: pending.preview,
                }
              : null,
            metadata,
            text,
          );
          const openedAwayFromList = pending ? metadata.url !== pending.listUrl : false;
          const isMessageContext = Boolean(threadOrMessageId || openedAwayFromList);

          if (!isMessageContext) {
            return {
              ok: true,
              observation: {
                elementId: args.elementId ?? null,
                extractedText: text,
                mailboxScan: mailboxProgress(context),
              },
            };
          }

          const fallbackFingerprint = buildFallbackFingerprint({
            sender: identity.sender,
            subject: identity.subject,
            timestampLabel: metadata.timestampLabel,
            snippet: identity.snippet || text.slice(0, 240),
          });
          const finalFingerprint = threadOrMessageId
            ? `url:${threadOrMessageId}`
            : fallbackFingerprint;

          const existing = mailboxScan.visitedMessages.get(finalFingerprint);
          if (existing) {
            mailboxScan.duplicateSkips += 1;
            const back = await forceReturnToInboxList(context);
            mailboxScan.stage = back.returned ? "NEXT_UNIQUE" : "BACK_TO_LIST";
            const nextCandidate = pickNextUniqueCandidate(context);
            return {
              ok: true,
              observation: {
                elementId: args.elementId ?? null,
                skippedDuplicateExtraction: true,
                autoReturnedToList: back.returned,
                nextSuggestedElementId: nextCandidate?.elementId ?? null,
                fingerprint: finalFingerprint,
                classification: existing.classification,
                mailboxScan: {
                  ...mailboxProgress(context),
                  candidates: mailboxScan.latestListCandidates.slice(0, 20),
                },
              },
            };
          }

          const subject = identity.subject;
          const sender = identity.sender;
          const snippet = (identity.snippet || text).slice(0, 240);
          const classification = classifyMessageText(text, subject, sender, {
            treatVerificationAsSuspicious:
              context.runtimeStats.policy.mailboxDeleteVerificationCodes,
          });
          const shouldDeleteSuspicious =
            context.runtimeStats.policy.mailboxDeleteRequested && classification === "suspicious";
          const deletion = shouldDeleteSuspicious
            ? await attemptMailboxCleanupAction(context)
            : { attempted: false, succeeded: false, actionLabel: null as string | null };

          const message: VisitedMessage = {
            fingerprint: finalFingerprint,
            previewFingerprint: pending?.previewFingerprint ?? null,
            url: metadata.url,
            sender,
            subject,
            timestampLabel: metadata.timestampLabel,
            snippet,
            extractedText: text,
            classification,
            deletionAttempted: deletion.attempted,
            deletionSucceeded: deletion.succeeded,
            inspectedAt: new Date().toISOString(),
          };
          mailboxScan.visitedMessages.set(finalFingerprint, message);
          if (pending?.previewFingerprint) {
            mailboxScan.visitedPreviewFingerprints.add(pending.previewFingerprint);
          }
          mailboxScan.pendingCandidate = null;

          let autoReturnedToList = false;
          let nextSuggestedElementId: string | null = null;
          try {
            const postActionState = await context.inspector.getPageState();
            const stillInMessageContext = Boolean(
              extractThreadOrMessageIdFromUrl(postActionState.url),
            );
            if (!stillInMessageContext) {
              autoReturnedToList = true;
              updateMailboxListState(context, postActionState);
              nextSuggestedElementId = pickNextUniqueCandidate(context)?.elementId ?? null;
            }
          } catch {
            // Non-fatal: fallback to explicit BACK_TO_LIST stage.
          }

          mailboxScan.stage =
            mailboxScan.visitedMessages.size >= mailboxScan.requestedCount
              ? "COMPLETE"
              : autoReturnedToList
                ? "NEXT_UNIQUE"
                : "BACK_TO_LIST";

          return {
            ok: true,
            observation: {
              elementId: args.elementId ?? null,
              extractedText: text,
              fingerprint: finalFingerprint,
              classification,
              sender,
              subject,
              snippet,
              autoDeletionAttempted: deletion.attempted,
              autoDeletionSucceeded: deletion.succeeded,
              autoDeletionAction: deletion.actionLabel,
              autoReturnedToList,
              nextSuggestedElementId,
              mailboxScan: mailboxProgress(context),
              jobApplication: job.enabled ? jobProgress(context) : undefined,
            },
          };
        }

        return {
          ok: true,
          observation: {
            elementId: args.elementId ?? null,
            extractedText: text,
            mailboxScan: mailboxScan.enabled ? mailboxProgress(context) : undefined,
            jobApplication: job.enabled ? jobProgress(context) : undefined,
          },
        };
      },
    },
    {
      name: "request_user_input",
      description:
        "Pause autonomy and ask the user for required information when login, 2FA, captcha, payment confirmation, or ambiguity is encountered.",
      schema: requestUserInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            description: "Precise question for the user.",
          },
        },
        required: ["question"],
      },
      execute: async (args, context) => {
        if (
          context.runtimeStats.policy.jobApplicationFlow &&
          isResumeSelectionQuestion(args.question)
        ) {
          try {
            const state = await context.inspector.getPageState();
            const singleResume = detectSingleVisibleResumeOption(state);
            if (singleResume) {
              const autoResponse = `Use the only visible resume: ${singleResume.label}`;
              return {
                ok: true,
                observation: {
                  question: args.question,
                  userResponse: autoResponse,
                  autoResolved: true,
                  resolution: "single_visible_resume_detected",
                  resumeElementId: singleResume.elementId,
                  resumeLabel: singleResume.label,
                  currentUrl: state.url,
                },
              };
            }
          } catch {
            // Fall through to explicit user prompt if inspection fails.
          }
        }

        const userResponse = (await context.askUserInput(args.question)).trim();
        if (userResponse.length === 0) {
          return {
            ok: false,
            observation: {
              message: "No user input was provided.",
              question: args.question,
            },
            control: {
              type: "blocked",
              reason: "User input was required but not provided.",
            },
          };
        }

        return {
          ok: true,
          observation: {
            question: args.question,
            userResponse,
          },
        };
      },
    },
    {
      name: "finish_task",
      description: "Finish the task and provide a concise final report.",
      schema: finishTaskSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["completed", "blocked", "needs_user_input"],
            default: "completed",
          },
          summary: {
            type: "string",
            description: "Concise final report.",
          },
          nextSteps: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
        },
        required: ["summary"],
      },
      execute: async (args, context) => {
        const finishStatus = args.status ?? "completed";
        const nextSteps = Array.isArray(args.nextSteps) ? args.nextSteps : [];

        if (finishStatus !== "completed") {
          return {
            ok: true,
            observation: {
              status: finishStatus,
              summary: args.summary,
              nextSteps,
              jobApplication: context.runtimeStats.jobApplication.enabled
                ? jobProgress(context)
                : undefined,
            },
            control: {
              type: "finish",
              status: finishStatus,
              summary: args.summary,
              nextSteps,
            },
          };
        }

        const mailboxScan = context.runtimeStats.mailboxScan;
        if (mailboxScan.enabled) {
          const required = Math.max(1, mailboxScan.requestedCount || 10);
          const visited = Array.from(mailboxScan.visitedMessages.values());
          const uniqueFingerprints = new Set(visited.map((item) => item.fingerprint));
          const incomplete = visited.filter(
            (item) => item.extractedText.trim().length === 0 || !item.classification,
          );
          const cleanupRequired = context.runtimeStats.policy.mailboxDeleteRequested;
          const suspicious = visited.filter((item) => item.classification === "suspicious");
          const undeletedSuspicious = cleanupRequired
            ? suspicious.filter((item) => !item.deletionSucceeded)
            : [];
          const unattemptedSuspicious = cleanupRequired
            ? suspicious.filter((item) => !item.deletionAttempted)
            : [];
          const uniqueCount = uniqueFingerprints.size;
          const noDuplicates = uniqueCount === visited.length;

          if (
            uniqueCount < required ||
            incomplete.length > 0 ||
            !noDuplicates ||
            unattemptedSuspicious.length > 0
          ) {
            if (uniqueCount < required) {
              mailboxScan.stage = "NEXT_UNIQUE";
            }
            return {
              ok: false,
              observation: {
                message:
                  `Cannot finish yet: required unique messages = ${required}, confirmed unique = ${uniqueCount}. ` +
                  "Continue the inbox loop (OPEN_MESSAGE -> EXTRACT -> BACK_TO_LIST -> REFRESH_LIST -> NEXT_UNIQUE).",
                requiredUniqueCount: required,
                internalUniqueOpenedCount: uniqueCount,
                missingClassificationOrText: incomplete.length,
                noDuplicates,
                cleanupRequired,
                undeletedSuspicious: undeletedSuspicious.length,
                unattemptedSuspicious: unattemptedSuspicious.length,
                mailboxScan: mailboxProgress(context),
              },
            };
          }

          mailboxScan.stage = "COMPLETE";
          const sortedByVisitOrder = visited.slice(0, required);
          const summary = buildMailboxFinalSummary(sortedByVisitOrder);

          return {
            ok: true,
            observation: {
              status: "completed",
              summary,
              nextSteps: [],
              mailboxScan: mailboxProgress(context),
            },
            control: {
              type: "finish",
              status: "completed",
              summary,
              nextSteps: [],
            },
          };
        }

        const job = context.runtimeStats.jobApplication;
        if (job.enabled) {
          const targetApplyCount = Math.max(1, job.targetApplyCount);
          const openedVacancies = job.openedVacancyFingerprints.size;
          const extractedVacancies = job.extractedVacancyFingerprints.size;
          const appliedVacancies = job.appliedVacancyFingerprints.size;
          const coverLetters = job.coverLetterVacancyFingerprints.size;

          if (appliedVacancies < targetApplyCount) {
            return {
              ok: false,
              observation: {
                message:
                  `Cannot finish yet: job-application target = ${targetApplyCount}, ` +
                  `opened/read/cover/applied = ${openedVacancies}/${extractedVacancies}/${coverLetters}/${appliedVacancies}. ` +
                  "Continue vacancy loop (SEARCH_LIST -> OPEN_VACANCY -> EXTRACT_REQUIREMENTS -> APPLY_WITH_COVER_LETTER).",
                targetApplyCount,
                openedVacancies,
                extractedVacancies,
                coverLetters,
                appliedVacancies,
                jobApplication: jobProgress(context),
              },
            };
          }
        }

        const requiredCartAddCount = context.runtimeStats.policy.requestedCartAddCount;
        if (
          requiredCartAddCount !== null &&
          context.runtimeStats.cartAddActions < requiredCartAddCount
        ) {
          let inferredFromCartState = false;
          try {
            const state = await context.inspector.getPageState();
            if (cartPageHasItems(state)) {
              context.runtimeStats.cartAddActions = requiredCartAddCount;
              inferredFromCartState = true;
            }
          } catch {
            // Keep original counters if state inspection fails.
          }

          if (!inferredFromCartState) {
            return {
              ok: false,
              observation: {
                message:
                  `Cannot finish yet: add-to-cart target is ${requiredCartAddCount}, ` +
                  `confirmed adds = ${context.runtimeStats.cartAddActions}.`,
                requiredCartAddCount,
                cartAddActions: context.runtimeStats.cartAddActions,
                cartAddSkips: context.runtimeStats.cartAddSkips,
              },
            };
          }
        }

        const requestedCount = parseRequestedItemCount(context.userGoal);
        if (
          requestedCount &&
          requiredCartAddCount === null &&
          !context.runtimeStats.jobApplication.enabled
        ) {
          const openedCount = context.runtimeStats.clickedListSignatures.size;
          const extractedCount = context.runtimeStats.extractedElementIds.size;
          const effectiveCount = openedCount;
          const required = Math.min(requestedCount, 25);

          if (effectiveCount < required) {
            return {
              ok: false,
              observation: {
                message:
                  `Нельзя завершить задачу: нужно проверить минимум ${required} элементов, ` +
                  `а подтверждено только ${effectiveCount}. Продолжайте открывать/читать следующие элементы.`,
                required,
                effectiveCount,
                openedListItems: openedCount,
                extractedElements: extractedCount,
                scrollActions: context.runtimeStats.scrollActions,
                goBackActions: context.runtimeStats.goBackActions,
              },
            };
          }
        }

        return {
          ok: true,
          observation: {
            status: finishStatus,
            summary: args.summary,
            nextSteps,
            jobApplication: context.runtimeStats.jobApplication.enabled
              ? jobProgress(context)
              : undefined,
          },
          control: {
            type: "finish",
            status: finishStatus,
            summary: args.summary,
            nextSteps,
          },
        };
      },
    },
  ];

  return tools;
}
