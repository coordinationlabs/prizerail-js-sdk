/**
 * Types for verify-draw.mjs, the public verify script, which this package
 * ships unchanged. prizerail.com serves the same file at /verify/verify-draw.mjs,
 * and its tests check that copy matches the one in the published package.
 */
export type Check = { ok: boolean | null; label: string; detail?: string };
/** [index, keccak256(entrantId), weight] */
export type EntrantRow = [number, string, number];
export function keccak256(bytes: Uint8Array): string;
export function winnerHash(winner: string): string;
export function entrantsRoot(list: [string, number][]): string;
export function verifyProof(proof: unknown, entrants?: EntrantRow[]): Check[];
export function readEntrants(
  source: string,
  options?: { fetch?: typeof fetch; timeoutMs?: number }
): Promise<EntrantRow[]>;
