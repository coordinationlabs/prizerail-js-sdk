import type { CampaignClient } from "./client.js";
import { PrizerailError } from "./errors.js";
import type { Campaign, Drawing, SentEntrant } from "./types.js";
import type { Check } from "./verify.js";

export type { Check };

/**
 * What `prizerail check` reports: one line per check, in the order a
 * partner's integration is set up. `ok: null` is a note the checks can't
 * settle, such as every entrant having one entry.
 */
export type CheckResult = {
  /** True when no check failed. */
  ok: boolean;
  checks: Check[];
  campaign?: Campaign;
  /** The draw run with `--draw`, once settled. */
  drawing?: Drawing;
};

export type CheckOptions = {
  /** Sandbox only: draw the open drawing now and verify it. */
  draw?: boolean;
  /** Entrants to read from the open drawing before judging their ids. */
  sample?: number;
  /** For tests: the clock. */
  now?: () => number;
  /** For tests: how long to wait between polls of a draw still running. */
  pollMs?: number;
};

/** The most entrants read for the id and entries checks. */
const SAMPLE = 5_000;
/** How long `--draw` waits for a drawing whose random value is on its way. */
const DRAW_WAIT_MS = 3 * 60_000;

const pass = (label: string, detail?: string): Check => ({
  ok: true,
  label,
  detail,
});
const fail = (label: string, detail?: string): Check => ({
  ok: false,
  label,
  detail,
});
const note = (label: string, detail?: string): Check => ({
  ok: null,
  label,
  detail,
});

const n = (v: number) => v.toLocaleString("en-US");

/** "in 2h 5m", "in 40s", or "passed". */
export function untilText(at: string, now: number): string {
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms <= 0) return "passed";
  const s = Math.round(ms / 1000);
  if (s < 90) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return `in ${h}h ${m - h * 60}m`;
}

export type IdShape =
  | "opaque"
  | "email"
  | "username"
  | "number"
  | "uuid"
  | "short";

/**
 * What an entrant id looks like. Ids are published, hashed, with every
 * draw, so one that reads as an email, a username or a small number can be
 * tied back to a person, or guessed, by anyone who tries.
 */
export function idShape(id: string): IdShape {
  if (id.includes("@")) return "email";
  // A space or a letter beyond ASCII is a person's name, never a generated id.
  if (/\s/.test(id) || /[^\x00-\x7f]/.test(id)) return "username";
  if (/^\d+$/.test(id)) return "number";
  // A word and then only digits is a labelled counter: customer00000001,
  // user_1042. The label hides nothing, and the number is guessable.
  if (/^[a-z]+[_.-]?\d{3,}$/i.test(id) && !/^[0-9a-f]+$/i.test(id))
    return "number";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return "uuid";
  // Hex of 16 or more characters is a hash, or a 64-bit or wider random id.
  if (/^(0x)?[0-9a-f]{16,}$/i.test(id)) return "opaque";
  // Mixed case this long is a generated id (nanoid, a Firebase UID, a
  // prefixed random id like cus_Nx6v2dG9mLk8Qa), never a handle someone typed.
  if (
    id.length >= 16 &&
    /[a-z]/.test(id) &&
    /[A-Z]/.test(id) &&
    (/\d/.test(id) || !/[_.-]/.test(id))
  )
    return "opaque";
  // Base64 or similar of 21 characters or more, a nanoid's length, with
  // both letters and digits.
  if (/^[A-Za-z0-9_\-+/=]{21,}$/.test(id) && /\d/.test(id) && /[a-z]/i.test(id))
    return "opaque";
  if (id.length < 16) {
    // Hex this short is a truncated hash: too short, not a name.
    if (/^[0-9a-f]+$/i.test(id)) return "short";
    return /^[a-z][a-z0-9_.-]*$/i.test(id) ? "username" : "short";
  }
  // A handle reads as words: letters with separators, and at most a short
  // run of digits on the end, as in ada_lovelace_1988. One long word with
  // no separators (a cuid2) or digits inside it (usr_k3j9d8s7f6g5h4j3) is a
  // generated id.
  const words = /^[a-z]+(?:[_.-][a-z]+)*(?:[_.-]?\d{1,4})?$/i.test(id);
  const oneLongWord = /^[a-z]{20,}$/i.test(id);
  return words && !oneLongWord ? "username" : "opaque";
}

/**
 * True when the ids' numbers run like a counter: 1041, 1042, 1043, or
 * customer00000001, customer00000002.
 */
export function looksSequential(ids: string[]): boolean {
  const nums = ids
    .map(id => id.match(/(\d{1,15})$/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  if (nums.length < 3) return false;
  let close = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] - nums[i - 1] <= 10) close++;
  }
  return close >= (nums.length - 1) * 0.8;
}

/** The id checks over a sample of the open drawing's entrants. */
export function checkEntrantIds(entrants: SentEntrant[]): Check[] {
  if (entrants.length === 0) return [];
  const shapes = new Map<IdShape, string[]>();
  for (const e of entrants) {
    const shape = idShape(e.entrantId);
    shapes.set(shape, [...(shapes.get(shape) ?? []), e.entrantId]);
  }
  const example = (shape: IdShape) => {
    const ids = shapes.get(shape) ?? [];
    return `${n(ids.length)} of ${n(entrants.length)}, like "${ids[0]}"`;
  };
  const checks: Check[] = [];
  if (shapes.has("email")) {
    checks.push(
      fail(
        "Entrant ids are not emails",
        `${example("email")}. Ids are published, hashed, with every draw. Send an HMAC of your user id instead.`
      )
    );
  }
  if (shapes.has("username")) {
    checks.push(
      fail(
        "Entrant ids are not usernames",
        `${example("username")}. A name can be tied back to a person. Send an HMAC of your user id instead.`
      )
    );
  }
  const numbers = shapes.get("number") ?? [];
  if (numbers.length > 0) {
    checks.push(
      fail(
        "Entrant ids are not your user ids",
        `${example("number")}${looksSequential(numbers) ? ", running in sequence" : ""}. A plain or sequential id can be guessed. Send an HMAC of it with a secret key instead.`
      )
    );
  }
  if (shapes.has("short")) {
    checks.push(
      fail(
        "Entrant ids are long enough to be unguessable",
        `${example("short")}. Use an HMAC-SHA256 of your user id (64 hex characters) or a random id you store.`
      )
    );
  }
  if (shapes.has("uuid")) {
    checks.push(
      note(
        "Entrant ids are UUIDs",
        `${example("uuid")}. Fine if it's a random id made for Prizerail and stored. Not fine if it's your users table's id, which other systems know.`
      )
    );
  }
  if (checks.length === 0) {
    checks.push(
      pass(
        "Entrant ids look opaque",
        `${n(entrants.length)} read, like "${entrants[0].entrantId}"`
      )
    );
  }
  return checks;
}

/** The entries checks over the same sample. */
export function checkEntries(entrants: SentEntrant[]): Check[] {
  if (entrants.length === 0) return [];
  const counts = entrants.map(e => e.entries);
  const bad = counts.filter(c => !Number.isInteger(c) || c < 1);
  if (bad.length > 0) {
    return [
      fail(
        "Entries are whole numbers from 1",
        `${n(bad.length)} entrants have ${bad[0]}`
      ),
    ];
  }
  const max = Math.max(...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  if (entrants.length >= 2 && max === 1) {
    return [
      note(
        "Every entrant has 1 entry",
        "Right if you don't use entries. If you meant to send totals, send `entries` every time: an entrant sent without it is set back to 1."
      ),
    ];
  }
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const checks: Check[] = [
    pass(
      "Entries look deliberate",
      `${n(total)} entries over ${n(entrants.length)} entrants, median ${n(median)}, highest ${n(max)}`
    ),
  ];
  if (entrants.length >= 10 && max > median * 100) {
    const top = entrants.find(e => e.entries === max);
    checks.push(
      note(
        "One entrant has far more entries than the rest",
        `"${top?.entrantId}" has ${n(max)} against a median of ${n(median)}. Check it isn't a running total added on every send.`
      )
    );
  }
  return checks;
}

/** Why the campaign couldn't be read, as a failed check, or null to rethrow. */
export function keyFailure(
  error: unknown,
  apiKey: string | undefined,
  siteUrl: string
): Check | null {
  if (!(error instanceof PrizerailError)) return null;
  if (error.status === 401) {
    const sandboxKey = apiKey?.trim().startsWith("pr_sandbox_");
    const sandboxSite = siteUrl === "https://sandbox.prizerail.com";
    const prizerailSite =
      sandboxSite || siteUrl === "https://www.prizerail.com";
    const mismatch = !prizerailSite
      ? "Unknown or revoked key for this site."
      : sandboxKey && !sandboxSite
        ? "This is a pr_sandbox_ key, and the site isn't the sandbox. Sandbox keys only work at https://sandbox.prizerail.com."
        : !sandboxKey && sandboxSite
          ? "This isn't a pr_sandbox_ key, and the site is the sandbox. Production keys only work at https://www.prizerail.com."
          : "Unknown or revoked key. An owner makes keys in the partner portal under Team → API keys.";
    return fail(`The key works at ${siteUrl}`, mismatch);
  }
  if (error.status === 404) {
    return fail(
      "The campaign is under this key's account",
      `${error.detail ?? "Not found."} Check the slug, the last part of the campaign's page link, and that the key belongs to the same account and environment.`
    );
  }
  if (error.code === "no_api_key") {
    return fail("The key is set", "Set PRIZERAIL_API_KEY to your pr_… key.");
  }
  return null;
}

async function readSample(
  campaign: CampaignClient,
  drawingId: string,
  sample: number
): Promise<SentEntrant[]> {
  const out: SentEntrant[] = [];
  for await (const entrant of campaign.entries.all({ drawing: drawingId })) {
    out.push(entrant);
    if (out.length >= sample) break;
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Checks a partner's integration end to end with their key: the key, the
 * campaign, its open drawing, the entrant ids and entries it has, and with
 * `draw`, in the sandbox, a whole draw and its proof.
 */
export async function checkCampaign(
  campaign: CampaignClient,
  options: CheckOptions = {}
): Promise<CheckResult> {
  const now = options.now ?? Date.now;
  const checks: Check[] = [];
  const done = (extra: Partial<CheckResult> = {}): CheckResult => ({
    ok: !checks.some(c => c.ok === false),
    checks,
    ...extra,
  });
  const { siteUrl, http } = campaign.prizerail;

  let info: Campaign;
  try {
    info = await campaign.get();
  } catch (error) {
    const failed = keyFailure(error, http.options.apiKey, siteUrl);
    if (!failed) throw error;
    checks.push(failed);
    return done();
  }
  checks.push(pass(`The key works at ${siteUrl}`));
  try {
    return await checkRest(campaign, info, checks, options, now, done);
  } catch (error) {
    // A bug is a crash, not a failed check: the CLI exits 2 with it.
    if (!(error instanceof PrizerailError)) throw error;
    // An API or network failure part-way keeps the checks that passed.
    checks.push(
      fail(
        "The check finished",
        error instanceof Error ? error.message : String(error)
      )
    );
    return done({ campaign: info });
  }
}

async function checkRest(
  campaign: CampaignClient,
  info: Campaign,
  checks: Check[],
  options: CheckOptions,
  now: () => number,
  done: (extra?: Partial<CheckResult>) => CheckResult
): Promise<CheckResult> {
  checks.push(
    info.status === "active"
      ? pass(`Campaign "${info.name}" is active`)
      : fail(
          `Campaign "${info.name}" is active`,
          info.status === "draft"
            ? "It's a draft, so it doesn't draw and takes no entries. An owner sets it active in the partner portal."
            : info.status === "paused"
              ? "It's paused, so no drawing is taking entries."
              : "It has ended and takes no more entries."
        )
  );

  const open = info.nextDrawing;
  if (!open) {
    checks.push(
      fail(
        "A drawing is taking entries",
        "None is open. Entries sent now get 409 no_open_drawing. A paused campaign has none, and a new one's first drawing appears about two days before it draws."
      )
    );
    return done({ campaign: info });
  }
  checks.push(
    pass(
      "A drawing is taking entries",
      `${open.id}, cutoff ${untilText(open.cutoffAt, now())} (${open.cutoffAt}), draws ${open.drawAt}`
    )
  );

  const sample = options.sample ?? SAMPLE;
  const page = await campaign.entries.list({ drawing: open.id, limit: 1 });
  if (page.entrantCount === 0) {
    checks.push(
      note(
        "The open drawing has no entries yet",
        "Run your sender, then check again. Entries go to the drawing whose cutoff is next, and totals don't carry over from the last one."
      )
    );
  } else {
    const entrants = await readSample(campaign, open.id, sample);
    checks.push(
      pass(
        "The open drawing has entries",
        `${n(page.entrantCount)} entrants, ${n(page.totalEntries)} entries`
      )
    );
    checks.push(...checkEntrantIds(entrants));
    checks.push(...checkEntries(entrants));
  }

  if (!options.draw) return done({ campaign: info });

  if (page.entrantCount === 0) {
    checks.push(
      fail("A draw runs now", "Nothing to draw from: send some entries first.")
    );
    return done({ campaign: info });
  }
  let drawing: Drawing;
  try {
    drawing = await campaign.drawings.run(open.id);
  } catch (error) {
    if (error instanceof PrizerailError && error.code === "sandbox_only") {
      checks.push(
        fail(
          "A draw runs now",
          "Draw now works only in the sandbox (a pr_sandbox_ key at https://sandbox.prizerail.com). Production draws run on schedule."
        )
      );
      return done({ campaign: info });
    }
    const unanswered =
      error instanceof PrizerailError &&
      (error.status === 0 ||
        error.status >= 500 ||
        error.code === "invalid_response");
    if (!unanswered) {
      if (error instanceof PrizerailError) {
        checks.push(fail("A draw runs now", error.message));
        return done({ campaign: info });
      }
      throw error;
    }
    // No usable answer, but the route may well have run: the drawing's
    // status says. Draw now moves the cutoff before anything else, so a
    // drawing still open didn't run.
    drawing = await campaign.drawings.get(open.id);
    if (drawing.status === "open") {
      checks.push(
        fail(
          "A draw runs now",
          `The draw request got no answer (${error.message}) and drawing ${open.id} is still open, so it didn't run. Run the check again.`
        )
      );
      return done({ campaign: info, drawing });
    }
  }
  const running = (d: Drawing) =>
    d.status === "locked" || d.status === "entropy_requested";
  const deadline = now() + DRAW_WAIT_MS;
  let timedOut = false;
  while (running(drawing) && drawing.needsAttention === null) {
    if (now() >= deadline) {
      timedOut = true;
      break;
    }
    await sleep(options.pollMs ?? 5_000);
    drawing = await campaign.drawings.get(drawing.id);
  }
  const final = drawing.status === "settled" || drawing.status === "paid";
  if (drawing.status === "skipped") {
    checks.push(
      fail(
        "A draw runs now",
        `Drawing ${drawing.id} closed without a draw: it had no entries at the cutoff.`
      )
    );
    return done({ campaign: info, drawing });
  }
  if (!final && drawing.needsAttention !== null) {
    checks.push(
      fail(
        "A draw runs now",
        `Drawing ${drawing.id} needs attention: ${drawing.needsAttention}`
      )
    );
    return done({ campaign: info, drawing });
  }
  if (!final) {
    checks.push(
      fail(
        "A draw runs now",
        timedOut
          ? `Drawing ${drawing.id} is still ${drawing.status} after ${DRAW_WAIT_MS / 60_000} minutes. Read it again with GET /drawings/${drawing.id}.`
          : `Drawing ${drawing.id} is ${drawing.status}, so it isn't drawing. Read it with GET /drawings/${drawing.id}.`
      )
    );
    return done({ campaign: info, drawing });
  }
  checks.push(
    pass(
      "A draw runs now",
      `Drawing ${drawing.id} is ${drawing.status} with ${n(drawing.winners.length)} winner${drawing.winners.length === 1 ? "" : "s"}`
    )
  );
  if (drawing.needsAttention !== null) {
    // Settled, so the winners are final and the proof stands. The flag is
    // about what comes after, such as a sandbox campaign with no payout
    // wallet, which is the normal sandbox state.
    checks.push(
      note("The drawing is flagged for staff", drawing.needsAttention)
    );
  }
  const result = await campaign.drawings.verify(drawing.id);
  const failed = result.checks.filter(c => c.ok === false);
  checks.push(
    failed.length === 0
      ? pass(
          "Its proof verifies",
          `${campaign.drawings.proofUrl(drawing.id)}. Run \`npx prizerail verify ${campaign.slug} ${drawing.id}\` for every check.`
        )
      : fail(
          "Its proof verifies",
          failed
            .map(c => `${c.label}${c.detail ? `: ${c.detail}` : ""}`)
            .join("\n    ")
        )
  );
  return done({ campaign: info, drawing });
}
