# Changelog

## [Unreleased]

### Changed

- **Independent project.** This server is now maintained by ECMSI on its own, decoupled from the
  project it was derived from. The package is `@ecmsi/connectwise-manage-mcp`; author, repository
  and bundle metadata point at ECMSI; a `NOTICE` file carries the attribution the Apache-2.0 license
  requires; `docs/ORIGIN.md` records the point of divergence.
- **`CONDUIT_S2S_SECRET` is now `MCP_S2S_SECRET`.** Same semantics: HMAC secret for the
  `X-Gateway-S2S` header, placeholder values refused, required for `AUTH_MODE=gateway`. Anyone
  using the signed-gateway mechanism must rename the variable.
- Removed files that belonged to the original project's own publishing and hosting: the
  DigitalOcean app template, the MCP registry `server.json` and `glama.json`, the Azure Container
  Apps guide, the Copilot review instructions, the issue-template contact links, and the
  semantic-release configuration and dev dependencies. With those dev dependencies gone, `npm audit`
  is clean for the full tree as well as for production.
- Tests that were named after the original project's issue tracker are renamed after what they test.
- Dependabot and CODEOWNERS rewritten for this repository.

## [1.4.0-ecmsi.1] - 2026-11-24

First ECMSI release, based on the original project at commit `bb2a907`. See
[docs/ORIGIN.md](docs/ORIGIN.md) for the reasoning behind each item and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the shared-host layout.

### Security

- **`MCP_BEARER_TOKEN` authenticates direct clients on its own.** HTTP refuses to start unless a
  bearer token, a gateway S2S secret or `MCP_OAUTH_ENABLED=true` is configured (or
  `MCP_ALLOW_INSECURE_DEV=1`, loopback only). Every configured mechanism is enforced on `/mcp`. Tokens
  shorter than 32 characters or on the placeholder list are refused at startup. `AUTH_MODE=gateway`
  still requires the S2S secret.
- **`CW_WRITE_MODE=read-only` is the default** and registers only the 63 `get`/`search`/`list`/`test`
  tools. `write` registers all 89. Withheld tools are not listed and cannot be called. A test scans
  every tool source and fails if a read-named tool issues anything but GET.
- **Per-call audit line** on stderr: tool name, outcome, duration. Never arguments or results.
  Authentication failures and rate-limit hits are logged with the client address and reason.
- **Rate limiting** per client address, `MCP_RATE_LIMIT_PER_MINUTE` (default 120, 0 disables).
  `MCP_TRUST_PROXY=1` reads `X-Forwarded-For`.
- **`/health` returns only `{"status":"ok"}`**; `/healthz` is an alias.
- **Redirects are refused in env mode too.** `CW_MANAGE_URL` must be the canonical origin.
- **`CW_MANAGE_REJECT_UNAUTHORIZED=false` logs a security warning** and points at `NODE_EXTRA_CA_CERTS`.
- **Lockfile refreshed** within declared ranges: `@modelcontextprotocol/sdk` 1.32.2, `undici` 8.13.1,
  `zod` 4.6.7, `qs` 6.17.1. `npm audit --omit=dev` reports nothing.

### Changed

- One read-only CI workflow (`.github/workflows/ci.yml`) replaces the original project's
  organisation-level workflows: lint, typecheck, build, tests on Node 22 and 24, production audit,
  container smoke test.
- `docker-compose.yml` is single-tenant env mode on `127.0.0.1:3101` with a read-only root, no
  capabilities and a memory cap. The standalone Caddy compose file is replaced by `deploy/caddy/`
  (site snippet for a shared host Caddy) and `deploy/systemd/` (hardened unit).
- `.env.example` rewritten. `npm run check` runs the full local gate.

## Earlier history

Everything before 2026-11-24 is the history of the original project, the ConnectWise Manage MCP
Server by WYRE Technology, up to commit `bb2a9077612b84d535af3cffe1ce97ad0128202d`. Its changelog
to that point is at
<https://github.com/WYRE-AI/connectwise-manage-mcp/blob/bb2a9077612b84d535af3cffe1ce97ad0128202d/CHANGELOG.md>
and is not reproduced here.
