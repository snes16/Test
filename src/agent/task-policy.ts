import { PageSignals, TaskPolicy } from "../types";

const MAILBOX_HINT_RE =
  /(mail|email|e-mail|inbox|gmail|outlook|yahoo|почт|входящ|ящик|писем|письм|сообщени)/i;

const AUDIT_HINT_RE =
  /(read|review|scan|audit|classif|analy|inspect|spam|прочит|проверь|провер|проанализ|аудит|спам|отч(е|ё)т)/i;

const READ_ONLY_HINT_RE =
  /(read[- ]?only|do not (delete|remove|send|reply|archive)|without deleting|nothing to delete|ничего не удаляй|не удаляй|без удаления|только отч(е|ё)т|просто дай отч(е|ё)т)/i;

const AMBIGUOUS_HINT_RE =
  /(if possible|maybe|could you choose|может|возможно|например|или выбери)/i;

const ADD_TO_CART_HINT_RE =
  /((?:add|put|place)\b[\s\S]{0,100}\b(?:to|into|in)\s+(?:the\s+)?(?:cart|basket|bag)|(?:to|into|in)\s+(?:the\s+)?(?:cart|basket|bag)[\s\S]{0,60}\b(?:add|put|place)|(?:добав|полож|закин)[^\n]{0,100}в\s*корзин|в\s*корзин[^\n]{0,60}(?:добав|полож|закин))/i;

const MULTI_ITEM_CART_HINT_RE =
  /(add\b[\s\S]{0,120}\band\b[\s\S]{0,120}\b(?:to|into)\s+(?:the\s+)?(?:cart|basket|bag)|добав[^\n]{0,120}\bи\b[^\n]{0,120}в\s*корзин)/i;

const SINGLE_BEST_HINT_RE =
  /(best|top\s*1|single\s+best|best\s+value|value\s+for\s+money|price[\s-]*quality|optimal|most\s+suitable|сам(ый|ая|ое|ые)\s+лучш|луч(ш|ший|шая|шее|шие)|оптимальн|наилучш|по\s+соотношению\s+цены?\s+и?\s+качества|цена[\s-]*качество)/i;

export function parseRequestedItemCount(goal: string): number | null {
  const matches = Array.from(goal.matchAll(/\b([1-9]\d{0,2})\b/g));
  if (matches.length === 0) {
    return null;
  }

  for (const match of matches) {
    const parsed = Number.parseInt(match[1], 10);
    if (parsed >= 1 && parsed <= 100) {
      return parsed;
    }
  }

  return null;
}

function parseRequestedCartAddCount(goal: string): number | null {
  if (!ADD_TO_CART_HINT_RE.test(goal)) {
    return null;
  }

  const explicit = parseRequestedItemCount(goal);
  if (explicit !== null) {
    return Math.min(25, explicit);
  }

  if (SINGLE_BEST_HINT_RE.test(goal)) {
    return 1;
  }

  if (MULTI_ITEM_CART_HINT_RE.test(goal)) {
    return null;
  }

  // Conservative default for "add to cart" tasks with unspecified quantity.
  return 1;
}

export function createTaskPolicy(goal: string): TaskPolicy {
  const requestedItemCountRaw = parseRequestedItemCount(goal);
  const requestedCartAddCount = parseRequestedCartAddCount(goal);
  const mailboxLike = MAILBOX_HINT_RE.test(goal);
  const auditLike = AUDIT_HINT_RE.test(goal);
  const readOnlyLike = READ_ONLY_HINT_RE.test(goal);
  const shoppingAddToCart = requestedCartAddCount !== null;
  const auditReadOnlyMailboxScan = mailboxLike && auditLike && readOnlyLike;

  const requestedItemCount = auditReadOnlyMailboxScan
    ? Math.min(25, requestedItemCountRaw ?? 10)
    : requestedItemCountRaw;

  const fullySpecified = auditReadOnlyMailboxScan && !AMBIGUOUS_HINT_RE.test(goal);

  return {
    auditReadOnlyMailboxScan,
    fullySpecified,
    requestedItemCount,
    shoppingAddToCart,
    requestedCartAddCount,
    suppressIntermediateAssistantText: auditReadOnlyMailboxScan,
    suppressUnnecessaryUserQuestions: auditReadOnlyMailboxScan && fullySpecified,
  };
}

export function hasBlockingSignals(signals?: PageSignals): boolean {
  if (!signals) {
    return false;
  }

  return Boolean(
    signals.loginPromptLikely ||
      signals.captchaLikely ||
      signals.paymentStepLikely ||
      signals.destructiveActionLikely,
  );
}
