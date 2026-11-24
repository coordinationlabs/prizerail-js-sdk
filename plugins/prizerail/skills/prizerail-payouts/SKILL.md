---
name: prizerail-payouts
description: "Build the job that pays a partner's winners from the transfers Prizerail sends to the partner's payout wallet, in the developer's own codebase. It pays each winner once, when the transfer that carries their prize is confirmed, and handles large prizes, prizes held for winner publicity and guarantee draws, which arrive as separate transfers. Use when someone asks to pay Prizerail winners, distribute prizes, build or fix a payout script or executor, handle a held or large prize, or asks why a winner wasn't paid or was paid twice."
---

# Pay winners from Prizerail's transfers

When a campaign's prizes go to the partner's payout wallet, Prizerail sends the money and the partner's app pays each winner. This skill builds that job in the developer's codebase. The docs page for it is [Pay your winners](https://docs.prizerail.com/integrations/pay-your-winners).

If a drawing's `payoutMode` in the API is `direct_winner`, Prizerail pays that campaign's winners directly and there is nothing to build. Say so and stop.

## 1. Read the repo and ask first

Read the codebase before writing anything. Find:

- **The stack and the database**, and how scheduled jobs run there (cron, a queue, a worker).
- **How the app pays a user today:** an onchain transfer, in-app credit, or something else. Reuse it. Don't write a second way to move money.
- **Where entrant ids come from.** The app sent an entrant id with each user's entries, usually an HMAC of its user id. Find that code and how to map an id back to a user. If there is no stored mapping, add one.
- **An existing payout job.** If there is one, fix it to follow the rule below. Don't add a second job beside it.

Then ask the developer only what the code doesn't answer: how winners should be paid, and whether a person should approve payouts above some amount.

## 2. The rule

**Pay a winner when the transfer that carries their prize is `confirmed`. Never before, and never twice.**

A draw's prizes don't always arrive together. Each drawing has `winners[]` and `payouts[]`, the transfers Prizerail made for it:

| Transfer `kind` | Carries | Arrives |
|---|---|---|
| `lump_sum` | Every prize that isn't held, in one transfer | A few minutes after the draw |
| `large_prize` | One prize, for a winner whose prizes in the draw reach the campaign's large-prize threshold | After Prizerail staff review it, and after the winner's publicity is approved if they were asked |
| `publicity_prize` | One prize, for a winner under that threshold who was asked for publicity | After the winner's publicity is approved |

To find the transfer for a winner:

1. Look for a `payouts[]` row whose `winnerPosition` equals the winner's `position`. If there is one, that is their transfer.
2. If there is none, their prize is in the `lump_sum` row.
3. If there is no row at all, the money hasn't been sent. Skip the winner this run.

Pay the winner only when that row's `status` is `confirmed`. A held prize reads `held_manual` or `held_publicity` until Prizerail releases it. `pending` and `submitted` are on their way. `failed` needs nothing from the app: Prizerail is alerted and sends it again.

## 3. The table

One row per win, with a unique constraint on the drawing's `id` and the winner's `position`. That pair is the key, because with repeat winners one person can fill several slots in a draw.

```sql
create table prize_payments (
  drawing_id   text    not null,
  position     integer not null,
  entrant_id   text    not null,
  amount_cents integer not null,
  status       text    not null,  -- 'sending', then 'paid'
  reference    text,              -- your transaction hash or credit id
  created_at   timestamptz not null default now(),
  primary key (drawing_id, position)
);
```

Use the project's own migration tool and naming. Insert the row as `sending` **before** paying. If the insert hits the unique constraint, the win is already handled, so skip it.

## 4. The job

Write it with the `prizerail` package in TypeScript or JavaScript, and plain HTTP elsewhere. `store` is the table above and `pay` is the app's own way of paying a user.

```ts
import { type Drawing, Prizerail } from "prizerail";

const campaign = new Prizerail({ apiKey: process.env.PRIZERAIL_API_KEY }).campaign(
  process.env.PRIZERAIL_CAMPAIGN!
);

type Win = { drawingId: string; position: number; entrantId: string; amountCents: number };

/** Your database. One row per win, unique on (drawingId, position). */
export type Store = {
  /** Inserts the win as "sending". Returns false if the row already exists. */
  claim(win: Win): Promise<boolean>;
  /** Marks the win paid, with your transaction hash or credit id. */
  markPaid(win: Win, reference: string): Promise<void>;
};

/** The transfer that carries a win: its own row if it has one, else the lump sum. */
export function transferFor(drawing: Drawing, position: number) {
  return (
    drawing.payouts.find(p => p.winnerPosition === position) ??
    drawing.payouts.find(p => p.kind === "lump_sum") ??
    null
  );
}

/** Pays every win in a drawing whose money has reached your wallet. Safe to run again. */
export async function payDrawing(
  drawing: Drawing,
  store: Store,
  pay: (win: Win) => Promise<string>
) {
  for (const w of drawing.winners) {
    // Not in your wallet yet: a held prize, or a transfer still on its way.
    if (transferFor(drawing, w.position)?.status !== "confirmed") continue;
    const win = {
      drawingId: drawing.id,
      position: w.position,
      entrantId: w.winner,
      amountCents: w.amountCents ?? 0,
    };
    // Already paid, or being paid by another run.
    if (!(await store.claim(win))) continue;
    await store.markPaid(win, await pay(win));
  }
}

/** Run this every few minutes. A held prize is picked up on the run after it arrives. */
export async function payRecentDrawings(store: Store, pay: (win: Win) => Promise<string>) {
  for (const status of ["settled", "paid"] as const) {
    const { drawings } = await campaign.drawings.list({ status, limit: 50 });
    for (const drawing of drawings) await payDrawing(drawing, store, pay);
  }
}
```

Without the package, the same data is at `GET /api/v1/campaigns/{slug}/drawings?status=settled` and `?status=paid`, with `Authorization: Bearer <key>`, on the key's own site (`https://sandbox.prizerail.com` for a `pr_sandbox_` key, `https://www.prizerail.com` for a `pr_prod_` key).

Schedule it every few minutes. There are no webhooks, so the job polls.

## 5. Rules that must be in the code

- **Read both `settled` and `paid` drawings.** A drawing stays `settled` until every transfer has confirmed, held prizes included. A job that waits for `paid` delays every other winner in a draw that has one held prize.
- **Pay each winner their own `amountCents`.** Never divide the lump sum across all the winners. It carries only the prizes that aren't held.
- **Decide from each transfer's `status`.** Never from the wallet's balance.
- **Never retry a `sending` row automatically.** If a run stops between inserting the row and saving its reference, the payment may or may not have gone out. Report those rows for a person to check. When paying onchain, sign the transaction and save its hash before broadcasting. A restart can then send the same signed transaction again, which can't pay twice.
- **Run one copy of the job at a time,** or rely on the unique constraint as the lock, as the code above does.
- **Amounts are in cents.** Transfers are USDC on Base, to the wallet in the transfer's `to`. One cent is 10,000 USDC base units.
- **Guarantee draws are drawings with `kind` `"guarantee"`.** Don't filter them out. A guaranteed prize at or above the large-prize threshold arrives as one `large_prize` transfer, with no lump sum.
- **Winner publicity is separate.** A winner with `publicity.required` true and a `publicity.url` has to share their win before Prizerail releases the prize. Showing them that link is in the `prizerail-integrate` skill. This job only pays once the transfer confirms.

## 6. Prove it works

1. In the sandbox, send a few entries and run a draw: `npx prizerail check <campaign slug> --draw`.
2. Run the job. Every winner whose transfer is `confirmed` is paid once.
3. Run the job again. It pays nobody.
4. Write a test for `transferFor` with three drawings: one with only a lump sum, one with a lump sum and a `large_prize` row at `held_manual`, and one with only a `large_prize` row. The held winner must not be paid in the second and third until the row is `confirmed`.

Sandbox transfers aren't real money, so check the job against each transfer's `status`, not the wallet.

Tell the developer what was built, where the table and the schedule are, and which rows, if any, are stuck at `sending`.
