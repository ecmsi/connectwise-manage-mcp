/**
 * Verifies the service-to-service header a signing gateway or proxy puts on
 * each request: `X-Gateway-S2S: t=<unix seconds>,v1=<hex hmac-sha256>`, where
 * `v1` is HMAC-SHA256 of the ASCII string `t=<unix seconds>` keyed with the
 * shared secret. A proof is good for 300 seconds either side of the server
 * clock, so a captured header cannot be replayed later.
 *
 * `secret` is opaque: a gateway may derive a per-backend subkey from a master
 * secret and give this server only its own value, so a sibling backend
 * holding a different subkey cannot forge a header that verifies here. This
 * function does not need to know that; it checks whatever secret it is handed.
 *
 * Empty secret => always returns false. HTTP startup refuses to listen when no
 * authentication mechanism is configured (see http-auth.ts); the only
 * exception is MCP_ALLOW_INSECURE_DEV=1, where the caller skips this check,
 * logs a warning and binds 127.0.0.1. Do not treat an empty secret as a
 * production "enforcement disabled" switch.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Request header carrying the S2S proof. Node lowercases incoming header names. */
export const S2S_HEADER = "x-gateway-s2s";

const HEADER_VALUE_RE = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/;

export function verifyS2sHeader(
  headerValue: string | undefined,
  secret: string,
  maxSkewSeconds = 300
): boolean {
  if (!secret || !headerValue) return false;
  const match = HEADER_VALUE_RE.exec(headerValue);
  if (!match) return false;
  const t = Number(match[1]);
  if (!Number.isSafeInteger(t)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > maxSkewSeconds) return false;
  const expected = createHmac("sha256", secret).update(`t=${t}`).digest();
  const provided = Buffer.from(match[2], "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
