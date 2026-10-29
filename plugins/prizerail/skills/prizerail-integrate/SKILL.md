---
name: prizerail-integrate
description: Add Prizerail to an app so its users enter the partner's prize draws. Reads the repo to find the stack and where users earn entries, picks set or increment mode, writes the sender (the prizerail SDK in TypeScript and JavaScript, plain HTTP elsewhere) with HMAC entrant ids, an eligibility filter, env wiring for sandbox and production keys, and tests. Use when someone asks to integrate Prizerail, send entries to a campaign, add a sweepstakes or prize draw with Prizerail, or wire up the prizerail package.
---

# Integrate Prizerail

Prizerail runs prize draws for partner apps. The partner's backend sends each eligible user as an **entrant** with their number of **entries** (chances: 5 entries is five times as likely to be picked as 1), and at each **cutoff** Prizerail locks the list, draws the winners from it with a public random value, and sends the prizes to the partner's wallet to pay out. The partner never picks winners and never handles the randomness. This skill builds the sending side.

Read the docs when a detail isn't here: [Send entries](https://docs.prizerail.com/api/send-entries), [Concepts](https://docs.prizerail.com/getting-started/concepts), [Winners and eligibility](https://docs.prizerail.com/campaigns/winners), or everything at [llms-full.txt](https://docs.prizerail.com/llms-full.txt). Whole runnable projects are in [prizerail-examples](https://github.com/coordinationlabs/prizerail-examples): a Next.js app that adds entries as users earn them, a Node worker that sends the day's entries, and the same send in Python.

## 1. Read the repo first

Before writing anything, find out:

- **The stack.** TypeScript or JavaScript (Node 20 or later) uses the `prizerail` package. Anything else uses plain HTTP against the API, following the Python pattern below.
- **Where users earn entries.** Look for the actions the partner rewards: orders, referrals, deposits, daily check-ins, completed tasks. Find the code path that runs when each one happens, and the table or model that records it.
- **The user id and where users live.** The entrant id is derived from the partner's stable internal user id. Eligibility needs each user's country, US state and age, or a flag the app already keeps.
- **Secrets and env.** How the app reads secrets, and where `PRIZERAIL_API_KEY`, `PRIZERAIL_CAMPAIGN` and `ENTRANT_ID_KEY` go.
- **Scheduled jobs.** A cron, queue or worker the daily send can live in, if set mode fits.

Then ask the developer anything the repo doesn't settle, in one message: how entries are earned, whether a user's entries change through the day, and which campaign slug and environment to wire.

## 2. Pick the mode

| Mode | Use it when | How it works |
|---|---|---|
| **set** (default) | The app knows each user's running total, and sends everyone once before each cutoff, for example in a daily job | `POST /entries` with each entrant's total. Sending an entrant again before the cutoff **sets** their entries to what was sent. |
| **increment** | Entries are earned by events as they happen, and the app would rather add them than keep a total | `POST /entries` with `"mode": "increment"`, one event per entrant with an `eventId`. Prizerail adds the event's entries to what the entrant has, and ignores an `eventId` it has seen before. |

Rules that hold in both modes, and must be in the code and its comments:

- **Entries land in the drawing whose cutoff is next** when they arrive. After a cutoff, they go to the following drawing. Totals never carry over between draws.
- **The same person must have the same entrant id for the whole campaign.** The guarantee draw counts each person once by their id across a period. Never rotate the key mid-campaign, and never make an id per draw, per session or per device.
- **Only eligible users are sent.** Who can enter is below.
- **Nothing personal is sent.** No emails, usernames, names or raw user ids as entrant ids. `displayName` and `avatarUrl` are optional and public if that entrant wins, so send them only if the partner wants them shown.

### Set mode gotchas

- A retry before the cutoff is safe: it sets the same total again. A retry **after** the cutoff goes to the next draw, and the request whose answer was lost may already be stored, so a late retry can enter people in two draws.
- The SDK handles this: `entries.send` pins every batch to one drawing and throws `PrizerailCutoffError` rather than send or retry within its cutoff margin (the request timeout, 30 seconds). Plain HTTP code must do the same: read the open drawing and its `cutoffAt` first, send no batch and start no retry within 30 seconds of it, and stop if a response names a different drawing.
- Send `entries` every time if it's ever used. An entrant sent without it is set back to 1.
- Up to 1,000 entrants per request, and a drawing takes up to 100,000 entrants.

### Increment mode gotchas

- **The `eventId` is the id of the thing that happened**: an order id, a referral id, a transaction hash. With none to hand, make a UUID when the event happens and store it with the event. **Never make it per attempt.** A timestamp, or a random id per retry, adds the entries again on every retry.
- A repeated `eventId` is ignored, even across a cutoff. That makes every retry safe at any time, which is why increment mode needs no cutoff margin.
- The same `eventId` with a different entrant or number of entries is a `409 event_conflict`, and nothing in that request is stored.
- Each event goes to the drawing taking entries when it arrives, so events either side of a cutoff split between two draws. That is correct.

## 3. Entrant ids

Every locked list is published, hashed, so anyone can check a draw. An entrant id must not be guessable or linkable back to a person. Use an HMAC-SHA256 of the partner's user id with a secret key:

```ts
// TypeScript and JavaScript: the SDK's helper, which also runs on edge runtimes.
import { hashEntrant } from "prizerail"
const entrantId = await hashEntrant(user.id, process.env.ENTRANT_ID_KEY!)
```

```python
# Python, with the standard library.
import hashlib, hmac, os
key = os.environ["ENTRANT_ID_KEY"].encode()
entrant_id = hmac.new(key, str(user.id).encode(), hashlib.sha256).hexdigest()
```

- Make the key once (`openssl rand -hex 32`) and keep it in the server's secrets manager. Never put it in a client app or a web page.
- **Keep the same key for the life of the campaign.** A new key gives every user a new id, which breaks the guarantee draw's "each person once".
- Never use a plain hash: a plain SHA-256 of a sequential or public user id can be reversed by hashing guesses. And never use emails or usernames, hashed or not.

## 4. Keys and environments

- `PRIZERAIL_API_KEY`: an owner makes it in the partner portal under **Team → API keys**. It's shown once. One key covers every campaign of the account.
- `PRIZERAIL_CAMPAIGN`: the campaign's slug, the last part of its public page `https://www.prizerail.com/campaigns/{slug}`.
- **Sandbox and production are separate sites with separate keys.** `pr_sandbox_` keys work only at `https://sandbox.prizerail.com`, `pr_prod_` keys only at `https://www.prizerail.com`. A sandbox key sent to production gets a `401`. Wire a `pr_sandbox_` key in development and a `pr_prod_` key in production.
- The SDK picks the site from the key, so the code is the same in both environments. Plain HTTP code must pick the base URL from the key's prefix: `pr_sandbox_` → `https://sandbox.prizerail.com/api/v1`, otherwise `https://www.prizerail.com/api/v1`.
- Sandbox draws run on a test network and pay nothing. The developer makes a sandbox account at [sandbox.prizerail.com/signup](https://sandbox.prizerail.com/signup).

## 5. Eligibility filter

Add one function, `isEligible(user)`, that every send goes through, and keep its rules in one place. The standard Prizerail rules:

- **US:** legal residents 18 or older, or 19 in Alabama and Nebraska and 21 in Mississippi. Residents of **Florida, New York and Rhode Island** can't enter.
- **Outside the US:** the same age standard. Residents of countries under US sanctions, as listed by [OFAC](https://ofac.treasury.gov/sanctions-programs-and-country-information), can't enter.

A campaign's official rules can narrow these. Read them from the partner, and point the developer at [Who can enter](https://docs.prizerail.com/campaigns/winners#who-can-enter). If the app doesn't know a user's age or location, say so rather than guess, and send nobody whose eligibility is unknown.

## 6. Write the sender

### TypeScript and JavaScript: the `prizerail` package

`npm install prizerail`. Batching, retries, the cutoff rule and the site choice are built in.

Set mode, from a job that runs before each cutoff:

```ts
import {
  Prizerail,
  PrizerailCutoffError,
  PrizerailDrawingChangedError,
  hashEntrant,
  type Entrant,
} from "prizerail"

const campaign = new Prizerail({ apiKey: process.env.PRIZERAIL_API_KEY }).campaign(
  process.env.PRIZERAIL_CAMPAIGN!
)

export async function sendTodaysEntries() {
  const users = await eligibleUsersWithEntries() // your query, filtered by isEligible
  const entrants: Entrant[] = await Promise.all(
    users.map(async u => ({
      entrantId: await hashEntrant(u.id, process.env.ENTRANT_ID_KEY!),
      entries: u.entries, // their total for this draw, a whole number from 1
    }))
  )
  try {
    const res = await campaign.entries.send(entrants)
    return { drawingId: res.drawing.id, sent: res.sent, entrantCount: res.entrantCount }
  } catch (error) {
    if (
      error instanceof PrizerailCutoffError ||
      error instanceof PrizerailDrawingChangedError
    ) {
      // Both carry progress: error.progress.sent entrants were confirmed in
      // error.progress.drawing. Check the rest with entries.list().
      throw new Error(`${error.progress.sent} sent to ${error.progress.drawing.id}: ${error.detail}`)
    }
    throw error
  }
}
```

Increment mode, from the code path where the event happens:

```ts
// eventId is stored with the event, so a retry or a redelivered queue message sends the same one.
export async function addEntries(userId: string, entries: number, eventId: string) {
  const entrantId = await hashEntrant(userId, process.env.ENTRANT_ID_KEY!)
  return campaign.entries.increment([{ entrantId, entries, eventId }])
}
```

### Any other language: plain HTTP

Follow the TypeScript `fetch` and Python `requests` tabs on [Send entries](https://docs.prizerail.com/api/send-entries#code), which are complete and tested in CI. The shape:

- `POST {base}/campaigns/{slug}/entries` with `Authorization: Bearer {key}` and a JSON body `{"entrants": [...]}`, or `{"mode": "increment", "entrants": [...]}`.
- A 30-second timeout on every request. Retry a `429`, a `5xx`, a timeout or a network error with a growing, jittered wait, honoring `Retry-After`. Don't retry a `4xx` other than `429`.
- Set mode: read `GET {base}/campaigns/{slug}/entries?limit=1` first for the open drawing's `id` and `cutoffAt`, send in batches of 1,000, send no batch and start no retry within 30 seconds of the cutoff, and stop if a response's `drawing.id` differs from the one read first.
- Increment mode: one event per entrant with `eventId`, retried at any time.

## 7. Tests

Write them in the project's own test framework. Each one guards a rule above:

1. **Same user, same entrant id.** Hashing the same user id twice gives the same entrant id, and two different users give different ids.
2. **The id isn't personal.** The entrant id is 64 hex characters and contains neither the user id, nor their email, nor their username.
3. **Nothing personal is sent.** Capture the request body (mock `fetch` or the SDK's `fetch` option) and assert no email, username or raw user id appears in it.
4. **Retries carry the same `eventId`** (increment mode): calling the sender twice for one event sends the same `eventId` both times.
5. **Nothing is sent near the cutoff** (set mode): with the open drawing's `cutoffAt` 10 seconds away, the sender stops without posting a batch. With the SDK, that's `PrizerailCutoffError`.
6. **Ineligible users are filtered out:** a user from Florida, or under 18, never reaches the sender.

## 8. Try it in the sandbox

With a `pr_sandbox_` key and a sandbox campaign, send a few entrants and then run `npx prizerail check <slug> --draw` (the `prizerail-check` skill). It checks the key, the campaign and what was sent, then **draws now**: the drawing locks, settles and pays within seconds, and its proof is verified, so the whole integration is seen to pass. Draw now consumes the drawing's entries and opens a fresh, empty one, so send entries again before any second draw. To draw by hand instead, use `campaign.drawings.run(drawingId)` in the SDK, `POST /campaigns/{slug}/drawings/{id}/run`, or the **Draw now** button on the drawing in the sandbox portal, then `campaign.drawings.latest()` shows the winners and `npx prizerail verify <slug> <drawing id>` checks the proof.

## Checklist before handing back

- [ ] Mode chosen and explained in a comment at the sender
- [ ] Entrant ids are HMAC-SHA256 with `ENTRANT_ID_KEY`, never a plain hash or anything personal
- [ ] `PRIZERAIL_API_KEY` and `PRIZERAIL_CAMPAIGN` wired, sandbox key in development, production key in production
- [ ] Eligibility filter in front of every send
- [ ] Set mode: cutoff margin and drawing pinning. Increment mode: `eventId` fixed when the event happens
- [ ] `entries` sent every time it's used, a whole number from 1 to 4,294,967,295
- [ ] Tests from section 7
