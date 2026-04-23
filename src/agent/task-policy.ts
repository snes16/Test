import { PageSignals, TaskPolicy } from "../types";

const MAILBOX_HINT_RE =
  /(mail|email|e-mail|inbox|gmail|outlook|yahoo|\u043f\u043e\u0447\u0442|\u0432\u0445\u043e\u0434\u044f\u0449|\u044f\u0449\u0438\u043a|\u043f\u0438\u0441\u0435\u043c|\u043f\u0438\u0441\u044c\u043c|\u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438)/i;

const AUDIT_HINT_RE =
  /(read|review|scan|audit|classif|analy|inspect|spam|\u043f\u0440\u043e\u0447\u0438\u0442|\u043f\u0440\u043e\u0432\u0435\u0440|\u043f\u0440\u043e\u0430\u043d\u0430\u043b\u0438\u0437|\u0430\u0443\u0434\u0438\u0442|\u0441\u043f\u0430\u043c|\u043e\u0442\u0447(?:\u0435|\u0451)\u0442)/i;

const READ_ONLY_HINT_RE =
  /(read[- ]?only|do not (delete|remove|send|reply|archive)|without deleting|nothing to delete|\u043d\u0438\u0447\u0435\u0433\u043e\s+\u043d\u0435\s+\u0443\u0434\u0430\u043b\u044f\u0439|\u043d\u0435\s+\u0443\u0434\u0430\u043b\u044f\u0439|\u0431\u0435\u0437\s+\u0443\u0434\u0430\u043b\u0435\u043d\u0438\u044f|\u0442\u043e\u043b\u044c\u043a\u043e\s+\u043e\u0442\u0447(?:\u0435|\u0451)\u0442|\u043f\u0440\u043e\u0441\u0442\u043e\s+\u0434\u0430\u0439\s+\u043e\u0442\u0447(?:\u0435|\u0451)\u0442)/i;

const MAILBOX_DELETE_HINT_RE =
  /(delete|remove|trash|spam|junk|mark\s+as\s+spam|move\s+to\s+spam|\u0443\u0434\u0430\u043b|\u0432\s+\u043a\u043e\u0440\u0437\u0438\u043d|\u0441\u043f\u0430\u043c|\u0432\s+\u0441\u043f\u0430\u043c|\u043e\u0442\u043f\u0438\u0441)/i;

const MAILBOX_VERIFICATION_CODE_HINT_RE =
  /(verification\s*code|otp|one[-\s]?time\s*(?:code|pass(?:word)?)|two[-\s]?factor|2fa|\u043a\u043e\u0434[^\s]{0,8}\s+\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434|\u043a\u043e\u0434[^\s]{0,8}\s+\u0432\u0445\u043e\u0434|\u043a\u043e\u0434[^\s]{0,8}\s+\u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446|\u043e\u0434\u043d\u043e\u0440\u0430\u0437\u043e\u0432[^\s]{0,8}\s+\u043a\u043e\u0434|\u043a\u043e\u0434[^\s]{0,8}\s+\u0438\u0437\s+sms|\u043f\u0438\u0441\u044c\u043c[^\s]{0,8}\s+\u0441\s+\u043a\u043e\u0434[^\s]{0,8})/i;

const AMBIGUOUS_HINT_RE =
  /(if possible|maybe|could you choose|might|possibly|\u043c\u043e\u0436\u0435\u0442|\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e|\u043d\u0430\u043f\u0440\u0438\u043c\u0435\u0440|\u0438\u043b\u0438\s+\u0432\u044b\u0431\u0435\u0440\u0438|\u043d\u0430\s+\u0442\u0432\u043e\u0439\s+\u0432\u043a\u0443\u0441|\u043d\u0430\s+\u0442\u0432\u043e\u0435\s+\u0443\u0441\u043c\u043e\u0442\u0440\u0435\u043d\u0438\u0435)/i;

const ADD_TO_CART_HINT_RE =
  /((?:add|put|place)\b[\s\S]{0,100}\b(?:to|into|in)\s+(?:the\s+)?(?:cart|basket|bag)|(?:to|into|in)\s+(?:the\s+)?(?:cart|basket|bag)[\s\S]{0,60}\b(?:add|put|place)|(?:\u0434\u043e\u0431\u0430\u0432|\u043f\u043e\u043b\u043e\u0436|\u0437\u0430\u043a\u0438\u043d)[^\n]{0,100}\u0432\s*\u043a\u043e\u0440\u0437\u0438\u043d|\u0432\s*\u043a\u043e\u0440\u0437\u0438\u043d[^\n]{0,60}(?:\u0434\u043e\u0431\u0430\u0432|\u043f\u043e\u043b\u043e\u0436|\u0437\u0430\u043a\u0438\u043d))/i;

const MULTI_ITEM_CART_HINT_RE =
  /(add\b[\s\S]{0,120}\band\b[\s\S]{0,120}\b(?:to|into)\s+(?:the\s+)?(?:cart|basket|bag)|\u0434\u043e\u0431\u0430\u0432[^\n]{0,120}\b\u0438\b[^\n]{0,120}\u0432\s*\u043a\u043e\u0440\u0437\u0438\u043d)/i;

const SINGLE_BEST_HINT_RE =
  /(best|top\s*1|single\s+best|best\s+value|value\s+for\s+money|price[\s-]*quality|optimal|most\s+suitable|\u0441\u0430\u043c(?:\u044b\u0439|\u0430\u044f|\u043e\u0435|\u044b\u0435)\s+\u043b\u0443\u0447\u0448|\u043b\u0443\u0447\u0448(?:\u0435|\u0438\u0439|\u0430\u044f|\u0435\u0435|\u0438\u0435)|\u043e\u043f\u0442\u0438\u043c\u0430\u043b\u044c\u043d|\u043d\u0430\u0438\u043b\u0443\u0447\u0448|\u043f\u043e\s+\u0441\u043e\u043e\u0442\u043d\u043e\u0448\u0435\u043d\u0438\u044e\s+\u0446\u0435\u043d\u044b?\s+\u0438?\s+\u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0430|\u0446\u0435\u043d\u0430[\s-]*\u043a\u0430\u0447\u0435\u0441\u0442\u0432\u043e)/i;

const JOB_HINT_RE =
  /(vacanc|job|position|career|\u0440\u0430\u0431\u043e\u0442|\u0432\u0430\u043a\u0430\u043d\u0441|\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442|employment|\u043d\u0430\u043d\u0438\u043c)/i;

const APPLY_HINT_RE =
  /(apply|application|respond|reply|cover[\s-]*letter|\u043e\u0442\u043a\u043b\u0438\u043a\w*|\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0434\w*|\u043f\u043e\u0434\u0430\u0442\u044c|\u043e\u0442\u043f\u0440\u0430\u0432(?:\u044c|\u0438\u0442\u044c)\s+\u0440\u0435\u0437\u044e\u043c\u0435)/i;

const PROFILE_RESUME_HINT_RE =
  /(profile|resume|cv|\u043f\u0440\u043e\u0444\u0438\u043b|\u0440\u0435\u0437\u044e\u043c)/i;

const JOB_COUNT_NEARBY_RE =
  /(?:\b([1-9]\d{0,1})\b\s*(?:jobs?|vacanc(?:y|ies)|roles?|positions?|\u0432\u0430\u043a\u0430\u043d\u0441(?:\u0438[\u044f\u0438]|\u0439)|\u043f\u043e\u0437\u0438\u0446(?:\u0438[\u044f\u0438]|\u0439)|\u043e\u0442\u043a\u043b\u0438\u043a(?:\u0430|\u043e\u0432)?))|(?:(?:jobs?|vacanc(?:y|ies)|roles?|positions?|\u0432\u0430\u043a\u0430\u043d\u0441(?:\u0438[\u044f\u0438]|\u0439)|\u043f\u043e\u0437\u0438\u0446(?:\u0438[\u044f\u0438]|\u0439)|\u043e\u0442\u043a\u043b\u0438\u043a(?:\u0430|\u043e\u0432)?)\s*\b([1-9]\d{0,1})\b)/i;

const ROLE_TOKEN_HINT_RE =
  /\b([a-z][a-z0-9+.#/_-]{1,30}(?:[\s-]+[a-z][a-z0-9+.#/_-]{1,30}){0,2})\b/i;

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

  return 1;
}

function parseRequestedJobApplyCount(goal: string, jobApplicationFlow: boolean): number | null {
  if (!jobApplicationFlow) {
    return null;
  }

  const nearbyFlexible = goal.match(
    /(?:\b([1-9]\d{0,1})\b(?:\s+[\p{L}\p{N}-]+){0,3}\s*(?:jobs?|vacanc(?:y|ies)|roles?|positions?|\u0432\u0430\u043a\u0430\u043d\u0441(?:\u0438[\u044f\u0438]|\u0439)|\u043f\u043e\u0437\u0438\u0446(?:\u0438[\u044f\u0438]|\u0439)|\u043e\u0442\u043a\u043b\u0438\u043a(?:\u0430|\u043e\u0432)?))|(?:(?:jobs?|vacanc(?:y|ies)|roles?|positions?|\u0432\u0430\u043a\u0430\u043d\u0441(?:\u0438[\u044f\u0438]|\u0439)|\u043f\u043e\u0437\u0438\u0446(?:\u0438[\u044f\u0438]|\u0439)|\u043e\u0442\u043a\u043b\u0438\u043a(?:\u0430|\u043e\u0432)?)(?:\s+[\p{L}\p{N}-]+){0,3}\s*\b([1-9]\d{0,1})\b)/iu,
  );
  const nearbyStrict = goal.match(JOB_COUNT_NEARBY_RE);
  const raw = nearbyFlexible?.[1] ?? nearbyFlexible?.[2] ?? nearbyStrict?.[1] ?? nearbyStrict?.[2] ?? null;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(25, parsed);
    }
  }

  const explicit = parseRequestedItemCount(goal);
  if (explicit !== null) {
    return Math.min(25, explicit);
  }

  return 1;
}

function sanitizeJobQueryHint(candidate: string | null | undefined): string | null {
  const normalized = (candidate ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  let cleaned = normalized;
  cleaned = cleaned.replace(/^(?:and|\u0438)\s+/i, "");
  cleaned = cleaned.replace(/^(?:\u043d\u0430|for|as)\s+/i, "");
  cleaned = cleaned.replace(
    /^(?:relevant\s+)?(?:positions?|roles?|vacanc(?:y|ies)|\u0432\u0430\u043a\u0430\u043d\u0441[\u0438\u044f\u0439\u0438]*|\u043f\u043e\u0437\u0438\u0446[\u0438\u044f\u0439\u044e]*|\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442[\u044c\u0438]*)\s+(?:for|as|\u043d\u0430)\s+/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(?:\u043d\u0430\s+)?(?:\u043f\u043e\u0437\u0438\u0446[\u0438\u044f\u044e\u0439]*|\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442[\u044c\u0438]*)\s+/iu,
    "",
  );
  cleaned = cleaned.replace(
    /^(?:position|role|vacanc(?:y|ies)|positions?|roles?|job|jobs?|vacancies?)\s+/i,
    "",
  );
  cleaned = cleaned.replace(/^s\s+for\s+/i, "");
  cleaned = cleaned.replace(/^(?:for|as)\s+/i, "");
  cleaned = cleaned.replace(
    /\s+(?:and|\u0438)\s+(?:apply|respond|\u043e\u0442\u043a\u043b\u0438\u043a\w*).*/i,
    "",
  );
  cleaned = cleaned.replace(
    /\s+(?:with|\u0441)\s+(?:cover|letter|\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0434\w*).*/i,
    "",
  );
  cleaned = cleaned.replace(/^(?:relevant|suitable|\u043f\u043e\u0434\u0445\u043e\u0434\u044f\u0449\w*)\s+/iu, "");
  cleaned = cleaned.replace(/\s+(?:on|\u043d\u0430)\s+(?:platform|site|job\s+board|\u043f\u043b\u0430\u0442\u0444\u043e\u0440\u043c|\u0441\u0430\u0439\u0442\u0435?)$/iu, "");
  cleaned = cleaned.replace(/\s+(?:platform|site|job\s+board|\u043f\u043b\u0430\u0442\u0444\u043e\u0440\u043c|\u0441\u0430\u0439\u0442)$/iu, "");
  cleaned = cleaned.replace(/[^\p{L}\p{N}+.#/_:@ -]/gu, "");
  cleaned = cleaned.replace(/^-+/, "");
  cleaned = cleaned.replace(/-+$/, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (cleaned.length < 2 || cleaned.length > 50) {
    return null;
  }

  const tokens = cleaned.split(" ");
  if (tokens.length > 5) {
    return null;
  }

  if (
    /^(?:\u043d\u0438\u0445|\u043d\u0435\u0433\u043e|\u043d\u0435\u0435|\u0438\u0445|them|those|these|relevant|suitable|on|in|at|for|as|\u043d\u0430|\u0432|\u0441|\u0438|\u043f\u043e\u0434\u0445\u043e\u0434\u044f\u0449(?:\u0438\u0435|\u0438\u0445|\u0430\u044f|\u0443\u044e))$/iu.test(
      cleaned,
    )
  ) {
    return null;
  }

  if (
    /(apply|respond|cover|letter|vacanc|job|search|find|\u043e\u0442\u043a\u043b\u0438\u043a|\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0434|\u0432\u0430\u043a\u0430\u043d\u0441|\u043f\u043e\u0438\u0441\u043a|\u043d\u0430\u0439\u0434)/i.test(
      cleaned,
    )
  ) {
    return null;
  }

  if (
    /^https?:\/\//i.test(cleaned) ||
    /(www\.)/i.test(cleaned) ||
    /\b[a-z0-9-]+\.(ru|com|net|org|io|dev|ai|co)\b/i.test(cleaned) ||
    /^hh\.ru$/i.test(cleaned)
  ) {
    return null;
  }

  return cleaned;
}

function findFirstValidJobQuery(
  goal: string,
  regex: RegExp,
  captureGroup: number,
): string | null {
  for (const match of goal.matchAll(regex)) {
    const candidate = sanitizeJobQueryHint(match[captureGroup]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function parseJobSearchQueryHint(goal: string, jobApplicationFlow: boolean): string | null {
  if (!jobApplicationFlow) {
    return null;
  }

  const directRole = findFirstValidJobQuery(
    goal,
    /(?:\u043f\u043e\u0437\u0438\u0446[\u0438\u044f\u044e\u0439]*|position|role|\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442[\u044c\u0438]*)\s*(?:\u043d\u0430|for|as)?\s*[:\-]?\s*["']?([\p{L}][\p{L}\p{N}+.#/_-]{1,40}(?:[\s-]+[\p{L}][\p{L}\p{N}+.#/_-]{1,40}){0,3})(?=\s+(?:\u043d\u0430|for|as|in|at|with|and|\u0438|\u0441)\b|[,.!?:]|$)["']?/giu,
    1,
  );
  if (directRole) {
    return directRole;
  }

  const explicitSearchRole = findFirstValidJobQuery(
    goal,
    /(?:vacanc(?:y|ies)|vacancies|job|jobs?|position|role|\u0432\u0430\u043a\u0430\u043d\u0441[\u0438\u044f\u0439\u0438]*|\u043f\u043e\u0437\u0438\u0446[\u0438\u044f\u044e\u0439]*|\u0440\u043e\u043b\u044c)\s*(?:\u043d\u0430|for|as)?\s*[:\-]?\s*["']?([\p{L}][\p{L}\p{N}+.#/_-]{1,40}(?:[\s-]+[\p{L}][\p{L}\p{N}+.#/_-]{1,40}){0,3})(?=\s+(?:\u043d\u0430|for|as|in|at|with|and|\u0438|\u0441)\b|[,.!?:]|$)["']?/giu,
    1,
  );
  if (explicitSearchRole) {
    return explicitSearchRole;
  }

  const roleBeforeVacancyKeyword = findFirstValidJobQuery(
    goal,
    /([\p{L}][\p{L}\p{N}+.#/_-]{1,40}(?:[\s-]+[\p{L}][\p{L}\p{N}+.#/_-]{1,40}){0,3})\s+(?:vacanc(?:y|ies)|vacancies|job|jobs?|position|role|\u0432\u0430\u043a\u0430\u043d\u0441[\u0438\u044f\u0439\u0438]*|\u043f\u043e\u0437\u0438\u0446[\u0438\u044f\u044e\u0439]*|\u0440\u043e\u043b\u044c)(?=\s+(?:\u043d\u0430|on|in|at|for|as|with|and|\u0438|\u0441)\b|[,.!?:]|$)/giu,
    1,
  );
  if (roleBeforeVacancyKeyword) {
    return roleBeforeVacancyKeyword;
  }

  const roleNearVacancyKeyword = findFirstValidJobQuery(
    goal,
    /(?:\u043d\u0430\u0439\u0434\u0438|find)\s+\d{1,2}\s+(?:\u043f\u043e\u0434\u0445\u043e\u0434\u044f\u0449\w*\s+)?(?:vacanc(?:y|ies)|vacancies|job|jobs?|position|role|\u0432\u0430\u043a\u0430\u043d\u0441[\u0438\u044f\u0439\u0438]*|\u043f\u043e\u0437\u0438\u0446[\u0438\u044f\u044e\u0439]*|\u0440\u043e\u043b\u044c)\s+([\p{L}][\p{L}\p{N}+.#/_-]{1,40}(?:[\s-]+[\p{L}][\p{L}\p{N}+.#/_-]{1,40}){0,3})/giu,
    1,
  );
  if (roleNearVacancyKeyword) {
    return roleNearVacancyKeyword;
  }

  const roleAfterPreposition = findFirstValidJobQuery(
    goal,
    /(?:\u043d\u0430|for|as)\s+([\p{L}][\p{L}\p{N}+.#/_-]{1,40}(?:[\s-]+[\p{L}][\p{L}\p{N}+.#/_-]{1,40}){0,3})(?=\s+(?:with|and|\u0438|\u0441|cover|letter|\u043e\u0442\u043a\u043b\u0438\u043a|\u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0434)|[,.!?:]|$)/giu,
    1,
  );
  if (roleAfterPreposition) {
    return roleAfterPreposition;
  }

  const roleTokenRegex =
    /\b([\p{L}][\p{L}\p{N}+.#/_-]{1,30}(?:[\s-]+[\p{L}][\p{L}\p{N}+.#/_-]{1,30}){0,2})\b/giu;
  return findFirstValidJobQuery(goal, roleTokenRegex, 1);
}

export function createTaskPolicy(goal: string): TaskPolicy {
  const requestedItemCountRaw = parseRequestedItemCount(goal);
  const requestedCartAddCount = parseRequestedCartAddCount(goal);
  const mailboxLike = MAILBOX_HINT_RE.test(goal);
  const auditLike = AUDIT_HINT_RE.test(goal);
  const readOnlyLike = READ_ONLY_HINT_RE.test(goal);
  const mailboxScanFlow = mailboxLike && auditLike;
  const mailboxReadOnly = mailboxScanFlow && readOnlyLike;
  const mailboxDeleteRequested =
    mailboxScanFlow && !mailboxReadOnly && MAILBOX_DELETE_HINT_RE.test(goal);
  const mailboxDeleteVerificationCodes =
    mailboxDeleteRequested && MAILBOX_VERIFICATION_CODE_HINT_RE.test(goal);
  const shoppingAddToCart = requestedCartAddCount !== null;
  const auditReadOnlyMailboxScan = mailboxReadOnly;
  const jobApplicationFlow = JOB_HINT_RE.test(goal) && APPLY_HINT_RE.test(goal);
  const profileResumeContextRequired = jobApplicationFlow || PROFILE_RESUME_HINT_RE.test(goal);
  const requestedJobApplyCount = parseRequestedJobApplyCount(goal, jobApplicationFlow);
  const jobSearchQueryHint = parseJobSearchQueryHint(goal, jobApplicationFlow);
  const ambiguous = AMBIGUOUS_HINT_RE.test(goal);

  const requestedItemCount = mailboxScanFlow
    ? Math.min(25, requestedItemCountRaw ?? 10)
    : requestedItemCountRaw;

  const fullySpecifiedMailbox = mailboxScanFlow && !ambiguous;
  const fullySpecifiedJobApplication = jobApplicationFlow && !ambiguous;
  const fullySpecified = fullySpecifiedMailbox || fullySpecifiedJobApplication;

  return {
    auditReadOnlyMailboxScan,
    mailboxScanFlow,
    mailboxReadOnly,
    mailboxDeleteRequested,
    mailboxDeleteVerificationCodes,
    jobApplicationFlow,
    profileResumeContextRequired,
    requestedJobApplyCount,
    jobSearchQueryHint,
    fullySpecified,
    requestedItemCount,
    shoppingAddToCart,
    requestedCartAddCount,
    suppressIntermediateAssistantText: mailboxScanFlow || fullySpecifiedJobApplication,
    suppressUnnecessaryUserQuestions: fullySpecifiedMailbox || fullySpecifiedJobApplication,
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

