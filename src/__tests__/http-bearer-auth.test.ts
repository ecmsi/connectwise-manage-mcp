/**
 * HTTP transport with a static bearer token (no gateway), rate limiting,
 * the trimmed health endpoint and write-mode gating over HTTP.
 *
 * Mirrors the harness in http-s2s-auth.test.ts.
 */
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpTransport } from "../index.js";

const TOKEN = "f3a9c17e4b2d8f6a0c5e1d9b7a3f2e8c4d6b0a1f9e8d7c6b5a4f3e2d1c0b9a8f";
const S2S_SECRET = "s2s-do-not-log-7f3a9c";

const ENV_KEYS = [
  "MCP_S2S_SECRET",
  "MCP_BEARER_TOKEN",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "MCP_TRUST_PROXY",
  "MCP_RATE_LIMIT_PER_MINUTE",
  "AUTH_MODE",
  "MCP_TRANSPORT",
  "MCP_OAUTH_ENABLED",
  "CW_WRITE_MODE",
  "CW_MANAGE_COMPANY_ID",
  "CW_MANAGE_PUBLIC_KEY",
  "CW_MANAGE_PRIVATE_KEY",
  "CW_MANAGE_CLIENT_ID",
  "CW_MANAGE_URL",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

const servers: HttpServer[] = [];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function useBearerEnv(): void {
  delete process.env.MCP_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.MCP_OAUTH_ENABLED;
  delete process.env.MCP_TRUST_PROXY;
  delete process.env.MCP_RATE_LIMIT_PER_MINUTE;
  process.env.MCP_BEARER_TOKEN = TOKEN;
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.MCP_HTTP_PORT = "0";
  process.env.AUTH_MODE = "env";
  process.env.CW_MANAGE_COMPANY_ID = "env-company";
  process.env.CW_MANAGE_PUBLIC_KEY = "env-public";
  process.env.CW_MANAGE_PRIVATE_KEY = "env-private";
  process.env.CW_MANAGE_CLIENT_ID = "env-client";
  process.env.CW_MANAGE_URL = "https://env.example.invalid";
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return { text: () => lines.join("\n"), restore: () => spy.mockRestore() };
}

function installExitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? ""}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: options.port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error(`timeout ${options.method} ${options.path}`)));
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra };
}

const toolsListBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

function mintS2sHeader(secret: string): string {
  const message = `t=${Math.floor(Date.now() / 1000)}`;
  return `${message},v1=${createHmac("sha256", secret).update(message).digest("hex")}`;
}

async function listen(): Promise<{ server: HttpServer; port: number; address: string }> {
  const server = await startHttpTransport();
  servers.push(server);
  const info = server.address();
  if (!info || typeof info === "string") throw new Error("expected a TCP listen address");
  return { server, port: info.port, address: info.address };
}

function toolNames(body: string): string[] {
  const payload = JSON.parse(body) as { result?: { tools?: Array<{ name?: string }> } };
  return (payload.result?.tools ?? []).map((t) => t.name ?? "");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }
  restoreEnv();
});

describe("bearer token startup", () => {
  it("starts with MCP_BEARER_TOKEN alone, honours MCP_HTTP_HOST and logs no token", async () => {
    useBearerEnv();
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    const { address } = await listen();
    expect(address).toBe("0.0.0.0");
    expect(logs.text()).toContain("HTTP client authentication: bearer token");
    expect(logs.text()).not.toContain(TOKEN);
  });

  it("refuses a short token and a placeholder token", async () => {
    useBearerEnv();
    process.env.MCP_BEARER_TOKEN = "tooshort";
    const logs = captureStderr();
    installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("MCP_BEARER_TOKEN is shorter than 32 characters");

    process.env.MCP_BEARER_TOKEN = "changeme".padEnd(40, " ");
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("MCP_BEARER_TOKEN is a known placeholder");
    expect(logs.text()).not.toContain("tooshort");
  });

  it("refuses gateway mode with a bearer token but no S2S secret", async () => {
    useBearerEnv();
    process.env.AUTH_MODE = "gateway";
    const logs = captureStderr();
    installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("AUTH_MODE=gateway requires MCP_S2S_SECRET");
  });

  it("refuses a bad CW_WRITE_MODE and a bad rate limit before listening", async () => {
    useBearerEnv();
    process.env.CW_WRITE_MODE = "rw";
    const logs = captureStderr();
    installExitSpy();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("CW_WRITE_MODE");

    process.env.CW_WRITE_MODE = "read-only";
    process.env.MCP_RATE_LIMIT_PER_MINUTE = "many";
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("MCP_RATE_LIMIT_PER_MINUTE");
  });
});

describe("bearer token on /mcp", () => {
  it("answers 401 with WWW-Authenticate when the token is missing or wrong, 200 when right", async () => {
    useBearerEnv();
    const logs = captureStderr();
    const { port } = await listen();

    const missing = await sendHttp({ port, method: "POST", path: "/mcp", headers: mcpHeaders(), body: toolsListBody });
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");

    const wrong = await sendHttp({
      port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN.slice(0, -1)}0` }),
      body: toolsListBody,
    });
    expect(wrong.status).toBe(401);

    const basic = await sendHttp({
      port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ authorization: `Basic ${Buffer.from(TOKEN).toString("base64")}` }),
      body: toolsListBody,
    });
    expect(basic.status).toBe(401);

    const right = await sendHttp({
      port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN}` }),
      body: toolsListBody,
    });
    expect(right.status).toBe(200);
    expect(toolNames(right.body)).toContain("cw_search_tickets");

    const text = logs.text();
    expect(text).toContain('"event":"http_auth_failed"');
    expect(text).toContain('"reason":"bearer"');
    expect(text).not.toContain(TOKEN);
  });

  it("checks the token before the method, so a GET without a token is 401 not 405", async () => {
    useBearerEnv();
    captureStderr();
    const { port } = await listen();
    const anonymous = await sendHttp({ port, method: "GET", path: "/mcp" });
    expect(anonymous.status).toBe(401);
    const authed = await sendHttp({ port, method: "GET", path: "/mcp", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authed.status).toBe(405);
  });

  it("requires both proofs when S2S and bearer are both configured", async () => {
    useBearerEnv();
    process.env.MCP_S2S_SECRET = S2S_SECRET;
    captureStderr();
    const { port } = await listen();

    const bearerOnly = await sendHttp({
      port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN}` }), body: toolsListBody,
    });
    expect(bearerOnly.status).toBe(401);
    expect(bearerOnly.body).toContain("X-Gateway-S2S");

    const s2sOnly = await sendHttp({
      port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }), body: toolsListBody,
    });
    expect(s2sOnly.status).toBe(401);
    expect(s2sOnly.headers["www-authenticate"]).toContain("Bearer");

    const both = await sendHttp({
      port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET), authorization: `Bearer ${TOKEN}` }),
      body: toolsListBody,
    });
    expect(both.status).toBe(200);
  });
});

describe("health, write mode and rate limiting over HTTP", () => {
  it("/health and /healthz are open and say only that the server is up", async () => {
    useBearerEnv();
    captureStderr();
    const { port } = await listen();
    for (const path of ["/health", "/healthz"]) {
      const res = await sendHttp({ port, method: "GET", path });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    }
  });

  it("read-only mode withholds write tools over HTTP; write mode lists them", async () => {
    useBearerEnv();
    process.env.CW_WRITE_MODE = "read-only";
    const logs = captureStderr();
    const ro = await listen();
    const roList = await sendHttp({
      port: ro.port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN}` }), body: toolsListBody,
    });
    const roNames = toolNames(roList.body);
    expect(roNames).toContain("cw_get_ticket");
    expect(roNames).not.toContain("cw_create_ticket");
    expect(roNames).not.toContain("cw_delete_time_entry");
    expect(logs.text()).toContain("Write mode: read-only");

    process.env.CW_WRITE_MODE = "write";
    const rw = await listen();
    const rwList = await sendHttp({
      port: rw.port, method: "POST", path: "/mcp",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN}` }), body: toolsListBody,
    });
    expect(toolNames(rwList.body)).toContain("cw_create_ticket");
  });

  it("rate limits per client address and exempts /health", async () => {
    useBearerEnv();
    process.env.MCP_RATE_LIMIT_PER_MINUTE = "2";
    const logs = captureStderr();
    const { port } = await listen();

    const first = await sendHttp({ port, method: "GET", path: "/nope" });
    const second = await sendHttp({ port, method: "GET", path: "/nope" });
    const third = await sendHttp({ port, method: "GET", path: "/nope" });
    expect([first.status, second.status]).toEqual([404, 404]);
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBe("60");

    const health = await sendHttp({ port, method: "GET", path: "/health" });
    expect(health.status).toBe(200);
    expect(logs.text()).toContain('"event":"http_rate_limited"');
  });

  it("honours X-Forwarded-For only with MCP_TRUST_PROXY=1", async () => {
    useBearerEnv();
    process.env.MCP_RATE_LIMIT_PER_MINUTE = "1";
    captureStderr();

    const untrusted = await listen();
    await sendHttp({ port: untrusted.port, method: "GET", path: "/nope", headers: { "x-forwarded-for": "203.0.113.1" } });
    const sameSocket = await sendHttp({ port: untrusted.port, method: "GET", path: "/nope", headers: { "x-forwarded-for": "203.0.113.2" } });
    expect(sameSocket.status).toBe(429);

    process.env.MCP_TRUST_PROXY = "1";
    const trusted = await listen();
    await sendHttp({ port: trusted.port, method: "GET", path: "/nope", headers: { "x-forwarded-for": "203.0.113.1" } });
    const otherClient = await sendHttp({ port: trusted.port, method: "GET", path: "/nope", headers: { "x-forwarded-for": "203.0.113.2" } });
    expect(otherClient.status).toBe(404);
  });

  it("MCP_RATE_LIMIT_PER_MINUTE=0 turns the limiter off", async () => {
    useBearerEnv();
    process.env.MCP_RATE_LIMIT_PER_MINUTE = "0";
    const logs = captureStderr();
    const { port } = await listen();
    for (let i = 0; i < 5; i++) {
      expect((await sendHttp({ port, method: "GET", path: "/nope" })).status).toBe(404);
    }
    expect(logs.text()).toContain("rate limit: off");
  });
});
