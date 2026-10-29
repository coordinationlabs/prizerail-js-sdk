---
name: prizerail-check
description: "Check a Prizerail integration end to end with the developer's API key by running `npx prizerail check <campaign>`: that the key works and matches its environment, that the campaign is active with a drawing taking entries, that the entrant ids sent look opaque, that entry counts look right, and in the sandbox that a whole draw runs and verifies. Use when someone asks whether their Prizerail integration works, why entries aren't showing up, to test or smoke-test a campaign, or to run a draw in the sandbox."
---

# Check a Prizerail integration

Run the command instead of reasoning through the checks. It reads the campaign with the developer's key, inspects what Prizerail has, and prints one line per check.

```sh
npx prizerail check <campaign slug>
npx prizerail check <campaign slug> --draw     # sandbox only: also run a draw and verify it
```

It needs `PRIZERAIL_API_KEY` in the environment. The key picks the site: a `pr_sandbox_` key checks `https://sandbox.prizerail.com`, a `pr_prod_` key `https://www.prizerail.com`. Pass `--site <url>` only for a server somewhere else. Node 20 or later.

## What it checks

| Check | Passes when | When it doesn't |
|---|---|---|
| **Key** | The key is accepted by the site it belongs to | A `401` means an unknown or revoked key, or a sandbox key sent to production (or the reverse). Keys are made by an owner in the partner portal under **Team → API keys**, and each works only on its own site. |
| **Campaign** | `status` is `active` | A `draft` doesn't draw. A `paused` campaign has no drawing taking entries. An `ended` one refuses entries with `409 campaign_ended`. The owner changes status in the portal. |
| **Open drawing** | A drawing is taking entries, with its cutoff shown | None open while paused, or between a cutoff and the next drawing being made. Entries sent now would get `409 no_open_drawing`. |
| **Entrant ids** | The first 5,000 ids in the open drawing look opaque | It fails on ids that look like an email, a username (a word with separators or in camelCase, even with a year on the end), a name with spaces, any all-digit id, or any id shorter than 16 characters. A few username-shaped ids in a large sample are a note, not a failure, since a random id now and then reads like a word. It notes any UUID: fine if it was made for Prizerail and stored, not if it's the app's own users table id. Entrant ids are published, hashed, with every draw, so they must be an HMAC of the user id with a secret key, or a random id the app stores. See [Entrant ids](https://docs.prizerail.com/getting-started/concepts#make-entrant-ids-with-an-hmac). |
| **Entries** | Entries are whole numbers from 1 to 4,294,967,295, and the spread looks deliberate | It notes when every entrant has exactly 1 entry, which is fine if entries aren't used, and a problem if the app meant to send totals and left `entries` out, since an entrant sent without it is set back to 1. It also notes a total that is far above the others. |
| **Draw** (`--draw`, sandbox only) | The open drawing is drawn now, settles, and its proof passes the verify script | Outside the sandbox the API answers `403 sandbox_only`. With no entries the command stops with "Nothing to draw from" before asking (the API's own answer to a bare run is `409 no_entries`). If the API answers 202 with the draw still `entropy_requested`, the command polls it for up to 3 minutes and says so if it hasn't settled. A settled draw can carry an `i` "flagged for staff" note, such as "Campaign has no payout address" in a sandbox campaign with no wallet: the draw and its proof still pass, it just stays `settled` rather than `paid`. |

It prints `✓` for a passing check, `✗` for a failing one, and `i` for a note, and exits 0 only if nothing failed. Report each `✗` and `i` line as printed, with the fix from the table above.

## Reading the output with the developer

- **No entries in the open drawing** with a passing key and campaign: the sender hasn't run yet, or it's pointed at another campaign or the other environment. Check `PRIZERAIL_CAMPAIGN` and the key's prefix against the site.
- **Entries in the last drawing but not this one:** entries land in the drawing whose cutoff is next when they arrive, and totals don't carry over. A daily job must run before each cutoff.
- **Every entrant at 1 entry** when the app rewards actions: set mode sends each entrant's total, so `entries` has to be sent every time. Or the app meant increment mode.
- **Fewer entrants than expected:** the eligibility filter, or an `eventId` reused across different events (`409 event_conflict`, nothing in that request stored). Look at the sender's logs for `409`s.
- **A sandbox draw with winners:** the integration works end to end. `npx prizerail verify <slug> <drawing id>` checks any draw again from its public proof.

## Without the command

If `npx` can't run, the same checks by hand, all with `Authorization: Bearer $PRIZERAIL_API_KEY` against the site the key belongs to:

1. `GET /api/v1/campaigns/{slug}` for `status` and `nextDrawing` (its `cutoffAt` is when entries close).
2. `GET /api/v1/campaigns/{slug}/entries?limit=1000` for the open drawing's `entrantCount`, `totalEntries` and entrants. Take `drawing.id` from the first page and pass it as `drawing={id}` with `after` on every later page until `next` is `null`, so a cutoff mid-way can't mix two drawings.
3. In the sandbox, `POST /api/v1/campaigns/{slug}/drawings/{id}/run`, then `GET /api/v1/campaigns/{slug}/drawings/{id}` until `status` is `settled` or `paid`.
4. `npx prizerail verify <slug> <drawing id>`, or download `https://www.prizerail.com/verify/verify-draw.mjs` and run it on the drawing's `proof.json`.

Never compute the draw's hashes yourself: keccak256 can't be done reliably by reasoning. The verify script does it.
