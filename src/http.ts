import { PrizerailError } from "./errors.js";

export type HttpOptions = {
  apiKey?: string;
  baseUrl: string;
  fetch: typeof fetch;
  /** Per attempt. */
  timeoutMs: number;
  /** Retries after the first attempt, for 429s, 5xx and network errors. */
  maxRetries: number;
  userAgent: string;
};

export type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * No retry is started that would wait until this time, in ms since the
   * epoch. `onDeadline` builds the error thrown instead.
   */
  deadline?: number;
  onDeadline?: (error: unknown) => Error;
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
/** A server that asks for a longer wait than this gets the error instead. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** Retry-After as ms from now: delta seconds or an HTTP date. */
export function parseRetryAfter(
  value: string | null,
  now = Date.now()
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(at - now, 0);
}

/** Full jitter, with Retry-After as the floor when the server sent one. */
export function retryDelay(attempt: number, retryAfterMs: number | null) {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  const jitter = Math.random() * ceiling;
  return retryAfterMs === null ? jitter : Math.max(retryAfterMs, jitter);
}

const retryable = (status: number) =>
  status === 429 || (status >= 500 && status !== 501);

async function errorFrom(res: Response): Promise<PrizerailError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; detail?: unknown };
    if (typeof body.error === "string") {
      return new PrizerailError(
        res.status,
        body.error,
        typeof body.detail === "string" ? body.detail : undefined
      );
    }
  } catch {
    // Not JSON, from a proxy or CDN. Keep the start of it.
  }
  return new PrizerailError(
    res.status,
    `http_${res.status}`,
    text.slice(0, 200) || res.statusText || undefined
  );
}

/**
 * A 2xx body as JSON. A body that isn't JSON is a broken response, not a
 * network error, so it isn't retried: a POST may already be stored.
 */
function parseBody<T>(res: Response, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PrizerailError(
      res.status,
      "invalid_response",
      `The API answered ${res.status} with a body that isn't JSON: ${text.slice(0, 200)}`
    );
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Http {
  constructor(readonly options: HttpOptions) {}

  url(path: string, query?: RequestOptions["query"]) {
    const url = new URL(path.replace(/^\//, ""), `${this.options.baseUrl}/`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.href;
  }

  /** JSON from the partner API, with retries. Throws PrizerailError. */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    { query, body, deadline, onDeadline }: RequestOptions = {}
  ): Promise<T> {
    const { apiKey, fetch, timeoutMs, maxRetries, userAgent } = this.options;
    if (!apiKey) {
      throw new PrizerailError(
        0,
        "no_api_key",
        "Pass apiKey to new Prizerail() to call the partner API."
      );
    }
    const url = this.url(path, query);
    for (let attempt = 0; ; attempt++) {
      let failure: PrizerailError | undefined;
      let retryAfterMs: number | null = null;
      let res: Response | null = null;
      let text = "";
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "user-agent": userAgent,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) text = await res.text();
      } catch (error) {
        // No response, or the body was cut off: a timeout or network error.
        res = null;
        failure = new PrizerailError(
          0,
          "network_error",
          error instanceof Error ? error.message : String(error)
        );
      }
      if (res?.ok) return parseBody<T>(res, text);
      if (res) {
        const error = await errorFrom(res);
        if (!retryable(res.status)) throw error;
        failure = error;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      }
      // Set on every path that gets here.
      const last = failure as PrizerailError;
      if (attempt >= maxRetries) throw last;
      if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS)
        throw last;
      const wait = retryDelay(attempt, retryAfterMs);
      if (deadline !== undefined && Date.now() + wait >= deadline) {
        throw onDeadline ? onDeadline(last) : last;
      }
      await sleep(wait);
      // Timers can fire late, after a sleep or a busy event loop.
      if (deadline !== undefined && Date.now() >= deadline) {
        throw onDeadline ? onDeadline(last) : last;
      }
    }
  }

  /** Public JSON, like a draw's proof, with no key and no retries. */
  async getPublic<T>(url: string): Promise<T> {
    const res = await this.options.fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": this.options.userAgent,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!res.ok) throw await errorFrom(res);
    return parseBody<T>(res, await res.text());
  }
}
