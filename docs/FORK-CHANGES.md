# What the ECMSI fork changes

This fork of [WYRE-AI/connectwise-manage-mcp](https://github.com/WYRE-AI/connectwise-manage-mcp)
exists to run the server on ECMSI's centralised MCP host: one Ubuntu VM, one shared Caddy, one
container per MCP server, each reached by Claude Code, Claude Desktop and claude.ai with a bearer
token over TLS. Upstream is built around the WYRE gateway, which signs every request with an HMAC
header no direct client can produce. Everything below follows from closing that gap and from the
security review recorded alongside the fork.

Versions are `<upstream>-ecmsi.<n>`. The base is upstream commit `bb2a907` (2026-11-24).

| Area | Upstream | Fork | Why |
|---|---|---|---|
| HTTP authentication | `CONDUIT_S2S_SECRET` (gateway HMAC) is mandatory. `MCP_BEARER_TOKEN` works only inside the Entra OAuth flow. | `MCP_BEARER_TOKEN` is a first-class mechanism: constant-time compared, 32-character minimum, placeholder list, `WWW-Authenticate` on failure. Startup refuses to listen unless S2S, bearer or OAuth is configured. Every configured mechanism is enforced. `AUTH_MODE=gateway` still requires S2S. | No gateway on the ECMSI host. Without this the only way to run HTTP was `MCP_ALLOW_INSECURE_DEV=1`, which is no authentication at all. |
| Write mode | All 89 tools always registered. | `CW_WRITE_MODE=read-only` (default) registers the 63 `get`/`search`/`list`/`test` tools; `write` registers all. Gated at registration (`src/tool-policy.ts`), so withheld tools are not listed and cannot be called. A test scans every tool source and fails if a read-named tool issues anything but GET. | Ticket notes and descriptions are written by customers over email. Text the model reads can try to instruct it; with no write tools present, an injected instruction cannot change PSA data. |
| Audit log | Per-request line only in OAuth mode. | One JSON line per tool call on stderr: tool name, outcome, duration. Never arguments or results. Auth failures and rate-limit hits are logged with the client address and reason. | A shared host needs to answer "what did the model do" without logging PSA data. |
| Rate limiting | None. | Fixed-window per-client limiter, `MCP_RATE_LIMIT_PER_MINUTE` (default 120, 0 disables), bounded table. `MCP_TRUST_PROXY=1` reads `X-Forwarded-For`. | Bearer tokens are brute-forceable without a cap; the limiter also bounds the cost of the per-request server construction. |
| Health endpoint | Returns `authMode`, `oauthEnabled`, timestamp. | Returns `{"status":"ok"}` only; `/healthz` alias. | It is unauthenticated. |
| Redirects | Followed in env mode. | Refused in every mode. | `fetch` keeps the custom `clientId` header and a 307/308 body across a redirect. `CW_MANAGE_URL` must be the canonical origin. |
| Relaxed TLS | `CW_MANAGE_REJECT_UNAUTHORIZED=false` is silent. | Logs a security warning once and points at `NODE_EXTRA_CA_CERTS`. | Disabling verification exposes the API keys to interception. |
| Error logging | Whole error objects for transport and OAuth proxy errors. | Error class names only. | Error causes can carry request detail. |
| Dependencies | Production tree carried 8 advisories (SDK 1.31.0, undici 8.11.2, zod 4.3.6, qs). | Lockfile refreshed within declared ranges: SDK 1.32.2, undici 8.13.1, zod 4.6.7, qs 6.17.1. `npm audit --omit=dev` is clean and runs in CI. | Two of the advisories were reachable on the request path (SDK memory exhaustion, undici TLS option bypass in `Agent`). |
| CI | Four workflows call reusable workflows in the WYRE-AI organisation with `secrets: inherit`, including a Claude Code action with `contents: write` triggered by issue comments. | One read-only workflow: lint, typecheck, build, tests on Node 22 and 24, production audit, and a container smoke test that proves the image refuses to start without auth, answers 401 without the token, and withholds write tools in read-only mode. | No third-party pipeline and no write-scoped token in the fork. |
| Deployment | `docker-compose.yml` is gateway mode; `docker-compose.caddy.yml` runs a dedicated Caddy container with ports 80/443. | `docker-compose.yml` is single-tenant env mode, published on `127.0.0.1:3101`, read-only root, no capabilities, memory cap. `deploy/caddy/` holds a site snippet for the host's shared Caddy; `deploy/systemd/` a hardened unit for a non-Docker install. `docs/DEPLOYMENT.md` describes the centralised-host layout. | One Caddy per host, one port per MCP server. |
| Repository hygiene | WYRE CODEOWNERS, release and project automation. | `.gitattributes` normalises line endings; CODEOWNERS points at the fork owner; `npm run check` is the local gate. | Windows and Linux checkouts hash the same; no stray review requests to upstream maintainers. |

Not changed, by design: the Cloudflare Worker entry point, the DigitalOcean template, `wrangler.json`,
`server.json`, `manifest.json` and the Entra OAuth routes. They are not used on the ECMSI host and are
left as upstream ships them to keep merges small. The Worker does honour `CW_WRITE_MODE` from its
binding, and defaults to read-only like every other entry point.

## Upstreamable pieces

Each of these stands on its own and could be offered upstream as a pull request:

1. Lockfile refresh (`fix(deps)`).
2. Refuse redirects in env mode, with the error naming the fix.
3. Relaxed-TLS warning.
4. `/health` disclosure trim.
5. Error class names instead of error objects in HTTP logs.
6. Bearer token as a standalone mechanism (`src/http-auth.ts`), behind the same fail-closed startup.
7. Write-mode gating and the tool-source scan test (`src/tool-policy.ts`).
8. Rate limiting.

## Verification

- `npm run check` on Windows 11, Node 26.13.1: lint, typecheck, build, 590 tests in 28 files, production
  audit clean.
- Linux CI (fork): the same on Node 22 and 24, plus the container smoke test.
