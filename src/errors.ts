import type { DrawingRef } from "./types.js";

/** An error response from the API, or a request that never got one. */
export class PrizerailError extends Error {
  /** The HTTP status. 0 when the request failed before a response. */
  readonly status: number;
  /** The API's error code, like `not_found` or `no_open_drawing`. */
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PrizerailError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** What a send had stored before it stopped. */
export type SendProgress = {
  drawing: DrawingRef;
  /** Entrants in the batches Prizerail confirmed. */
  sent: number;
  added: number;
  updated: number;
  unchanged: number;
};

/**
 * A send stopped so that no entry lands in the drawing after the one it
 * targeted. Entries past `progress.sent` were not confirmed: check with
 * `entries.list({ drawing })` before sending them to the next drawing.
 */
export class PrizerailCutoffError extends PrizerailError {
  readonly progress: SendProgress;
  readonly cause?: unknown;

  constructor(detail: string, progress: SendProgress, cause?: unknown) {
    super(0, "cutoff_reached", detail);
    this.name = "PrizerailCutoffError";
    this.progress = progress;
    this.cause = cause;
  }
}

/** A batch went to a different drawing from the rest of the send. */
export class PrizerailDrawingChangedError extends PrizerailError {
  readonly progress: SendProgress;
  /** Where the last batch went. */
  readonly landedIn: DrawingRef;

  constructor(progress: SendProgress, landedIn: DrawingRef) {
    super(
      0,
      "drawing_changed",
      `A batch went to drawing ${landedIn.id}, not ${progress.drawing.id}. Its cutoff passed mid-send.`
    );
    this.name = "PrizerailDrawingChangedError";
    this.progress = progress;
    this.landedIn = landedIn;
  }
}
