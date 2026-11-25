# Deployment: the centralised MCP host

How to run this server on ECMSI's shared MCP VM (Ubuntu 24.04, Docker, one host-level Caddy) next
to the N-central server and whatever comes after it. The layout is deliberately boring: every MCP
server is its own compose project in its own directory, published on its own loopback port, and
Caddy is the only thing that listens on the network. Adding a server never touches another one.

## Layout

```
/opt/mcp/
├── ncentral/              compose project, .env          -> 127.0.0.1:3100
├── connectwise/           compose project, .env          -> 127.0.0.1:3101   (this server)
└── <next>/                                                -> 127.0.0.1:3102
/etc/caddy/
├── Caddyfile              global options + import /etc/caddy/sites/*.caddy
└── sites/
    ├── ncentral-mcp.caddy       cw-mcp.example.com   -> 127.0.0.1:3100
    └── connectwise-mcp.caddy    cw-mcp.example.com   -> 127.0.0.1:3101
```

| Property | Value |
|---|---|
| Host port | `127.0.0.1:3101` (container port 8080) |
| Hostname | `cw-mcp.<your domain>` (one name per server; see "Path-based routing" for the alternative) |
| Endpoint clients use | `https://cw-mcp.<your domain>/mcp` |
| Client auth | `Authorization: Bearer <MCP_BEARER_TOKEN>` |
| Default write mode | `read-only` |

## Rules that apply to every server on the host

- **One dedicated API member per server.** For ConnectWise: System > Members > API Members, a member
  of its own with the narrowest security role that covers the tools in use, API keys generated for it,
  and a Client ID from the ConnectWise developer portal. Everything that member can read, the model
  can read.
- **Start read-only.** `CW_WRITE_MODE=read-only` is the default. Set `write` only when a task needs it,
  and read [the write-mode note](#write-mode) first.
- **Secrets live in one `.env` per server**, mode 600, owned by root, loaded by compose with
  `env_file`. They never go in a client config, a compose file, a Caddy file or a shell history.
- **The container speaks plain HTTP on loopback.** Caddy terminates TLS. Never publish a container
  port on `0.0.0.0`.
- **Pin what you deploy.** Check out a tag (`v2.0.0`), build from it, and record the commit.
- **One replica per server.** Rate limits and the time-entry lock are in process memory.

## Prerequisites

- Docker Engine 24 or newer with the Compose plugin.
- Caddy 2 installed from the Caddy apt repository and running as a service
  (`/etc/caddy/Caddyfile` imports `/etc/caddy/sites/*.caddy`; see `deploy/caddy/Caddyfile.example`).
- A DNS record for the server's hostname pointing at the VM, and outbound HTTPS from the VM to the
  ConnectWise API region and to GitHub.

## Install

```bash
sudo mkdir -p /opt/mcp/connectwise && cd /opt/mcp/connectwise
sudo git clone --branch v2.0.0 https://github.com/ecmsi/connectwise-manage-mcp.git src
sudo cp src/docker-compose.yml compose.yml
sudo cp src/.env.example .env
sudo chmod 600 .env
```

Edit `compose.yml` so `build.context` is `./src` (the checkout) and leave the rest. Edit `.env`:

```
CW_MANAGE_COMPANY_ID=<company id>
CW_MANAGE_PUBLIC_KEY=<api member public key>
CW_MANAGE_PRIVATE_KEY=<api member private key>
CW_MANAGE_CLIENT_ID=<developer portal client id>
CW_MANAGE_URL=https://api-na.myconnectwise.net
CW_WRITE_MODE=read-only
MCP_BEARER_TOKEN=<output of: openssl rand -hex 32>
```

Then:

```bash
sudo docker compose build
sudo docker compose up -d
sudo docker compose ps            # "healthy" within about 30 seconds
curl -s http://127.0.0.1:3101/health
```

The last command prints `{"status":"ok"}`. The container's own log shows the mode it started in:

```bash
sudo docker compose logs --tail 20
# ... HTTP client authentication: bearer token
# ... Write mode: read-only; rate limit: 120/min per client (X-Forwarded-For trusted)
```

## Put it behind Caddy

```bash
sudo cp src/deploy/caddy/connectwise-mcp.caddy /etc/caddy/sites/
sudo sed -i 's/cw-mcp.example.com/cw-mcp.<your domain>/' /etc/caddy/sites/connectwise-mcp.caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The snippet forwards only `/mcp` and `/health`, adds the usual security headers, and logs to
`/var/log/caddy/connectwise-mcp.log`. Caddy obtains and renews the certificate itself when the name is
publicly resolvable; for an internal name, add a `tls` directive pointing at the internal CA or
certificate files.

Verify from outside the VM:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cw-mcp.<your domain>/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'          # 401
curl -s -X POST https://cw-mcp.<your domain>/mcp \
  -H "authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300   # tools
```

### Path-based routing

If one hostname for the whole host is preferred (`mcp.<domain>/connectwise/mcp`), use
`handle_path /connectwise/* { reverse_proxy 127.0.0.1:3101 }` inside a single site block;
`handle_path` strips the prefix so the container still sees `/mcp`. The server never emits absolute
URLs in this configuration, so either scheme works. Keep one scheme per host.

## Connect clients

Claude Code:

```bash
claude mcp add --transport http connectwise https://cw-mcp.<your domain>/mcp \
  --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

`.mcp.json` (project) or Claude Desktop's config, equivalently:

```json
{
  "mcpServers": {
    "connectwise": {
      "type": "http",
      "url": "https://cw-mcp.<your domain>/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

claude.ai custom connectors: use the same URL and bearer token, the same way the N-central connector
is configured. After a container recreate, clients reconnect on their own: the server is stateless
(no session ids), so there is no stale-session case.

Then run `cw_test_connection` once from a client; it reads `/system/info` and proves the API member
and client id work.

## Operate

```bash
cd /opt/mcp/connectwise
sudo docker compose logs -f --tail 100     # one JSON line per tool call and per auth failure
sudo docker compose up -d                  # after editing .env (restart keeps the old environment)
```

Log lines to know:

| Line | Meaning |
|---|---|
| `{"event":"tool_call","tool":"cw_search_tickets","ok":true,"ms":412}` | A tool ran. Arguments and results are never logged. |
| `{"event":"http_auth_failed","ip":"203.0.113.5","reason":"bearer"}` | Wrong or missing token. Repeated lines from one address are what the rate limiter answers with 429. |
| `{"event":"http_rate_limited",...}` | A client passed `MCP_RATE_LIMIT_PER_MINUTE`. |
| `{"event":"connectwise_request_failed","status":403,"reference":"..."}` | ConnectWise refused a call; the tool result carries the same reference and names the missing security-role permission. |

Rotate the bearer token by setting a new `MCP_BEARER_TOKEN`, `docker compose up -d`, then updating
every client. Rotate the API keys in ConnectWise the same way (the API member's keys, then `.env`).

## Update

```bash
cd /opt/mcp/connectwise/src
sudo git fetch --tags
sudo git diff v2.0.0 v2.0.1 --stat     # read the diff before moving the pin
sudo git checkout v2.0.1
cd .. && sudo docker compose build && sudo docker compose up -d
curl -s http://127.0.0.1:3101/health
```

Rolling back is the same procedure with the previous tag. If code is ever pulled in from the
original project this one was derived from, treat it as a new review: re-check `src/index.ts`,
`src/http-auth.ts`, `src/tool-policy.ts`, `src/api-client.ts` and any new `fetch` call or
environment variable.

## Write mode

Read-only leaves 63 tools: every `cw_get_*`, `cw_search_*`, `cw_list_*` and `cw_test_connection`.
Write mode adds 26 tools that create, update or delete tickets, notes, time entries, schedule
entries, contacts, companies, projects, activities, catalog items, agreement additions, invoices and
inventory adjustments.

The reason the default is read-only is not the model: ticket notes, descriptions and contact fields
are written by customers and arrive by email. Text the model reads can try to instruct it. In
read-only mode an injected instruction cannot change PSA data, because the tools that would do it do
not exist in the process. If a workflow needs writes, give it its own server directory and `.env`
with `CW_WRITE_MODE=write`, a different bearer token, an API member whose security role allows only
those writes, and treat model-proposed changes as suggestions to verify.

## Without Docker

For a host where Docker is not wanted, run the checkout under systemd with the unit in
`deploy/systemd/connectwise-mcp.service`:

```bash
sudo useradd --system --home /opt/connectwise-mcp --shell /usr/sbin/nologin connectwise-mcp
sudo mkdir -p /opt/connectwise-mcp && cd /opt/connectwise-mcp
sudo git clone --branch v2.0.0 https://github.com/ecmsi/connectwise-manage-mcp.git app
cd app && sudo npm ci --ignore-scripts && sudo npm run build && sudo npm prune --omit=dev
sudo cp .env.example ../.env && sudo chmod 600 ../.env
sudo chown -R connectwise-mcp:connectwise-mcp /opt/connectwise-mcp
sudo cp deploy/systemd/connectwise-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now connectwise-mcp
```

In that `.env`, also set `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=127.0.0.1`, `MCP_HTTP_PORT=3101` and
`MCP_TRUST_PROXY=1`. Node.js 22 or newer must be installed. The Caddy snippet is unchanged.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Container exits at once, log says `Refusing to start HTTP transport` | `MCP_BEARER_TOKEN` empty, shorter than 32 characters, or a placeholder | Generate one with `openssl rand -hex 32`, then `docker compose up -d` |
| Log says `CW_WRITE_MODE must be "read-only" or "write"` | Typo in `.env` | Fix the value; the server refuses to guess |
| `401` from every client call | Token mismatch, or the client sends it as something other than `Authorization: Bearer` | Compare the client header with `.env`; auth failures are logged with the client address |
| `429` for one client | More than `MCP_RATE_LIMIT_PER_MINUTE` requests in a minute from one address | Raise the limit in `.env`, or check whether several users share an egress address |
| Every request is rate limited as one client | `MCP_TRUST_PROXY` unset behind Caddy, so all traffic looks like the bridge address | The compose file sets `MCP_TRUST_PROXY=1`; keep it |
| First tool call returns `403` and names a permission | The API member's security role lacks that module | Grant it under System > Security Roles; the error says which |
| Tool call returns `returned a redirect (HTTP 301)` | `CW_MANAGE_URL` is not the canonical origin | Set it to the URL the server redirects to |
| A write tool is "not found" | `CW_WRITE_MODE=read-only` | Intended; see "Write mode" |
