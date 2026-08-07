export interface SourceOptions {
  sourceName: string;
  sourceHash: string;
  maxBytes?: number;
  maxRows?: number;
}

export interface OpeningBalanceRow {
  personKey?: string;
  personName: string;
  direction: "owes_me" | "i_owe";
  amount: string;
  currency: string;
  groupName?: string;
  effectiveDate: string;
}

export interface OpeningBalanceReviewRow {
  recordId: string;
  personName: string;
  direction: "owes_me" | "i_owe";
  amountMinor: number;
  currency: string;
  groupName: string;
  effectiveDate: string;
}
