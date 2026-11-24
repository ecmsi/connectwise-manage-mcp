/**
 * Write-mode gating and audit logging.
 *
 * Read-only mode must leave write tools out of the server entirely, and the
 * name-based classification must agree with what each handler actually does:
 * a read-named tool may only issue GET requests. The source scan at the end
 * enforces that for every tool module.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../mcp-server.js";
import {
  DEFAULT_WRITE_MODE,
  isReadOnlyToolName,
  isToolAllowed,
  resolveWriteMode,
  type ToolAuditEntry,
} from "../tool-policy.js";

const config = {
  baseUrl: "https://cw.example.invalid",
  companyId: "acme",
  publicKey: "pub",
  privateKey: "priv",
  clientId: "client-1",
};

/** The catalog as counted by the source scan below. Change deliberately. */
const EXPECTED_TOTAL_TOOLS = 89;
const EXPECTED_READ_TOOLS = 63;

async function listToolNames(writeMode: "read-only" | "write", audit?: (e: ToolAuditEntry) => void) {
  const server = createMcpServer(config, { writeMode, audit: audit ?? null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return { server, client, names: tools.map((t) => t.name).sort() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveWriteMode", () => {
  it("defaults to read-only", () => {
    expect(DEFAULT_WRITE_MODE).toBe("read-only");
    expect(resolveWriteMode(undefined)).toBe("read-only");
    expect(resolveWriteMode("")).toBe("read-only");
    expect(resolveWriteMode("  ")).toBe("read-only");
  });

  it("accepts the two modes and their obvious spellings", () => {
    for (const v of ["read-only", "READ-ONLY", "readonly", "read_only"]) expect(resolveWriteMode(v)).toBe("read-only");
    for (const v of ["write", "Write", "full", "read-write"]) expect(resolveWriteMode(v)).toBe("write");
  });

  it("refuses anything else so a typo cannot change the catalog silently", () => {
    expect(() => resolveWriteMode("rw")).toThrow(/CW_WRITE_MODE/);
    expect(() => resolveWriteMode("true")).toThrow(/CW_WRITE_MODE/);
  });
});

describe("classification", () => {
  it("treats get/search/list/test as reads and everything else as writes", () => {
    for (const n of ["cw_get_ticket", "cw_search_tickets", "cw_list_boards", "cw_test_connection"]) {
      expect(isReadOnlyToolName(n)).toBe(true);
      expect(isToolAllowed(n, "read-only")).toBe(true);
    }
    for (const n of ["cw_create_ticket", "cw_update_ticket", "cw_delete_time_entry", "cw_add_ticket_note", "cw_close_adjustment", "cw_bundle_tickets", "cw_frobnicate"]) {
      expect(isReadOnlyToolName(n)).toBe(false);
      expect(isToolAllowed(n, "read-only")).toBe(false);
      expect(isToolAllowed(n, "write")).toBe(true);
    }
  });
});

describe("createMcpServer write mode", () => {
  it("read-only lists only read tools and the write tools do not exist", async () => {
    const { server, client, names } = await listToolNames("read-only");
    expect(names).toHaveLength(EXPECTED_READ_TOOLS);
    expect(names.every(isReadOnlyToolName)).toBe(true);
    expect(names).toContain("cw_get_ticket");
    expect(names).not.toContain("cw_create_ticket");
    expect(server.skippedTools).toHaveLength(EXPECTED_TOTAL_TOOLS - EXPECTED_READ_TOOLS);
    expect(server.registeredTools).toHaveLength(EXPECTED_READ_TOOLS);

    // A call to a withheld tool is "unknown tool", not a policy refusal from a
    // registered handler: the handler was never installed.
    const refused = await client.callTool({ name: "cw_create_ticket", arguments: { summary: "x" } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/not found|unknown/i);
    await client.close();
  });

  it("write registers the full catalog", async () => {
    const { server, client, names } = await listToolNames("write");
    expect(names).toHaveLength(EXPECTED_TOTAL_TOOLS);
    expect(names).toContain("cw_create_ticket");
    expect(server.skippedTools).toEqual([]);
    await client.close();
  });

  it("reads CW_WRITE_MODE when no option is passed", () => {
    vi.stubEnv("CW_WRITE_MODE", "read-only");
    expect(createMcpServer(config, { audit: null }).writeMode).toBe("read-only");
    vi.stubEnv("CW_WRITE_MODE", "write");
    expect(createMcpServer(config, { audit: null }).writeMode).toBe("write");
    vi.stubEnv("CW_WRITE_MODE", "");
    expect(createMcpServer(config, { audit: null }).writeMode).toBe("read-only");
  });

  it("applies to the no-credentials diagnostic server too", () => {
    const server = createMcpServer(undefined, { writeMode: "read-only", audit: null });
    // getConfig() reads process.env; the suite does not set CW_MANAGE_*.
    expect(server.registeredTools).toEqual(["cw_test_connection"]);
  });
});

describe("audit hook", () => {
  it("records the tool name, outcome and duration, never the arguments", async () => {
    const entries: ToolAuditEntry[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
      json: () => Promise.resolve({ version: "2026.1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = await listToolNames("write", (e) => entries.push(e));
    await client.callTool({ name: "cw_get_ticket_notes", arguments: { id: 424242 } });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: "cw_get_ticket_notes", ok: true });
    expect(typeof entries[0].ms).toBe("number");
    expect(JSON.stringify(entries[0])).not.toContain("424242");
    await client.close();
  });

  it("reports isError results and thrown errors as not ok", async () => {
    const entries: ToolAuditEntry[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") }),
    );
    const { client } = await listToolNames("write", (e) => entries.push(e));
    const result = await client.callTool({ name: "cw_get_ticket_notes", arguments: { id: 1 } });
    expect(result.isError).toBe(true);
    expect(entries[0]).toMatchObject({ tool: "cw_get_ticket_notes", ok: false });
    await client.close();
  });

  it("writes one JSON line to stderr by default", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("[]"), json: () => Promise.resolve([]) }),
    );
    const server = createMcpServer(config, { writeMode: "write" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "cw_list_boards", arguments: {} });
    const audit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o?.event === "tool_call");
    expect(audit).toMatchObject({ event: "tool_call", tool: "cw_list_boards", ok: true });
    await client.close();
  });
});

describe("tool sources agree with the classification", () => {
  const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tools");

  interface Scanned { name: string; file: string; methods: string[] }

  function scan(): Scanned[] {
    const rows: Scanned[] = [];
    for (const file of readdirSync(toolsDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(path.join(toolsDir, file), "utf8");
      const re = /server\.(?:tool|registerTool)\(\s*"(cw_[a-z_]+)"/g;
      const starts: Array<{ name: string; at: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
      starts.forEach((t, i) => {
        const chunk = src.slice(t.at, starts[i + 1]?.at ?? src.length);
        const methods = new Set<string>();
        for (const mm of chunk.matchAll(/client\.(get|post|patch|delete|request)\b/g)) methods.add(mm[1]);
        for (const mm of chunk.matchAll(/request\(\s*"(GET|POST|PATCH|PUT|DELETE)"/g)) methods.add(mm[1].toLowerCase());
        rows.push({ name: t.name, file, methods: [...methods] });
      });
    }
    return rows;
  }

  it("every tool is named with a known verb, and read-named tools only GET", () => {
    const rows = scan();
    expect(rows).toHaveLength(EXPECTED_TOTAL_TOOLS);
    const reads = rows.filter((r) => isReadOnlyToolName(r.name));
    expect(reads).toHaveLength(EXPECTED_READ_TOOLS);

    const offenders = reads.filter((r) => r.methods.some((mth) => mth !== "get"));
    expect(offenders, "read-named tools that issue a non-GET request").toEqual([]);

    // Helper-based tools show no direct client call in their own chunk; they
    // must be reads that delegate to the GET-only helpers.
    const indirect = reads.filter((r) => r.methods.length === 0).map((r) => r.name).sort();
    expect(indirect).toEqual([
      "cw_get_inventory_on_hand",
      "cw_get_project_product_status",
      "cw_get_project_purchase_order_lines",
    ]);

    const unknownVerb = rows.filter((r) => !/^cw_(get|search|list|test|create|update|delete|add|close|bundle)_/.test(r.name));
    expect(unknownVerb.map((r) => r.name), "tools whose verb is not in the known set").toEqual([]);
  });

  it("the read-only helpers in procurement and project-procurement never write", () => {
    for (const file of ["procurement.ts", "project-procurement.ts"]) {
      const src = readFileSync(path.join(toolsDir, file), "utf8");
      // Everything before the first tool registration is shared helper code.
      const helpers = src.slice(0, src.search(/server\.(?:tool|registerTool)\(/));
      expect(helpers).not.toMatch(/client\.(post|patch|delete)\b/);
    }
  });
});
