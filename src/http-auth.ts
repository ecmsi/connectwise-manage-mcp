/**
 * HTTP transport authentication and abuse controls.
 *
 * Pure functions only: nothing here reads process.env, writes a log or exits
 * the process. `index.ts` feeds in the environment and acts on the result, so
 * every rule can be unit tested without starting a listener.
 *
 * Three caller-authentication mechanisms exist for `/mcp`:
 *
 * - `CONDUIT_S2S_SECRET`: an HMAC proof on `X-Gateway-S2S`, for the WYRE
 *   gateway deployment (see s2s-verify.ts).
 * - `MCP_BEARER_TOKEN`: a static `Authorization: Bearer` token, for clients
 *   that connect directly (Claude Code, Claude Desktop, claude.ai connectors)
 *   through a TLS reverse proxy. Compared in constant time.
 * - `MCP_OAUTH_ENABLED=true`: Entra ID JWTs (auth/middleware.ts). The same
 *   `MCP_BEARER_TOKEN` is then the static fallback inside that flow.
 *
 * Every configured mechanism is enforced. HTTP refuses to start with none of
 * them unless `MCP_ALLOW_INSECURE_DEV=1`, which binds 127.0.0.1 only.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, and MCP_ALLOW_INSECURE_DEV does not bypass this list.
 */
export const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "your-token",
  "your-bearer-token",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
  "bearer-token",
  "token",
]);

/** `openssl rand -hex 32` gives 64 characters; anything under this is refused. */
export const MIN_BEARER_TOKEN_LENGTH = 32;

export const MISSING_AUTH_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "An empty secret would accept unauthenticated /mcp requests (CWE-306). " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned service-to-service secret, " +
  "set MCP_BEARER_TOKEN to a static bearer token (openssl rand -hex 32) for direct clients, " +
  "enable MCP_OAUTH_ENABLED=true, " +
  "or set MCP_ALLOW_INSECURE_DEV=1 to bypass this check for local development only.";

export const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

export const PLACEHOLDER_BEARER_TOKEN_ERROR =
  "Refusing to start HTTP transport: MCP_BEARER_TOKEN is a known placeholder. " +
  "Generate a token with `openssl rand -hex 32` and set MCP_BEARER_TOKEN to that value.";

export const SHORT_BEARER_TOKEN_ERROR =
  `Refusing to start HTTP transport: MCP_BEARER_TOKEN is shorter than ${MIN_BEARER_TOKEN_LENGTH} characters. ` +
  "Generate a token with `openssl rand -hex 32` and set MCP_BEARER_TOKEN to that value.";

export const GATEWAY_NEEDS_S2S_ERROR =
  "Refusing to start HTTP transport: AUTH_MODE=gateway requires CONDUIT_S2S_SECRET. " +
  "Gateway mode takes ConnectWise credentials from request headers, so the caller must prove it is the gateway. " +
  "Use AUTH_MODE=env with MCP_BEARER_TOKEN for direct clients.";

export const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting WITHOUT service-to-service authentication (and without a bearer token) and listens on 127.0.0.1 only. " +
  "Do not use MCP_ALLOW_INSECURE_DEV outside local development.";

export const INSECURE_DEV_IGNORED_WARNING =
  "MCP_ALLOW_INSECURE_DEV=1 is set but ignored: an authentication mechanism is configured and is enforced.";

export interface HttpAuthConfig {
  /** HMAC secret for X-Gateway-S2S. Empty when not configured. */
  s2sSecret: string;
  /** Static bearer token for Authorization: Bearer. Empty when not configured. */
  bearerToken: string;
  /** Entra ID JWT validation is on. */
  oauthEnabled: boolean;
  /** True only when no mechanism is configured and MCP_ALLOW_INSECURE_DEV=1. */
  insecureDev: boolean;
}

export type HttpAuthResolution =
  | { ok: true; config: HttpAuthConfig; warnings: string[] }
  | { ok: false; error: string };

/** The subset of the environment the resolver reads. */
export interface HttpAuthEnv {
  CONDUIT_S2S_SECRET?: string;
  MCP_BEARER_TOKEN?: string;
  MCP_ALLOW_INSECURE_DEV?: string;
}

/**
 * Decide which `/mcp` authentication checks apply, or why the transport must
 * not start. Secrets are never part of a returned message.
 */
export function resolveHttpAuthConfig(
  env: HttpAuthEnv,
  options: { oauthEnabled: boolean; gatewayMode: boolean },
): HttpAuthResolution {
  const s2sSecret = (env.CONDUIT_S2S_SECRET ?? "").trim();
  const bearerToken = (env.MCP_BEARER_TOKEN ?? "").trim();
  const insecureDevRequested = env.MCP_ALLOW_INSECURE_DEV === "1";

  if (KNOWN_PLACEHOLDER_SECRETS.has(s2sSecret.toLowerCase())) {
    return { ok: false, error: PLACEHOLDER_S2S_SECRET_ERROR };
  }
  if (bearerToken && KNOWN_PLACEHOLDER_SECRETS.has(bearerToken.toLowerCase())) {
    return { ok: false, error: PLACEHOLDER_BEARER_TOKEN_ERROR };
  }
  if (bearerToken && bearerToken.length < MIN_BEARER_TOKEN_LENGTH) {
    return { ok: false, error: SHORT_BEARER_TOKEN_ERROR };
  }

  const configured = Boolean(s2sSecret) || Boolean(bearerToken) || options.oauthEnabled;
  if (!configured) {
    if (insecureDevRequested) {
      return {
        ok: true,
        config: { s2sSecret: "", bearerToken: "", oauthEnabled: false, insecureDev: true },
        warnings: [INSECURE_DEV_WARNING],
      };
    }
    return { ok: false, error: MISSING_AUTH_ERROR };
  }

  if (options.gatewayMode && !s2sSecret) {
    return { ok: false, error: GATEWAY_NEEDS_S2S_ERROR };
  }

  const warnings: string[] = [];
  if (insecureDevRequested) warnings.push(INSECURE_DEV_IGNORED_WARNING);
  return {
    ok: true,
    config: { s2sSecret, bearerToken, oauthEnabled: options.oauthEnabled, insecureDev: false },
    warnings,
  };
}

/** Human-readable list of the mechanisms in force, for the startup log. */
export function describeHttpAuth(config: HttpAuthConfig): string {
  if (config.insecureDev) return "none (MCP_ALLOW_INSECURE_DEV)";
  const parts: string[] = [];
  if (config.s2sSecret) parts.push("X-Gateway-S2S");
  if (config.bearerToken) parts.push(config.oauthEnabled ? "static bearer token (OAuth fallback)" : "bearer token");
  if (config.oauthEnabled) parts.push("Entra ID OAuth");
  return parts.join(" + ");
}

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export function parseBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

/** Constant-time string comparison via SHA-256 digests, so lengths do not leak. */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** True when the request carries the configured static bearer token. */
export function verifyBearerHeader(header: string | string[] | undefined, expected: string): boolean {
  if (!expected) return false;
  return safeEqual(parseBearerToken(header), expected);
}

/**
 * Client address for rate limiting. `X-Forwarded-For` is trusted only when
 * the operator says a reverse proxy sets it (MCP_TRUST_PROXY=1); otherwise a
 * client could pick its own bucket.
 */
export function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}

export interface RateLimiter {
  /** True when the client is still within its window allowance. */
  allow(client: string): boolean;
  /** Drop entries whose window has long expired. Call periodically. */
  cleanup(): void;
  /** Number of tracked clients. */
  readonly size: number;
}

/**
 * Fixed-window per-client counter with a bounded table. When the table is
 * full, the oldest window is evicted so memory stays flat under a flood of
 * distinct addresses.
 */
export function createRateLimiter(options: {
  windowMs: number;
  maximum: number;
  capacity: number;
  now?: () => number;
}): RateLimiter {
  const { windowMs, maximum, capacity } = options;
  const now = options.now ?? Date.now;
  const clients = new Map<string, { count: number; windowStart: number }>();
  return {
    allow(client) {
      const timestamp = now();
      let entry = clients.get(client);
      if (!entry || timestamp - entry.windowStart > windowMs) {
        if (!entry && clients.size >= capacity) {
          let oldestClient: string | undefined;
          let oldestStart = Infinity;
          for (const [candidate, value] of clients) {
            if (value.windowStart < oldestStart) {
              oldestClient = candidate;
              oldestStart = value.windowStart;
            }
          }
          if (oldestClient !== undefined) clients.delete(oldestClient);
        }
        entry = { count: 1, windowStart: timestamp };
        clients.set(client, entry);
        return maximum >= 1;
      }
      entry.count += 1;
      return entry.count <= maximum;
    },
    cleanup() {
      const timestamp = now();
      for (const [client, entry] of clients) {
        if (timestamp - entry.windowStart > windowMs * 2) clients.delete(client);
      }
    },
    get size() {
      return clients.size;
    },
  };
}

/** Parse MCP_RATE_LIMIT_PER_MINUTE: a non-negative integer, 0 disables. Default 120. */
export function parseRateLimitPerMinute(value: string | undefined, fallback = 120): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`MCP_RATE_LIMIT_PER_MINUTE must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

/** One JSON line on stderr. Callers pass only non-secret fields. */
export function auditLog(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}
