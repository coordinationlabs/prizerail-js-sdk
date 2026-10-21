/** Shapes the Prizerail partner API returns, as documented at docs.prizerail.com. */

export type CampaignStatus = "draft" | "active" | "paused" | "ended";
export type Cadence = "hourly" | "daily" | "weekly" | "monthly";
export type DrawingStatus =
  | "open"
  | "locked"
  | "entropy_requested"
  | "settled"
  | "paid"
  /** No entries by the cutoff, so closed without a draw. */
  | "skipped";
export type DrawingKind = "regular" | "guarantee";
export type PayoutKind = "lump_sum" | "large_prize" | "guarantee";
export type PayoutStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "held_manual";
export type GuaranteeStatus = "not_needed" | "drawn" | "skipped";

export type PrizeTier = {
  amountCents: number;
  /** A tier wins on `weight` of the table's `denominator` rolls. */
  weight: number;
  /** One winner's chance of this prize, from 0 to 1. */
  odds: number;
};

export type PrizeTable = {
  id: string;
  version: number;
  denominator: number;
  /** Top prize first. */
  tiers: PrizeTier[];
  averagePrizeCents: number;
};

export type Campaign = {
  slug: string;
  name: string;
  status: CampaignStatus;
  /** The public campaign page. */
  page: string;
  schedule: {
    cadence: Cadence;
    drawHour: number | null;
    drawMinute: number | null;
    drawWeekday: number | null;
    drawDayOfMonth: number | null;
    timezone: string;
    cutoffMinutes: number;
    startsAt: string | null;
    endsAt: string | null;
  };
  winnersPerDraw: number;
  prizeTable: PrizeTable | null;
  guarantee: {
    amountCents: number;
    thresholdCents: number;
    periodDays: number;
  } | null;
  largePrizeThresholdCents: number | null;
  termsUrl: string;
  privacyUrl: string;
  nextDrawing: {
    id: string;
    drawAt: string;
    cutoffAt: string;
    winnersPerDraw: number;
    averagePrizeCents: number | null;
  } | null;
};

export type DrawingRef = { id: string; drawAt: string; cutoffAt: string };

export type Winner = {
  position: number;
  winner: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** The rest is set once the drawing settles. */
  randomValue?: string;
  roll?: number;
  amountCents?: number;
  heldForManualPayout?: boolean;
};

export type Payout = {
  id: string;
  kind: PayoutKind;
  amountCents: number;
  status: PayoutStatus;
  chain: string;
  token: string;
  to: string;
  txHash: string | null;
  confirmedAt: string | null;
  /** The winner a large-prize or guarantee payout is for. Null for the lump sum. */
  winnerPosition: number | null;
};

export type Drawing = {
  id: string;
  kind: DrawingKind;
  number: number | null;
  drawAt: string;
  cutoffAt: string;
  status: DrawingStatus;
  winnersExpected: number;
  prizeTable: PrizeTable | null;
  needsAttention: string | null;
  winners: Winner[];
  payouts: Payout[];
  verification: {
    winnersCommitment: string | null;
    lockedAt: string | null;
    entropyProvider: string | null;
    entropyRequestId: string | null;
    entropy: string | null;
    entropyRevealedAt: string | null;
    chain: Record<string, unknown> | null;
    prizeTableId: string | null;
  };
};

export type DrawingsPage = {
  drawings: Drawing[];
  nextBefore: string | null;
  nextAfter: string | null;
};

/** An entrant id, with one entry, or an id with their entries and how they show if they win. */
export type Entrant =
  | string
  | {
      entrantId: string;
      /** Their number of entries, a whole number from 1. Leave it out and it's 1. */
      entries?: number;
      /** @deprecated Use `entries`. Still sent as `entries`. */
      weight?: number;
      /** Up to 40 characters. */
      displayName?: string;
      /** https, up to 2,048 characters. */
      avatarUrl?: string;
    };

/** @deprecated Use `Entrant`. */
export type Entry = Entrant;

/**
 * One event that earns an entrant entries, for `entries.increment()`. The
 * `eventId` names the event (an order id, a referral id, or a UUID made once
 * when it happens), and must be the same on every retry or redelivery, so
 * Prizerail can ignore repeats. Never make it per attempt.
 */
export type EntrantEvent = {
  entrantId: string;
  /** Entries this event adds, a whole number from 1. Leave it out and it's 1. */
  entries?: number;
  eventId: string;
  /** Up to 40 characters. Replaces the stored one when the event is first counted. Empty keeps it. */
  displayName?: string;
  /** https, up to 2,048 characters. Replaces the stored one when the event is first counted. Empty keeps it. */
  avatarUrl?: string;
};

export type SendEntriesResponse = {
  drawing: DrawingRef;
  /** Entrants in this request that were new, changed or the same. */
  added: number;
  updated: number;
  unchanged: number;
  /** The drawing's entrants so far. */
  entrantCount: number;
  /** The drawing's total entries so far. */
  totalEntries: number;
  /** @deprecated Use `entrantCount`. */
  count: number;
  /** @deprecated Use `totalEntries`. */
  totalWeight: number;
  /** Increment mode: events this campaign had already seen, so ignored. */
  duplicates?: number;
};

export type SentEntrant = {
  entrantId: string;
  /** Their number of entries. */
  entries: number;
  /** @deprecated Use `entries`. */
  weight: number;
  displayName: string | null;
  avatarUrl: string | null;
  /** Place in the locked list. Null until the cutoff. */
  position: number | null;
  receivedAt: string;
};

/** @deprecated Use `SentEntrant`. */
export type SentEntry = SentEntrant;

export type EntriesPage = {
  drawing: DrawingRef & { status: DrawingStatus };
  entrantCount: number;
  totalEntries: number;
  /** In arrival order, the order the list locks in. */
  entrants: SentEntrant[];
  /** @deprecated Use `entrantCount`. */
  count: number;
  /** @deprecated Use `totalEntries`. */
  totalWeight: number;
  /** @deprecated Use `entrants`, the same list. */
  entries: SentEntrant[];
  /** Pass as `after` for the next page. Null on the last. */
  next: string | null;
};

export type Guarantee = {
  id: string;
  period: number;
  periodStart: string;
  periodEnd: string;
  status: GuaranteeStatus;
  amountCents: number | null;
  drawing: {
    id: string;
    number: number | null;
    status: DrawingStatus;
    entrants: number | null;
    winner: string | null;
    displayName: string | null;
  } | null;
};
