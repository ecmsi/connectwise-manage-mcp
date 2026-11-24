#!/usr/bin/env node
/**
 * ConnectWise Manage MCP Server
 *
 * Provides MCP tools for interacting with the ConnectWise Manage (PSA) REST API.
 * Supports both cloud-hosted and self-hosted ConnectWise Manage instances.
 *
 * Required environment variables:
 *   CW_MANAGE_COMPANY_ID        - Your ConnectWise company identifier
 *   CW_MANAGE_PUBLIC_KEY        - API member public key
 *   CW_MANAGE_PRIVATE_KEY       - API member private key
 *   CW_MANAGE_CLIENT_ID         - Client ID from ConnectWise Developer Portal
 *
 * Optional environment variables:
 *   CW_MANAGE_URL               - API base URL (default: https://api-na.myconnectwise.net)
 *                                  Cloud: api-na.myconnectwise.net, api-eu.myconnectwise.net, api-au.myconnectwise.net
 *                                  Self-hosted: https://cwm.yourcompany.com (or with full path)
 *   CW_MANAGE_REJECT_UNAUTHORIZED - Set to "false" for self-signed certs (default: "true").
 *                                 Logs a security warning; prefer NODE_EXTRA_CA_CERTS.
 *   CW_WRITE_MODE               - "read-only" (default) registers only get/search/list/test
 *                                 tools; "write" registers the full catalog.
 *   MCP_TRANSPORT               - "stdio" (default) or "http"
 *   MCP_HTTP_PORT               - HTTP port (default: 8080)
 *   MCP_HTTP_HOST               - HTTP bind address. Defaults to 127.0.0.1.
 *                                 Honored only when an authentication
 *                                 mechanism is configured. Without one,
 *                                 MCP_ALLOW_INSECURE_DEV=1 forces 127.0.0.1.
 *   AUTH_MODE                   - "env" (default) or "gateway" for header-based auth.
 *                                 Gateway mode requires CONDUIT_S2S_SECRET.
 *   CONDUIT_S2S_SECRET          - HMAC secret for X-Gateway-S2S (WYRE gateway).
 *   MCP_BEARER_TOKEN            - Static bearer token for direct clients
 *                                 (Claude Code, Claude Desktop, claude.ai).
 *                                 At least 32 characters; openssl rand -hex 32.
 *   MCP_ALLOW_INSECURE_DEV      - Set to "1" to start HTTP with no auth configured.
 *                                 Listens on 127.0.0.1 only. Local development.
 *   MCP_RATE_LIMIT_PER_MINUTE   - Per-client request cap on every path except
 *                                 /health (default 120; 0 disables).
 *   MCP_TRUST_PROXY             - Set to "1" when a reverse proxy sets
 *                                 X-Forwarded-For, so the rate limiter sees the
 *                                 real client address.
 *
 * HTTP refuses to start unless at least one of CONDUIT_S2S_SECRET,
 * MCP_BEARER_TOKEN or MCP_OAUTH_ENABLED=true is configured, or
 * MCP_ALLOW_INSECURE_DEV=1. Every configured mechanism is enforced on /mcp.
 *
 * Entra ID OAuth 2.1 (optional — set MCP_OAUTH_ENABLED=true to activate):
 *   MCP_OAUTH_ENABLED           - Enable Entra ID auth middleware (default: false)
 *   MCP_SERVER_URL              - Full public URL of this server (e.g. https://mcp.yourdomain.com)
 *   AZURE_TENANT_ID             - Entra tenant GUID
 *   AZURE_CLIENT_ID             - App registration client ID
 *   AZURE_AUDIENCE              - Token audience, typically api://<AZURE_CLIENT_ID>
 *   AZURE_REQUIRED_ROLE         - App role claim required on every request (default: CWM.Access)
 *   MCP_BEARER_TOKEN            - With OAuth on, the static fallback inside that flow
 */

import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getEntraConfig, createJwksClient, validateToken } from "./auth/middleware.js";
import {
  handleProtectedResource,
  handleAuthServerMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
} from "./auth/routes.js";
import { AuthError } from "./auth/types.js";
import {
  createMcpServer,
  resolveGatewayConfig,
  type CwManageConfig,
} from "./mcp-server.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";
import { isValidHostHeader, parseRequestTarget } from "./request-target.js";
import {
  auditLog,
  createRateLimiter,
  describeHttpAuth,
  getClientIp,
  parseRateLimitPerMinute,
  resolveHttpAuthConfig,
  verifyBearerHeader,
  type HttpAuthConfig,
} from "./http-auth.js";
import { resolveWriteMode, type WriteMode } from "./tool-policy.js";

const LOOPBACK_HOST = "127.0.0.1";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CLIENTS = 10_000;

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Hosts that are already loopback. The insecure-dev bypass still binds 127.0.0.1. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") {
    return true;
  }
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Decide the /mcp authentication checks from the environment, or refuse to
 * start. Read at HTTP startup, not module load. No secret value is logged.
 */
function resolveHttpAuthOrExit(oauthEnabled: boolean, gatewayMode: boolean): HttpAuthConfig {
  const resolution = resolveHttpAuthConfig(process.env, { oauthEnabled, gatewayMode });
  if (!resolution.ok) {
    console.error(resolution.error);
    process.exit(1);
  }
  for (const warning of resolution.warnings) console.error(warning);
  return resolution.config;
}

/**
 * With no authentication configured (insecure-dev bypass only): always
 * 127.0.0.1, including when MCP_HTTP_HOST is a wider address such as 0.0.0.0.
 * With authentication configured, MCP_HTTP_HOST is honored; unset defaults
 * to 127.0.0.1.
 */
function resolveListenHost(auth: HttpAuthConfig): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (!auth.insecureDev) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

function resolveWriteModeOrExit(): WriteMode {
  try {
    return resolveWriteMode(process.env.CW_WRITE_MODE);
  } catch (err) {
    console.error(`Refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Transport: stdio
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const writeMode = resolveWriteModeOrExit();
  const server = createMcpServer(undefined, { writeMode });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `ConnectWise Manage MCP server running on stdio (write mode: ${writeMode}, ` +
      `${server.registeredTools.length} tools registered, ${server.skippedTools.length} write tools withheld)`,
  );
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";
  const oauthEnabled = process.env.MCP_OAUTH_ENABLED === "true";
  const auth = resolveHttpAuthOrExit(oauthEnabled, isGatewayMode);
  const host = resolveListenHost(auth);
  const writeMode = resolveWriteModeOrExit();
  const trustProxy = process.env.MCP_TRUST_PROXY === "1";

  let rateLimitPerMinute: number;
  try {
    rateLimitPerMinute = parseRateLimitPerMinute(process.env.MCP_RATE_LIMIT_PER_MINUTE);
  } catch (err) {
    console.error(`Refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const rateLimiter =
    rateLimitPerMinute > 0
      ? createRateLimiter({
          windowMs: RATE_LIMIT_WINDOW_MS,
          maximum: rateLimitPerMinute,
          capacity: RATE_LIMIT_MAX_CLIENTS,
        })
      : null;
  const cleanupTimer = rateLimiter
    ? setInterval(() => rateLimiter.cleanup(), RATE_LIMIT_WINDOW_MS)
    : null;
  cleanupTimer?.unref();

  // ---------------------------------------------------------------------------
  // Entra ID auth setup (optional)
  // ---------------------------------------------------------------------------
  let entraConfig: ReturnType<typeof getEntraConfig> | null = null;
  let jwksClient: ReturnType<typeof createJwksClient> | null = null;

  if (oauthEnabled) {
    entraConfig = getEntraConfig();
    jwksClient = createJwksClient(entraConfig);
    console.error(
      `[auth] Entra ID OAuth enabled — tenant: ${entraConfig.tenantId}, required role: ${entraConfig.requiredRole}`,
    );
    if (entraConfig.bearerToken) {
      console.error("[auth] Static bearer token fallback enabled (CLI/Desktop)");
    }
  }

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The request target is parsed against a fixed base, never against the
    // client-supplied Host header. A malformed Host or target is answered
    // with 400: it must not be able to throw here and end the process.
    const url = isValidHostHeader(req.headers.host)
      ? parseRequestTarget(req.url)
      : null;
    if (!url) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    // Health endpoint: unauthenticated, so it says nothing about configuration.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    const clientIp = getClientIp(req, trustProxy);
    if (rateLimiter && !rateLimiter.allow(clientIp)) {
      auditLog("http_rate_limited", { ip: clientIp, path: url.pathname });
      sendJson(
        res,
        429,
        { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests" }, id: null },
        { "Retry-After": "60" },
      );
      return;
    }

    // ------------------------------------------------------------------
    // OAuth discovery + proxy endpoints (always available when OAuth on)
    // ------------------------------------------------------------------
    if (oauthEnabled && entraConfig) {
      if (
        url.pathname === "/.well-known/oauth-protected-resource" &&
        req.method === "GET"
      ) {
        handleProtectedResource(res, entraConfig);
        return;
      }

      if (
        url.pathname === "/.well-known/oauth-authorization-server" &&
        req.method === "GET"
      ) {
        handleAuthServerMetadata(res, entraConfig);
        return;
      }

      if (url.pathname === "/register" && req.method === "POST") {
        handleRegister(req, res, entraConfig).catch((err) => {
          console.error("[auth] /register error:", err instanceof Error ? err.name : "unknown");
          if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
        });
        return;
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        handleAuthorize(req, res, entraConfig);
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        handleToken(req, res, entraConfig).catch((err) => {
          console.error("[auth] /token error:", err instanceof Error ? err.name : "unknown");
          if (!res.headersSent) sendJson(res, 502, { error: "token_proxy_error" });
        });
        return;
      }
    }

    // MCP endpoint - stateless: fresh server + transport per request
    if (url.pathname === "/mcp") {
      // Every configured mechanism is enforced before any credential
      // extraction. An empty config is only reachable under
      // MCP_ALLOW_INSECURE_DEV=1; startup refuses otherwise.
      if (auth.s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), auth.s2sSecret)) {
        auditLog("http_auth_failed", { ip: clientIp, reason: "s2s" });
        sendJson(res, 401, {
          error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
        });
        return;
      }

      // With OAuth on, the static token is checked inside that flow below.
      if (auth.bearerToken && !oauthEnabled && !verifyBearerHeader(req.headers.authorization, auth.bearerToken)) {
        auditLog("http_auth_failed", { ip: clientIp, reason: "bearer" });
        sendJson(
          res,
          401,
          { error: "unauthorized", message: "Bearer token required" },
          { "WWW-Authenticate": 'Bearer realm="connectwise-manage-mcp"' },
        );
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        });
        return;
      }

      // ------------------------------------------------------------------
      // Entra ID auth check
      // ------------------------------------------------------------------
      const handleMcp = async () => {
        if (oauthEnabled && entraConfig) {
          const authHeader = req.headers.authorization;

          if (!authHeader?.startsWith("Bearer ")) {
            sendJson(
              res,
              401,
              { error: "unauthorized", message: "Bearer token required" },
              { "WWW-Authenticate": `Bearer resource_metadata="${entraConfig.serverUrl}/.well-known/oauth-protected-resource"` },
            );
            return;
          }

          const token = authHeader.slice(7);

          try {
            let identity;
            // Static bearer token check (Claude Code CLI / Claude Desktop)
            // Use timing-safe comparison to prevent token length oracle attacks
            const staticTokenMatch =
              entraConfig.bearerToken !== undefined &&
              timingSafeEqual(
                createHash("sha256").update(token).digest(),
                createHash("sha256").update(entraConfig.bearerToken).digest(),
              );
            if (staticTokenMatch) {
              identity = {
                upn: "cli-user",
                roles: [entraConfig.requiredRole],
                oid: "static",
              };
            } else {
              identity = await validateToken(token, entraConfig, jwksClient!);
            }
            console.error(
              `[audit] ${identity.upn} | ${new Date().toISOString()} | POST /mcp`,
            );
          } catch (err) {
            if (err instanceof AuthError) {
              auditLog("http_auth_failed", { ip: clientIp, reason: "oauth", status: err.statusCode });
              sendJson(res, err.statusCode, { error: "auth_failed", message: err.message });
            } else {
              console.error("[auth] Unexpected validation error:", err instanceof Error ? err.name : "unknown");
              sendJson(res, 500, { error: "internal_error" });
            }
            return;
          }
        }

        // ------------------------------------------------------------------
        // Gateway mode: extract CW credentials from headers (per request,
        // no global process.env mutation so concurrent requests stay isolated)
        // ------------------------------------------------------------------
        let configOverride: CwManageConfig | undefined;
        if (isGatewayMode) {
          // Gateway mode: credentials must arrive on every request via the
          // X-CW-* headers. Reject explicitly when any required header is
          // missing. Falling through would resolve CW_MANAGE_* from the
          // process environment, which is not request-scoped.
          const { config, error } = resolveGatewayConfig((name) =>
            headerValue(req.headers[name]),
          );
          if (error) {
            sendJson(res, 401, {
              error: "Missing credentials",
              message:
                "Gateway mode requires X-CW-Company-Id, X-CW-Public-Key, X-CW-Private-Key, and X-CW-Client-Id headers",
              required: [
                "X-CW-Company-Id",
                "X-CW-Public-Key",
                "X-CW-Private-Key",
                "X-CW-Client-Id",
              ],
            });
            return;
          }
          configOverride = config;
        }

        // ------------------------------------------------------------------
        // MCP handler
        // ------------------------------------------------------------------
        const server = createMcpServer(configOverride, { writeMode });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => {
          transport.close();
          server.close();
        });

        await server.connect(transport as unknown as Transport);
        transport.handleRequest(req, res);
      };

      handleMcp().catch((err) => {
        console.error("MCP transport error:", err instanceof Error ? err.name : "unknown");
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          });
        }
      });

      return;
    }

    // 404 for everything else
    sendJson(res, 404, { error: "Not found", endpoints: ["/mcp", "/health"] });
  });

  httpServer.on("close", () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
  });

  await new Promise<void>((resolve) => {
    httpServer!.listen(port, host, () => {
      console.error(
        `ConnectWise Manage MCP server listening on http://${host}:${port}/mcp`,
      );
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`,
      );
      console.error(`HTTP client authentication: ${describeHttpAuth(auth)}`);
      console.error(
        `Write mode: ${writeMode}; rate limit: ${rateLimitPerMinute > 0 ? `${rateLimitPerMinute}/min per client` : "off"}` +
          `${trustProxy ? " (X-Forwarded-For trusted)" : ""}`,
      );
      resolve();
    });
  });

  return httpServer!;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down ConnectWise Manage MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
