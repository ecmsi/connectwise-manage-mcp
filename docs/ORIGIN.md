# Origin

This project began on 2026-11-24 as a copy of the
[ConnectWise Manage MCP Server by WYRE Technology](https://github.com/WYRE-AI/connectwise-manage-mcp)
at commit `bb2a9077612b84d535af3cffe1ce97ad0128202d`, taken under the Apache License 2.0. From
that point it has been maintained by ECMSI as an independent project: its own versioning, its own CI,
its own deployment layout, and no tracking of the original repository. It is not affiliated with or
endorsed by the original authors; the attribution the license requires is in [NOTICE](../NOTICE).

The original was written around a hosted gateway product that signed every request with an HMAC
header no direct MCP client can produce. ECMSI's requirement was the opposite shape: one shared
Ubuntu host, one Caddy terminating TLS, one container per MCP server, and Claude Code, Claude
Desktop and claude.ai connecting directly with a bearer token. Everything in the table follows from
closing that gap and from the security review done at the point of divergence.

| Area | Original | This project | Why |
|---|---|---|---|
| HTTP authentication | A gateway HMAC secret was mandatory; `MCP_BEARER_TOKEN` worked only inside the Entra OAuth flow. | `MCP_BEARER_TOKEN` is a first-class mechanism: constant-time compared, 32-character minimum, placeholder list, `WWW-Authenticate` on failure. Startup refuses to listen unless a bearer token, `MCP_S2S_SECRET` or OAuth is configured. Every configured mechanism is enforced. `AUTH_MODE=gateway` still requires `MCP_S2S_SECRET`. | No gateway product in front of this server. Without this, the only way to run HTTP was `MCP_ALLOW_INSECURE_DEV=1`, which is no authentication at all. |
| Write mode | All 89 tools always registered. | `CW_WRITE_MODE=read-only` (default) registers the 63 `get`/`search`/`list`/`test` tools; `write` registers all. Gated at registration (`src/tool-policy.ts`), so withheld tools are not listed and cannot be called. A test scans every tool source and fails if a read-named tool issues anything but GET. | Ticket notes and descriptions are written by customers over email. Text the model reads can try to instruct it; with no write tools present, an injected instruction cannot change PSA data. |
| Audit log | Per-request line only in OAuth mode. | One JSON line per tool call on stderr: tool name, outcome, duration. Never arguments or results. Auth failures and rate-limit hits are logged with the client address and reason. | A shared host needs to answer "what did the model do" without logging PSA data. |
| Rate limiting | None. | Fixed-window per-client limiter, `MCP_RATE_LIMIT_PER_MINUTE` (default 120, 0 disables), bounded table. `MCP_TRUST_PROXY=1` reads `X-Forwarded-For`. | Bearer tokens are brute-forceable without a cap; the limiter also bounds the cost of the per-request server construction. |
| Health endpoint | Returned the auth mode, OAuth flag and a timestamp. | Returns `{"status":"ok"}` only; `/healthz` alias. | It is unauthenticated. |
| Redirects | Followed in env mode. | Refused in every mode. | `fetch` keeps the custom `clientId` header and a 307/308 body across a redirect. `CW_MANAGE_URL` must be the canonical origin. |
| Relaxed TLS | `CW_MANAGE_REJECT_UNAUTHORIZED=false` was silent. | Logs a security warning once and points at `NODE_EXTRA_CA_CERTS`. | Disabling verification exposes the API keys to interception. |
| Error logging | Whole error objects for transport and OAuth proxy errors. | Error class names only. | Error causes can carry request detail. |
| Dependencies | Production tree carried 8 advisories (SDK 1.31.0, undici 8.11.2, zod 4.3.6, qs). Dev tree carried the semantic-release toolchain. | Lockfile refreshed within declared ranges: SDK 1.32.2, undici 8.13.1, zod 4.6.7, qs 6.17.1. semantic-release removed. `npm audit` is clean for production and for the full tree, and CI enforces the production audit. | Two of the advisories were reachable on the request path (SDK memory exhaustion, undici TLS option bypass in `Agent`). |
| CI | Four workflows called reusable workflows in the original organisation with `secrets: inherit`, including a Claude Code action with `contents: write` triggered by issue comments. | One read-only workflow: lint, typecheck, build, tests on Node 22 and 24, production audit, and a container smoke test that proves the image refuses to start without auth, answers 401 without the token, and withholds write tools in read-only mode. | No third-party pipeline and no write-scoped token in this repository. |
| Deployment | A gateway-mode compose file and a second compose file running a dedicated Caddy container on 80/443; DigitalOcean, Cloudflare and Azure Container Apps templates and guides. | `docker-compose.yml` is single-tenant env mode, published on `127.0.0.1:3101`, read-only root, no capabilities, memory cap. `deploy/caddy/` holds a site snippet for the host's shared Caddy; `deploy/systemd/` a hardened unit for a non-Docker install. `docs/DEPLOYMENT.md` describes the shared-host layout. The DigitalOcean template, registry metadata and Azure guide are removed; the Cloudflare Worker entry point remains. | One Caddy per host, one port per MCP server. |
| Naming | `@wyre-ai/connectwise-manage-mcp`, `CONDUIT_S2S_SECRET`, tests named after the original issue tracker. | `@ecmsi/connectwise-manage-mcp`, `MCP_S2S_SECRET`, tests named after what they test. | An independent project with its own vocabulary. |
| Repository hygiene | The original project's CODEOWNERS, release and project automation, Copilot instructions. | `.gitattributes` normalises line endings; CODEOWNERS and Dependabot are this repository's; `npm run check` is the local gate. | Windows and Linux checkouts hash the same; no stray review requests to people outside ECMSI. |

Kept as inherited: the tool implementations and their tests, the ConnectWise client with its error
sanitisation and SSRF guard, the interactive ticket card, the Entra OAuth routes and the Cloudflare
Worker entry point. The Worker honours `CW_WRITE_MODE` from its binding and defaults to read-only
like every other entry point.

## Verification at the point of divergence

- `npm run check` on Windows 11, Node 26.13.1: lint, typecheck, build, 590 tests in 28 files, audit
  clean.
- Linux CI: the same on Node 22 and 24, plus the container smoke test.
- The committed ticket-card bundle was rebuilt from the original sources and lockfile and compared
  byte for byte; it matched.
