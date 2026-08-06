import type { SplitMethod } from "./store";

export interface ExpenseLanguageMember {
  userId: string;
  displayName: string;
  isActor?: boolean;
}

export type ExpenseLanguageIssueCode =
  | "missing-amount"
  | "missing-description"
  | "unknown-member"
  | "ambiguous-member"
  | "invalid-payers"
  | "invalid-split";

export interface ExpenseLanguageIssue {
  code: ExpenseLanguageIssueCode;
  message: string;
  value?: string;
}

export interface ExpenseLanguageChip {
  field: "amount" | "description" | "participants" | "payer" | "split" | "date" | "recurrence";
  label: string;
  value: string;
}

export interface ParsedExpenseLanguage {
  description?: string;
  amount?: string;
  currency: string;
  expenseDate: string;
  payerIds: string[];
  payerValues: Record<string, string>;
  participantIds: string[];
  splitMethod: SplitMethod;
  splitValues: Record<string, string>;
  recurrence: "none" | "weekly" | "fortnightly" | "monthly" | "yearly";
  status: "ready" | "needs-review" | "incomplete";
  issues: ExpenseLanguageIssue[];
  chips: ExpenseLanguageChip[];
  elapsedMs: number;
}

interface ParseExpenseLanguageOptions {
  members: ExpenseLanguageMember[];
  defaultCurrency: string;
  defaultParticipantIds?: string[];
  now?: Date;
}

interface MoneyMention {
  amount: number;
  currency: string;
  start: number;
  end: number;
  raw: string;
}

interface MemberAlias {
  alias: string;
  normalized: string;
  members: ExpenseLanguageMember[];
}

const currencyAliases: Record<string, string> = {
  "$": "USD",
  "US$": "USD",
  "C$": "CAD",
  "CA$": "CAD",
  "A$": "AUD",
  "AU$": "AUD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  dollar: "USD",
  dollars: "USD",
  buck: "USD",
  bucks: "USD",
  rupee: "INR",
  rupees: "INR",
  euro: "EUR",
  euros: "EUR",
  pound: "GBP",
  pounds: "GBP",
  USD: "USD",
  CAD: "CAD",
  EUR: "EUR",
  GBP: "GBP",
  INR: "INR",
  AUD: "AUD",
  JPY: "JPY",
  SGD: "SGD",
  CHF: "CHF",
  CNY: "CNY",
};

const currencyToken = String.raw`(?:US\$|CA\$|C\$|AU\$|A\$|[$€£₹]|USD|CAD|EUR|GBP|INR|AUD|JPY|SGD|CHF|CNY)`;
const currencyWord = String.raw`(?:dollars?|bucks?|rupees?|euros?|pounds?|USD|CAD|EUR|GBP|INR|AUD|JPY|SGD|CHF|CNY)`;
const numericAmount = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCaseDescription(value: string): string {
  const cleaned = value
    .replace(/^[,;:\s-]+|[,;:\s-]+$/g, "")
    .replace(/^(?:the\s+)?(?:bill|total|expense)\s+(?:was|is)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

function localDate(date: Date): string {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 10);
}

function parseDate(text: string, now: Date): string {
  if (/\byesterday\b/i.test(text)) {
    const value = new Date(now);
    value.setDate(value.getDate() - 1);
    return localDate(value);
  }
  if (/\btomorrow\b/i.test(text)) {
    const value = new Date(now);
    value.setDate(value.getDate() + 1);
    return localDate(value);
  }
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  const monthDate = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i);
  if (monthDate) {
    const parsed = new Date(`${monthDate[1]} ${monthDate[2]}, ${monthDate[3] ?? now.getFullYear()} 12:00:00`);
    if (!Number.isNaN(parsed.getTime())) return localDate(parsed);
  }
  return localDate(now);
}

function parseRecurrence(text: string): ParsedExpenseLanguage["recurrence"] {
  if (/\b(?:every\s+(?:other|2)\s+weeks?|fortnightly|biweekly)\b/i.test(text)) return "fortnightly";
  if (/\b(?:every\s+weeks?|weekly)\b/i.test(text)) return "weekly";
  if (/\b(?:every\s+months?|monthly)\b/i.test(text)) return "monthly";
  if (/\b(?:every\s+years?|yearly|annually|annual)\b/i.test(text)) return "yearly";
  return "none";
}

function buildAliases(members: ExpenseLanguageMember[]): MemberAlias[] {
  const aliases = new Map<string, { alias: string; members: ExpenseLanguageMember[] }>();
  const add = (alias: string, member: ExpenseLanguageMember) => {
    const normalized = normalize(alias);
    if (!normalized) return;
    const current = aliases.get(normalized);
    if (current) {
      if (!current.members.some((candidate) => candidate.userId === member.userId)) current.members.push(member);
    }
    else aliases.set(normalized, { alias, members: [member] });
  };

  for (const member of members) {
    add(member.displayName, member);
    const firstName = member.displayName.trim().split(/\s+/)[0];
    if (firstName) add(firstName, member);
  }
  const actor = members.find((member) => member.isActor);
  if (actor) for (const alias of ["I", "me", "myself", "mine", "my"]) add(alias, actor);

  return [...aliases.entries()]
    .map(([normalized, entry]) => ({ ...entry, normalized }))
    .sort((left, right) => right.normalized.length - left.normalized.length);
}

function resolveMember(value: string, aliases: MemberAlias[]): { member?: ExpenseLanguageMember; ambiguous?: ExpenseLanguageMember[] } {
  const target = normalize(value.replace(/^(?:and|plus)\s+/i, "").replace(/\b(?:each|too|also)\b/gi, ""));
  const match = aliases.find((alias) => alias.normalized === target);
  if (!match) return {};
  const unique = [...new Map(match.members.map((member) => [member.userId, member])).values()];
  return unique.length === 1 ? { member: unique[0]! } : { ambiguous: unique };
}

function extractMoney(text: string, defaultCurrency: string): MoneyMention[] {
  const mentions: MoneyMention[] = [];
  const patterns = [
    new RegExp(`(${currencyToken})\\s*(${numericAmount})`, "gi"),
    new RegExp(`(${numericAmount})\\s*(${currencyWord})\\b`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const firstIsNumber = /^\d/.test(match[1] ?? "");
      const rawAmount = firstIsNumber ? match[1] : match[2];
      const rawCurrency = firstIsNumber ? match[2] : match[1];
      const amount = Number(rawAmount?.replace(/,/g, ""));
      if (!Number.isFinite(amount)) continue;
      const start = match.index ?? 0;
      if (mentions.some((mention) => start >= mention.start && start < mention.end)) continue;
      const ambiguousDollar = /^(?:\$|dollars?|bucks?)$/i.test(rawCurrency ?? "");
      const dollarCurrencies = new Set(["USD", "CAD", "AUD", "SGD"]);
      const currency = ambiguousDollar && dollarCurrencies.has(defaultCurrency)
        ? defaultCurrency
        : currencyAliases[rawCurrency ?? ""] ?? currencyAliases[(rawCurrency ?? "").toUpperCase()] ?? defaultCurrency;
      mentions.push({ amount, currency, start, end: start + match[0].length, raw: match[0] });
    }
  }
  return mentions.sort((left, right) => left.start - right.start);
}

function findAliasOccurrences(text: string, aliases: MemberAlias[]): Array<{ start: number; end: number; alias: MemberAlias }> {
  const found: Array<{ start: number; end: number; alias: MemberAlias }> = [];
  for (const alias of aliases) {
    const words = alias.alias.trim().split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
    const pattern = new RegExp(`(^|[^A-Za-z0-9])(${words})(?=$|[^A-Za-z0-9])`, "gi");
    for (const match of text.matchAll(pattern)) {
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      const end = start + (match[2]?.length ?? 0);
      if (found.some((item) => start >= item.start && end <= item.end)) continue;
      found.push({ start, end, alias });
    }
  }
  return found.sort((left, right) => left.start - right.start || right.end - left.end);
}

function addIssueOnce(issues: ExpenseLanguageIssue[], issue: ExpenseLanguageIssue): void {
  if (!issues.some((current) => current.code === issue.code && current.value === issue.value)) issues.push(issue);
}

function extractParticipants(
  text: string,
  members: ExpenseLanguageMember[],
  aliases: MemberAlias[],
  issues: ExpenseLanguageIssue[],
  defaults?: string[],
): string[] {
  const actor = members.find((member) => member.isActor);
  const ids: string[] = [];
  const excludedIds = new Set<string>();
  const add = (id: string | undefined) => { if (id && !ids.includes(id)) ids.push(id); };
  const participantClause = text.match(/\b(with|between|among|including)\s+(.+?)(?=\s+(?:for\s+(?:US\$|CA\$|C\$|AU\$|A\$|[$€£₹]|USD|CAD|EUR|GBP|INR|AUD|JPY|SGD|CHF|CNY|\d)|but\b|split\b|paid\b|bill\b|total\b|cost\b|on\b|yesterday\b|today\b|tomorrow\b|repeat\b|every\b)|[.;]|$)/i);
  const exclusiveClause = participantClause ? /^(?:between|among)$/i.test(participantClause[1]!) : false;

  const exclusion = text.match(/\b(?:except|excluding|but\s+not)\s+(.+?)(?=\s+(?:for\s+(?:US\$|CA\$|C\$|AU\$|A\$|[$€£₹]|USD|CAD|EUR|GBP|INR|AUD|JPY|SGD|CHF|CNY|\d)|split\b|paid\b|bill\b|total\b|cost\b|on\b|yesterday\b|today\b|tomorrow\b|repeat\b|every\b)|[.;]|$)/i);
  if (exclusion) {
    for (const candidate of exclusion[1]!.split(/\s*(?:,|&|\band\b|\bplus\b)\s*/i).filter(Boolean)) {
      const resolved = resolveMember(candidate, aliases);
      if (resolved.member) excludedIds.add(resolved.member.userId);
      else if (resolved.ambiguous) addIssueOnce(issues, { code: "ambiguous-member", value: titleCaseDescription(candidate), message: `More than one person is named ${titleCaseDescription(candidate)}. Choose the right one.` });
      else addIssueOnce(issues, { code: "unknown-member", value: titleCaseDescription(candidate), message: `${titleCaseDescription(candidate)} is not in this group yet.` });
    }
  }

  if (/\b(?:everyone|everybody|all of us|whole group)\b/i.test(text)) {
    for (const member of members) add(member.userId);
  } else if (participantClause) {
    if (!exclusiveClause) add(actor?.userId);
    const candidates = participantClause[2]!.split(/\s*(?:,|&|\band\b|\bplus\b)\s*/i).filter(Boolean);
    for (const candidate of candidates) {
      const cleaned = candidate.replace(/\b(?:the\s+)?(?:three|four|five|people|person|of us)\b/gi, "").trim();
      if (!cleaned) continue;
      const resolved = resolveMember(cleaned, aliases);
      if (resolved.member) add(resolved.member.userId);
      else if (resolved.ambiguous) addIssueOnce(issues, { code: "ambiguous-member", value: titleCaseDescription(cleaned), message: `More than one person is named ${titleCaseDescription(cleaned)}. Choose the right one.` });
      else addIssueOnce(issues, { code: "unknown-member", value: titleCaseDescription(cleaned), message: `${titleCaseDescription(cleaned)} is not in this group yet.` });
    }
  } else if (defaults?.length) {
    for (const id of defaults) if (members.some((member) => member.userId === id)) add(id);
  } else {
    add(actor?.userId);
  }

  // A payer or specifically assigned person is necessarily involved, even if they
  // appeared outside the "with" clause. Ambiguous aliases are never auto-selected.
  for (const occurrence of findAliasOccurrences(text, aliases)) {
    if (exclusiveClause) continue;
    const unique = [...new Map(occurrence.alias.members.map((member) => [member.userId, member])).values()];
    if (unique.length !== 1) continue;
    const around = text.slice(Math.max(0, occurrence.start - 12), Math.min(text.length, occurrence.end + 32));
    if (/\b(?:paid|covered|fronted|owes?|share|shares|ate|had|more|less)\b/i.test(around)) add(unique[0]!.userId);
  }
  return ids.filter((id) => !excludedIds.has(id));
}

function memberLabel(memberId: string, members: ExpenseLanguageMember[]): string {
  const member = members.find((item) => item.userId === memberId);
  return member?.isActor ? "you" : member?.displayName.split(/\s+/)[0] ?? "someone";
}

function extractPayers(
  text: string,
  amount: number | undefined,
  members: ExpenseLanguageMember[],
  aliases: MemberAlias[],
  money: MoneyMention[],
  issues: ExpenseLanguageIssue[],
): { payerIds: string[]; payerValues: Record<string, string>; attributedMoney: Set<number> } {
  const actor = members.find((member) => member.isActor);
  const payerIds: string[] = [];
  const payerValues: Record<string, string> = {};
  const attributedMoney = new Set<number>();
  const add = (member: ExpenseLanguageMember, value?: number) => {
    if (!payerIds.includes(member.userId)) payerIds.push(member.userId);
    if (value !== undefined) payerValues[member.userId] = value.toFixed(2);
  };

  for (const occurrence of findAliasOccurrences(text, aliases)) {
    const unique = [...new Map(occurrence.alias.members.map((member) => [member.userId, member])).values()];
    if (unique.length !== 1) continue;
    const after = text.slice(occurrence.end, occurrence.end + 28);
    const before = text.slice(Math.max(0, occurrence.start - 18), occurrence.start);
    const paidAfter = after.match(/^\s+(?:also\s+)?(?:paid|covered|fronted)\b/i);
    const paidBefore = /(?:paid|covered)\s+by\s*$/i.test(before);
    if (!paidAfter && !paidBefore) continue;
    const paymentEnd = occurrence.end + (paidAfter?.[0].length ?? 0);
    const mentionIndex = money.findIndex((item) => item.start >= paymentEnd && item.start - paymentEnd <= 6);
    if (mentionIndex >= 0) {
      attributedMoney.add(mentionIndex);
      add(unique[0]!, money[mentionIndex]!.amount);
    } else add(unique[0]!);
  }

  if (payerIds.length === 0 && /\b(?:paid|covered)\s+by\s+(?:me|myself)\b/i.test(text) && actor) add(actor);
  if (payerIds.length === 0 && actor) add(actor);

  if (payerIds.length > 1 && amount !== undefined && Object.keys(payerValues).length === payerIds.length) {
    const paid = Object.values(payerValues).reduce((sum, value) => sum + Number(value), 0);
    if (Math.abs(paid - amount) > 0.005) addIssueOnce(issues, { code: "invalid-payers", message: `Payer amounts add to ${paid.toFixed(2)}, not ${amount.toFixed(2)}.` });
  }
  return { payerIds, payerValues, attributedMoney };
}

function formatPercent(basisPoints: number): string {
  const value = basisPoints / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function distributePercentRemainder(values: Record<string, string>, participantIds: string[]): Record<string, string> | undefined {
  const specified = participantIds.filter((id) => values[id] !== undefined);
  const unspecified = participantIds.filter((id) => values[id] === undefined);
  const usedBasisPoints = specified.reduce((sum, id) => sum + Math.round(Number(values[id]) * 100), 0);
  if (usedBasisPoints > 10_000 || unspecified.length === 0 && usedBasisPoints !== 10_000) return undefined;
  if (unspecified.length === 0) return values;
  const remaining = 10_000 - usedBasisPoints;
  const base = Math.floor(remaining / unspecified.length);
  let extra = remaining % unspecified.length;
  const result = { ...values };
  for (const id of unspecified) result[id] = formatPercent(base + (extra-- > 0 ? 1 : 0));
  return result;
}

function distributeMoneyRemainder(values: Record<string, string>, participantIds: string[], amount: number): Record<string, string> | undefined {
  const unspecified = participantIds.filter((id) => values[id] === undefined);
  const totalMinor = Math.round(amount * 100);
  const usedMinor = participantIds.reduce((sum, id) => sum + Math.round(Number(values[id] ?? 0) * 100), 0);
  if (usedMinor > totalMinor || unspecified.length === 0 && usedMinor !== totalMinor) return undefined;
  if (unspecified.length === 0) return values;
  const remaining = totalMinor - usedMinor;
  const base = Math.floor(remaining / unspecified.length);
  let extra = remaining % unspecified.length;
  const result = { ...values };
  for (const id of unspecified) result[id] = ((base + (extra-- > 0 ? 1 : 0)) / 100).toFixed(2);
  return result;
}

function extractSplit(
  text: string,
  amount: number | undefined,
  participantIds: string[],
  aliases: MemberAlias[],
  issues: ExpenseLanguageIssue[],
): { splitMethod: SplitMethod; splitValues: Record<string, string> } {
  const occurrences = findAliasOccurrences(text, aliases).filter((item) => item.alias.members.length === 1);
  const textAfterMember = (index: number, maximum: number): string => {
    const occurrence = occurrences[index]!;
    const nextMemberStart = occurrences.slice(index + 1).find((candidate) => candidate.start >= occurrence.end)?.start;
    return text.slice(occurrence.end, Math.min(occurrence.end + maximum, nextMemberStart ?? text.length));
  };
  const adjustmentValues: Record<string, string> = {};
  for (const [index, occurrence] of occurrences.entries()) {
    const member = occurrence.alias.members[0]!;
    const after = textAfterMember(index, 42);
    const match = after.match(new RegExp(`^[^.;]{0,18}?(${currencyToken})?\\s*(${numericAmount})\\s*(?:${currencyWord})?\\s+(more|less)\\b`, "i"));
    if (match) adjustmentValues[member.userId] = `${match[3]!.toLowerCase() === "less" ? "-" : ""}${Number(match[2]!.replace(/,/g, "")).toFixed(2)}`;
  }
  if (Object.keys(adjustmentValues).length || /\b(?:adjust|adjustment)\b/i.test(text)) {
    const values = Object.fromEntries(participantIds.map((id) => [id, adjustmentValues[id] ?? "0.00"]));
    const total = Object.values(values).reduce((sum, value) => sum + Number(value), 0);
    if (Math.abs(total) > 0.005) addIssueOnce(issues, { code: "invalid-split", message: "Adjustments must balance back to zero." });
    return { splitMethod: "adjustment", splitValues: values };
  }

  const shareValues: Record<string, string> = {};
  for (const [index, occurrence] of occurrences.entries()) {
    const member = occurrence.alias.members[0]!;
    const after = textAfterMember(index, 42);
    const match = after.match(/^[^.;\d]{0,24}?(\d+)\s*(?:x|shares?)\b/i);
    if (match) shareValues[member.userId] = String(Number(match[1]));
  }
  if (Object.keys(shareValues).length || /\b(?:by\s+shares?|weighted|share\s+each)\b/i.test(text)) {
    return { splitMethod: "shares", splitValues: Object.fromEntries(participantIds.map((id) => [id, shareValues[id] ?? "1"])) };
  }

  const percentageValues: Record<string, string> = {};
  for (const [index, occurrence] of occurrences.entries()) {
    const member = occurrence.alias.members[0]!;
    const after = textAfterMember(index, 38);
    const match = after.match(/^[^.;%]{0,25}?(\d{1,3}(?:\.\d{1,2})?)\s*%/);
    if (match) percentageValues[member.userId] = String(Number(match[1]));
  }
  if (Object.keys(percentageValues).length || /\b(?:by\s+percent(?:age)?|percentage\s+split)\b/i.test(text)) {
    const completed = distributePercentRemainder(percentageValues, participantIds);
    if (!completed) {
      addIssueOnce(issues, { code: "invalid-split", message: "Percentages must add to 100%." });
      return { splitMethod: "percentage", splitValues: percentageValues };
    }
    return { splitMethod: "percentage", splitValues: completed };
  }

  const exactValues: Record<string, string> = {};
  for (const [index, occurrence] of occurrences.entries()) {
    const member = occurrence.alias.members[0]!;
    const after = textAfterMember(index, 48);
    const owes = after.match(new RegExp(`^[^.;]{0,14}?\\b(?:owes?|had|ate|share(?:\\s+is)?|portion(?:\\s+is)?)\\s*(${currencyToken})?\\s*(${numericAmount})(?:\\s*${currencyWord})?`, "i"));
    if (owes) exactValues[member.userId] = Number(owes[2]!.replace(/,/g, "")).toFixed(2);
  }
  if (Object.keys(exactValues).length || /\b(?:exact(?:ly)?|by\s+amounts?)\b/i.test(text)) {
    if (amount === undefined) {
      addIssueOnce(issues, { code: "invalid-split", message: "Add the total so the exact shares can be checked." });
      return { splitMethod: "exact", splitValues: exactValues };
    }
    const completed = distributeMoneyRemainder(exactValues, participantIds, amount);
    if (!completed) {
      addIssueOnce(issues, { code: "invalid-split", message: "Exact shares must add to the total." });
      return { splitMethod: "exact", splitValues: exactValues };
    }
    return { splitMethod: "exact", splitValues: completed };
  }

  return { splitMethod: "equal", splitValues: {} };
}

function extractDescription(text: string, money: MoneyMention[]): string | undefined {
  const forDescription = text.match(/\bfor\s+([A-Za-z][A-Za-z0-9 '&-]{0,80}?)(?=\s+(?:with|between|among|including|split|on|yesterday|today|tomorrow|repeat|every)\b|[,;.]|$)/i);
  if (forDescription) {
    const value = titleCaseDescription(forDescription[1]!);
    if (value && !new RegExp(String.raw`^(?:${currencyToken}|${numericAmount})`, "i").test(value)) return value;
  }

  let end = text.length;
  const boundaries = [
    text.search(/\b(?:with|between|among|including)\b/i),
    money[0]?.start ?? -1,
    text.search(/\b(?:paid|covered|fronted)\b/i),
    text.search(/\b(?:bill|total|cost)\b/i),
  ].filter((value) => value >= 0);
  if (boundaries.length) end = Math.min(...boundaries);
  let value = text.slice(0, end);
  if (/^(?:i|me|myself|[A-Za-z][A-Za-z '-]+)\s+(?:paid|covered|fronted)\b/i.test(value)) value = "";
  const cleaned = titleCaseDescription(value);
  return cleaned || undefined;
}

function chooseTotalMoney(text: string, money: MoneyMention[], payerAttributed: Set<number>): MoneyMention | undefined {
  if (money.length === 0) return undefined;
  const explicitlyTotal = money.find((mention) => {
    const before = text.slice(Math.max(0, mention.start - 24), mention.start);
    const after = text.slice(mention.end, mention.end + 12);
    return /(?:\b(?:bill|total|cost)(?:\s+(?:was|is))?\s*|\bfor\s*)$/i.test(before) || /^\s*(?:total|altogether)\b/i.test(after);
  });
  if (explicitlyTotal) return explicitlyTotal;
  if (money.length === 1) return money[0];
  if (payerAttributed.size === money.length) {
    const amount = money.reduce((sum, mention) => sum + mention.amount, 0);
    return { amount, currency: money[0]!.currency, start: money[0]!.start, end: money.at(-1)!.end, raw: "payer total" };
  }
  return money[0];
}

function splitLabel(method: SplitMethod, values: Record<string, string>, members: ExpenseLanguageMember[]): string {
  if (method === "equal") return "Split equally";
  const detail = Object.entries(values)
    .sort(([left], [right]) => {
      const order = (id: string) => {
        const index = members.findIndex((member) => member.userId === id);
        return members[index]?.isActor ? -1 : index;
      };
      return order(left) - order(right);
    })
    .map(([id, value]) => `${memberLabel(id, members)} ${method === "percentage" ? `${value}%` : method === "shares" ? `${value}×` : value}`)
    .join(", ");
  if (method === "exact") return `Exact · ${detail}`;
  if (method === "percentage") return `Percent · ${detail}`;
  if (method === "shares") return `Shares · ${detail}`;
  return `Adjusted · ${detail}`;
}

export function parseExpenseLanguage(text: string, options: ParseExpenseLanguageOptions): ParsedExpenseLanguage {
  const started = performance.now();
  const now = options.now ?? new Date();
  const issues: ExpenseLanguageIssue[] = [];
  const aliases = buildAliases(options.members);
  const money = extractMoney(text, options.defaultCurrency);
  const preliminaryPayers = extractPayers(text, undefined, options.members, aliases, money, issues);
  const total = chooseTotalMoney(text, money, preliminaryPayers.attributedMoney);
  const amount = total?.amount;
  const currency = total?.currency ?? money[0]?.currency ?? options.defaultCurrency;
  const participants = extractParticipants(text, options.members, aliases, issues, options.defaultParticipantIds);
  const payerResult = extractPayers(text, amount, options.members, aliases, money, issues);
  const participantOrder = (id: string) => {
    const index = options.members.findIndex((member) => member.userId === id);
    return options.members[index]?.isActor ? -1 : index;
  };
  participants.sort((left, right) => participantOrder(left) - participantOrder(right));
  const split = extractSplit(text, amount, participants, aliases, issues);
  const description = extractDescription(text, money);
  const expenseDate = parseDate(text, now);
  const recurrence = parseRecurrence(text);

  if (amount === undefined || amount <= 0) issues.unshift({ code: "missing-amount", message: "Add the total amount." });
  if (!description) addIssueOnce(issues, { code: "missing-description", message: "Add what the expense was for." });

  const hasRequiredIssue = issues.some((issue) => issue.code === "missing-amount" || issue.code === "missing-description");
  const status: ParsedExpenseLanguage["status"] = hasRequiredIssue ? "incomplete" : issues.length ? "needs-review" : "ready";
  const amountString = amount === undefined ? undefined : amount.toFixed(2);
  const chips: ExpenseLanguageChip[] = [];
  if (amountString) chips.push({ field: "amount", label: "Amount", value: new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(amountString)) });
  if (description) chips.push({ field: "description", label: "For", value: description });
  if (participants.length) chips.push({ field: "participants", label: "With", value: participants.map((id) => memberLabel(id, options.members)).join(", ") });
  if (payerResult.payerIds.length) chips.push({ field: "payer", label: "Paid by", value: payerResult.payerIds.map((id) => memberLabel(id, options.members)).join(", ") });
  chips.push({ field: "split", label: "Split", value: splitLabel(split.splitMethod, split.splitValues, options.members) });
  chips.push({ field: "date", label: "When", value: expenseDate === localDate(now) ? "Today" : expenseDate });
  if (recurrence !== "none") chips.push({ field: "recurrence", label: "Repeats", value: recurrence });

  return {
    ...(description ? { description } : {}),
    ...(amountString ? { amount: amountString } : {}),
    currency,
    expenseDate,
    payerIds: payerResult.payerIds,
    payerValues: payerResult.payerValues,
    participantIds: participants,
    splitMethod: split.splitMethod,
    splitValues: split.splitValues,
    recurrence,
    status,
    issues,
    chips,
    elapsedMs: performance.now() - started,
  };
}
