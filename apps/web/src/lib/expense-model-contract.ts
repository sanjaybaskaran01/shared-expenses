export type ExpenseModelParticipantMode = "explicit-only" | "use-defaults" | "unspecified";
export type ExpenseModelSplitMethod = "equal" | "exact" | "percentage" | "shares" | "adjustment" | "unspecified";
export type ExpenseModelReviewReason =
  | "ambiguous-member"
  | "ambiguous-date"
  | "ambiguous-fact"
  | "conflicting-facts"
  | "hedged-split"
  | "invalid-split"
  | "missing-amount"
  | "missing-description"
  | "multiple-expenses"
  | "not-an-expense"
  | "non-positive-amount"
  | "payer-unspecified"
  | "refund-or-transfer"
  | "untrusted-instruction"
  | "unknown-person";

export interface ExpenseModelAllocation {
  memberId: string;
  valueText: string;
}

/**
 * This is an extraction contract, not a command. The model must never return
 * calculated minor units or an operation payload.
 */
export interface ExpenseModelProposal {
  kind: "expense" | "not-expense";
  descriptionText: string | null;
  merchantText: string | null;
  amountText: string | null;
  currency: string | null;
  dateText: string | null;
  payerMemberIds: string[];
  payerAllocations: ExpenseModelAllocation[];
  participantMode: ExpenseModelParticipantMode;
  participantMemberIds: string[];
  unresolvedPeople: string[];
  splitMethod: ExpenseModelSplitMethod;
  allocations: ExpenseModelAllocation[];
  recurrence: "none" | "weekly" | "fortnightly" | "monthly" | "yearly" | "unspecified";
  requiresReview: ExpenseModelReviewReason[];
}

export interface ExpenseModelSchemaOptions {
  memberIds: readonly string[];
  currencies: readonly string[];
}

export interface ExpenseModelProposalValidation {
  valid: boolean;
  errors: string[];
  requiresReview: ExpenseModelReviewReason[];
}

const reviewReasons: readonly ExpenseModelReviewReason[] = [
  "ambiguous-member",
  "ambiguous-date",
  "ambiguous-fact",
  "conflicting-facts",
  "hedged-split",
  "invalid-split",
  "missing-amount",
  "missing-description",
  "multiple-expenses",
  "not-an-expense",
  "non-positive-amount",
  "payer-unspecified",
  "refund-or-transfer",
  "untrusted-instruction",
  "unknown-person",
];

const hedgePattern = /\b(?:about|around|approximately|approx|roughly|ish|maybe|perhaps|likely|guess|i think|sort of|kind of|very\s+(?:little|less))\b/i;
const instructionPattern = /\b(?:ignore\s+(?:all\s+)?(?:prior\s+)?instructions?|system\s+prompt|delete\s+(?:everything|all)|override\s+(?:the\s+)?rules?)\b/i;
const refundOrTransferPattern = /\b(?:refund|reimburse(?:ment)?|transfer|settle(?:\s+up)?|balance\s+adjustment)\b/i;

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isKnownReason(value: string): value is ExpenseModelReviewReason {
  return (reviewReasons as readonly string[]).includes(value);
}

/**
 * Produce the one per-group JSON Schema supplied to XGrammar. Known member
 * IDs are enums, so a model cannot syntactically invent a ledger participant.
 * Unknown names remain raw text in unresolvedPeople and must be reviewed.
 */
export function buildExpenseModelProposalSchema(options: ExpenseModelSchemaOptions): Record<string, unknown> {
  const memberIds = [...new Set(options.memberIds)].sort();
  const currencies = [...new Set(options.currencies)].sort();
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "kind",
      "descriptionText",
      "merchantText",
      "amountText",
      "currency",
      "dateText",
      "payerMemberIds",
      "payerAllocations",
      "participantMode",
      "participantMemberIds",
      "unresolvedPeople",
      "splitMethod",
      "allocations",
      "recurrence",
      "requiresReview",
    ],
    properties: {
      kind: { enum: ["expense", "not-expense"] },
      descriptionText: nullable({ type: "string", maxLength: 120 }),
      merchantText: nullable({ type: "string", maxLength: 120 }),
      amountText: nullable({ type: "string", maxLength: 40 }),
      currency: nullable({ enum: currencies }),
      dateText: nullable({ type: "string", maxLength: 80 }),
      payerMemberIds: { type: "array", uniqueItems: true, items: { enum: memberIds }, maxItems: memberIds.length },
      payerAllocations: {
        type: "array",
        maxItems: memberIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["memberId", "valueText"],
          properties: {
            memberId: { enum: memberIds },
            valueText: { type: "string", minLength: 1, maxLength: 40 },
          },
        },
      },
      participantMode: { enum: ["explicit-only", "use-defaults", "unspecified"] },
      participantMemberIds: { type: "array", uniqueItems: true, items: { enum: memberIds }, maxItems: memberIds.length },
      unresolvedPeople: { type: "array", uniqueItems: true, items: { type: "string", maxLength: 120 }, maxItems: 8 },
      splitMethod: { enum: ["equal", "exact", "percentage", "shares", "adjustment", "unspecified"] },
      allocations: {
        type: "array",
        maxItems: memberIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["memberId", "valueText"],
          properties: {
            memberId: { enum: memberIds },
            valueText: { type: "string", maxLength: 40 },
          },
        },
      },
      recurrence: { enum: ["none", "weekly", "fortnightly", "monthly", "yearly", "unspecified"] },
      requiresReview: { type: "array", uniqueItems: true, items: { enum: reviewReasons }, maxItems: reviewReasons.length },
    },
  };
}

/**
 * Defense in depth after constrained decoding. The caller must still resolve
 * monetary text and validate allocations before using this proposal in a form.
 */
export function validateExpenseModelProposal(
  proposal: ExpenseModelProposal,
  options: { knownMemberIds: readonly string[]; sourceText: string },
): ExpenseModelProposalValidation {
  const knownMemberIds = new Set(options.knownMemberIds);
  const errors: string[] = [];
  const requiresReview = new Set<ExpenseModelReviewReason>(proposal.requiresReview.filter(isKnownReason));
  const memberLists = [
    proposal.payerMemberIds,
    proposal.payerAllocations.map(({ memberId }) => memberId),
    proposal.participantMemberIds,
    proposal.allocations.map(({ memberId }) => memberId),
  ];

  for (const memberIds of memberLists) {
    if (hasDuplicates(memberIds)) errors.push("A proposal cannot repeat a member ID.");
    if (memberIds.some((memberId) => !knownMemberIds.has(memberId))) errors.push("A proposal can only reference members in the selected group.");
  }
  if (hasDuplicates(proposal.unresolvedPeople)) errors.push("A proposal cannot repeat unresolved people.");
  if (hasDuplicates(proposal.requiresReview)) errors.push("A proposal cannot repeat a review reason.");
  if (proposal.requiresReview.some((reason) => !isKnownReason(reason))) errors.push("A proposal contains an unknown review reason.");

  if (proposal.unresolvedPeople.length > 0) requiresReview.add("unknown-person");
  if (proposal.kind === "not-expense") requiresReview.add("not-an-expense");
  if (!proposal.amountText) requiresReview.add("missing-amount");
  if (!proposal.descriptionText) requiresReview.add("missing-description");
  if (proposal.payerMemberIds.length === 0 && proposal.payerAllocations.length === 0) requiresReview.add("payer-unspecified");
  if (
    proposal.payerAllocations.length > 0 &&
    (proposal.payerAllocations.some(({ valueText }) => !valueText.trim()) ||
      proposal.payerAllocations.some(({ memberId }) => !proposal.payerMemberIds.includes(memberId)) ||
      proposal.payerMemberIds.some((memberId) => !proposal.payerAllocations.some((allocation) => allocation.memberId === memberId)))
  ) {
    errors.push("Payer allocations must have one non-empty raw value for every payer.");
  }
  if (hedgePattern.test(options.sourceText)) requiresReview.add("hedged-split");
  if (instructionPattern.test(options.sourceText)) requiresReview.add("untrusted-instruction");
  if (refundOrTransferPattern.test(options.sourceText)) requiresReview.add("refund-or-transfer");

  return { valid: errors.length === 0, errors, requiresReview: [...requiresReview].sort() };
}
