/**
 * Pure HTTP auth helpers: startup resolution, bearer parsing, constant-time
 * compare, client address and the rate limiter. No listener is started.
 */
import { Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_NEEDS_S2S_ERROR,
  INSECURE_DEV_IGNORED_WARNING,
  INSECURE_DEV_WARNING,
  MISSING_AUTH_ERROR,
  PLACEHOLDER_BEARER_TOKEN_ERROR,
  PLACEHOLDER_S2S_SECRET_ERROR,
  SHORT_BEARER_TOKEN_ERROR,
  createRateLimiter,
  describeHttpAuth,
  getClientIp,
  parseBearerToken,
  parseRateLimitPerMinute,
  resolveHttpAuthConfig,
  safeEqual,
  verifyBearerHeader,
} from "../http-auth.js";

const TOKEN = "f3a9c17e4b2d8f6a0c5e1d9b7a3f2e8c4d6b0a1f9e8d7c6b5a4f3e2d1c0b9a8f";

describe("resolveHttpAuthConfig", () => {
  const direct = { oauthEnabled: false, gatewayMode: false };

  it("refuses to start with nothing configured", () => {
    expect(resolveHttpAuthConfig({}, direct)).toEqual({ ok: false, error: MISSING_AUTH_ERROR });
    expect(MISSING_AUTH_ERROR).toContain("CWE-306");
    expect(MISSING_AUTH_ERROR).toContain("MCP_BEARER_TOKEN");
  });

  it("accepts a bearer token alone", () => {
    const r = resolveHttpAuthConfig({ MCP_BEARER_TOKEN: ` ${TOKEN} ` }, direct);
    expect(r).toEqual({
      ok: true,
      config: { s2sSecret: "", bearerToken: TOKEN, oauthEnabled: false, insecureDev: false },
      warnings: [],
    });
  });

  it("accepts an S2S secret alone and both together", () => {
    const only = resolveHttpAuthConfig({ MCP_S2S_SECRET: "s2s-7f3a9c-real" }, direct);
    expect(only.ok && only.config.s2sSecret).toBe("s2s-7f3a9c-real");
    const both = resolveHttpAuthConfig({ MCP_S2S_SECRET: "s2s-7f3a9c-real", MCP_BEARER_TOKEN: TOKEN }, direct);
    expect(both.ok && both.config).toEqual({
      s2sSecret: "s2s-7f3a9c-real",
      bearerToken: TOKEN,
      oauthEnabled: false,
      insecureDev: false,
    });
  });

  it("accepts OAuth alone", () => {
    const r = resolveHttpAuthConfig({}, { oauthEnabled: true, gatewayMode: false });
    expect(r.ok && r.config.oauthEnabled).toBe(true);
    expect(r.ok && r.config.insecureDev).toBe(false);
  });

  it.each(["changeme", "  Your-Secret  ", "token", "your-bearer-token"])(
    "refuses placeholder bearer token %j",
    (value) => {
      // Pad so the length rule is not what refuses it.
      const padded = value.padEnd(40, " ");
      expect(resolveHttpAuthConfig({ MCP_BEARER_TOKEN: padded }, direct)).toEqual({
        ok: false,
        error: PLACEHOLDER_BEARER_TOKEN_ERROR,
      });
    },
  );

  it("refuses a placeholder S2S secret even with the dev bypass", () => {
    expect(resolveHttpAuthConfig({ MCP_S2S_SECRET: "secret", MCP_ALLOW_INSECURE_DEV: "1" }, direct)).toEqual({
      ok: false,
      error: PLACEHOLDER_S2S_SECRET_ERROR,
    });
  });

  it("refuses a short bearer token", () => {
    expect(resolveHttpAuthConfig({ MCP_BEARER_TOKEN: "abcdef0123456789" }, direct)).toEqual({
      ok: false,
      error: SHORT_BEARER_TOKEN_ERROR,
    });
  });

  it("requires S2S for gateway mode, and lets the dev bypass stand in for it", () => {
    expect(resolveHttpAuthConfig({ MCP_BEARER_TOKEN: TOKEN }, { oauthEnabled: false, gatewayMode: true })).toEqual({
      ok: false,
      error: GATEWAY_NEEDS_S2S_ERROR,
    });
    const dev = resolveHttpAuthConfig({ MCP_ALLOW_INSECURE_DEV: "1" }, { oauthEnabled: false, gatewayMode: true });
    expect(dev.ok && dev.config.insecureDev).toBe(true);
  });

  it("honours the dev bypass only with nothing configured, and warns", () => {
    const dev = resolveHttpAuthConfig({ MCP_ALLOW_INSECURE_DEV: "1" }, direct);
    expect(dev).toEqual({
      ok: true,
      config: { s2sSecret: "", bearerToken: "", oauthEnabled: false, insecureDev: true },
      warnings: [INSECURE_DEV_WARNING],
    });
    const ignored = resolveHttpAuthConfig({ MCP_ALLOW_INSECURE_DEV: "1", MCP_BEARER_TOKEN: TOKEN }, direct);
    expect(ignored.ok && ignored.config.insecureDev).toBe(false);
    expect(ignored.ok && ignored.warnings).toEqual([INSECURE_DEV_IGNORED_WARNING]);
    const notOne = resolveHttpAuthConfig({ MCP_ALLOW_INSECURE_DEV: "true" }, direct);
    expect(notOne.ok).toBe(false);
  });

  it("never puts a secret value in an error or warning", () => {
    const texts = [
      MISSING_AUTH_ERROR,
      PLACEHOLDER_S2S_SECRET_ERROR,
      PLACEHOLDER_BEARER_TOKEN_ERROR,
      SHORT_BEARER_TOKEN_ERROR,
      GATEWAY_NEEDS_S2S_ERROR,
      INSECURE_DEV_WARNING,
      INSECURE_DEV_IGNORED_WARNING,
    ];
    const r = resolveHttpAuthConfig({ MCP_BEARER_TOKEN: "abc" }, direct);
    expect(r.ok).toBe(false);
    for (const text of [...texts, r.ok ? "" : r.error]) expect(text).not.toContain("abc");
  });

  it("describes the mechanisms in force without values", () => {
    expect(describeHttpAuth({ s2sSecret: "x", bearerToken: TOKEN, oauthEnabled: false, insecureDev: false })).toBe(
      "X-Gateway-S2S + bearer token",
    );
    expect(describeHttpAuth({ s2sSecret: "", bearerToken: "", oauthEnabled: false, insecureDev: true })).toContain(
      "MCP_ALLOW_INSECURE_DEV",
    );
    expect(describeHttpAuth({ s2sSecret: "", bearerToken: TOKEN, oauthEnabled: true, insecureDev: false })).not.toContain(
      TOKEN,
    );
  });
});

describe("bearer helpers", () => {
  it("parses only a well-formed Bearer header", () => {
    expect(parseBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseBearerToken(`bearer   ${TOKEN}  `)).toBe(TOKEN);
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken("Bearer")).toBeUndefined();
    expect(parseBearerToken("Bearer a b")).toBeUndefined();
    expect(parseBearerToken(undefined)).toBeUndefined();
    expect(parseBearerToken(["Bearer x", "Bearer y"])).toBeUndefined();
  });

  it("compares in constant time and never matches empty", () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(undefined, TOKEN)).toBe(false);
  });

  it("verifies a header against the expected token", () => {
    expect(verifyBearerHeader(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearerHeader(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(verifyBearerHeader(undefined, TOKEN)).toBe(false);
    expect(verifyBearerHeader(`Bearer ${TOKEN}`, "")).toBe(false);
  });
});

describe("getClientIp", () => {
  function fakeReq(headers: Record<string, string | string[]>, remote = "10.9.8.7"): IncomingMessage {
    const socket = { remoteAddress: remote } as Socket;
    return { headers, socket } as unknown as IncomingMessage;
  }

  it("ignores X-Forwarded-For unless the proxy is trusted", () => {
    const req = fakeReq({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(getClientIp(req, false)).toBe("10.9.8.7");
    expect(getClientIp(req, true)).toBe("203.0.113.5");
  });

  it("falls back to the socket when the header is empty", () => {
    expect(getClientIp(fakeReq({ "x-forwarded-for": "  " }), true)).toBe("10.9.8.7");
    expect(getClientIp(fakeReq({}), true)).toBe("10.9.8.7");
  });
});

describe("rate limiter", () => {
  it("allows up to the maximum per window, then refuses until the window turns", () => {
    let clock = 1_000;
    const limiter = createRateLimiter({ windowMs: 60_000, maximum: 3, capacity: 10, now: () => clock });
    expect([1, 2, 3].map(() => limiter.allow("a"))).toEqual([true, true, true]);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
    clock += 60_001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("evicts the oldest window when the table is full", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 60_000, maximum: 1, capacity: 2, now: () => clock });
    limiter.allow("first");
    clock = 10;
    limiter.allow("second");
    clock = 20;
    expect(limiter.allow("third")).toBe(true);
    expect(limiter.size).toBe(2);
    // "first" was evicted, so it starts a fresh window and is allowed again.
    expect(limiter.allow("first")).toBe(true);
  });

  it("cleanup drops long-expired entries", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 1_000, maximum: 5, capacity: 100, now: () => clock });
    limiter.allow("a");
    clock = 2_500;
    limiter.cleanup();
    expect(limiter.size).toBe(0);
  });

  it("parses MCP_RATE_LIMIT_PER_MINUTE", () => {
    expect(parseRateLimitPerMinute(undefined)).toBe(120);
    expect(parseRateLimitPerMinute("")).toBe(120);
    expect(parseRateLimitPerMinute("0")).toBe(0);
    expect(parseRateLimitPerMinute("30")).toBe(30);
    expect(() => parseRateLimitPerMinute("-1")).toThrow(/non-negative/);
    expect(() => parseRateLimitPerMinute("lots")).toThrow(/non-negative/);
  });
});
