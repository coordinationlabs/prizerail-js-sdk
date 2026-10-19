/**
 * An entrant id for a user: HMAC-SHA256 of their id with your secret key,
 * as hex. The same user and key always give the same id, and without the
 * key nobody can work back to the user. Keep the key fixed for the life of
 * the campaign. Matches Node's createHmac("sha256", key).update(id).digest("hex").
 */
export async function hashEntrant(
  userId: string | number,
  key: string
): Promise<string> {
  if (!key) throw new Error("hashEntrant needs your secret key.");
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    enc.encode(String(userId))
  );
  return Array.from(new Uint8Array(mac), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
