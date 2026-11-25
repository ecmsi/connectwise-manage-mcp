/**
 * The permission matrix is the source of truth for the API member's role:
 * every registered tool must have an entry, every endpoint a tool calls must
 * exist in ConnectWise's published OpenAPI document, the generated doc must
 * be current, and the gap analysis must read mySecurity rows correctly.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../mcp-server.js";
import {
  TOOL_PERMISSIONS,
  findPermissionGaps,
  permissionsForTool,
  renderPermissionMatrixMarkdown,
  roleRecipe,
  type SecurityRow,
} from "../permission-matrix.js";
import { summarizePermissionReport } from "../tools/health.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const toolsDir = path.resolve(here, "../tools");

const config = { baseUrl: "https://cw.example.invalid", companyId: "acme", publicKey: "pub", privateKey: "priv", clientId: "c" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("matrix coverage", () => {
  it("has exactly one entry for every tool the server registers, and no extras", () => {
    const server = createMcpServer(config, { writeMode: "write", audit: null });
    const registered = [...server.registeredTools].sort();
    const listed = TOOL_PERMISSIONS.map((e) => e.tool).sort();
    expect(listed).toEqual(registered);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("read tools never require Add, Edit or Delete", () => {
    for (const e of TOOL_PERMISSIONS) {
      if (!/^cw_(get|search|list|test)_/.test(e.tool)) continue;
      for (const r of e.requires) expect(r.level, `${e.tool} ${r.module} > ${r.func}`).toBe("Inquire");
    }
  });

  it("the read-only recipe grants no Add, Edit or Delete anywhere", () => {
    for (const row of roleRecipe("read-only")) {
      expect(row.add || row.edit || row.delete, `${row.module} > ${row.func}`).toBe(false);
    }
    expect(roleRecipe("write").some((r) => r.add || r.edit || r.delete)).toBe(true);
  });

  it("docs/PERMISSION-MATRIX.md is generated from the current matrix", () => {
    const committed = readFileSync(path.join(root, "docs", "PERMISSION-MATRIX.md"), "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(renderPermissionMatrixMarkdown());
  });
});

describe("every endpoint a tool calls exists in the published OpenAPI document", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(root, "test", "fixtures", "connectwise-openapi-2026.11-paths.json"), "utf8"),
  ) as { version: string; paths: Record<string, Record<string, string>> };
  const norm = (p: string) => p.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "").toLowerCase();
  const index = new Map<string, string>();
  for (const [p, ops] of Object.entries(fixture.paths)) for (const [m, op] of Object.entries(ops)) index.set(`${norm(p)} ${m}`, op);

  it("fixture is the 2026.11 document with the known operation count", () => {
    expect(fixture.version).toBe("2026.11");
    const operations = Object.values(fixture.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
    expect(operations).toBe(3132);
  });

  it("resolves and finds every client call in src/tools", () => {
    const calls: Array<{ tool: string; method: string; path: string }> = [];
    for (const file of readdirSync(toolsDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(path.join(toolsDir, file), "utf8");
      // Resolve `const path = \`...\`` style locals so `${path}/${x}` calls can be checked.
      const locals = new Map<string, string>();
      for (const m of src.matchAll(/const\s+(\w+)\s*=\s*`([^`]*)`/g)) if (m[2].startsWith("/")) locals.set(m[1], m[2]);
      const re = /server\.(?:tool|registerTool)\(\s*"(cw_[a-z_]+)"/g;
      const starts: Array<{ name: string; at: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
      const chunks = [{ name: `helpers:${file}`, text: src.slice(0, starts[0]?.at ?? src.length) }];
      starts.forEach((t, i) => chunks.push({ name: t.name, text: src.slice(t.at, starts[i + 1]?.at ?? src.length) }));
      const callRe = /client\.(get|post|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*(`[^`]*`|"[^"]*")/g;
      for (const c of chunks) {
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(c.text))) {
          let p = cm[2].slice(1, -1);
          p = p.replace(/\$\{(\w+)\}/g, (whole, name: string) => locals.get(name) ?? whole);
          p = p.replace(/\$\{[^}]+\}/g, "{}").split("?")[0];
          calls.push({ tool: c.name, method: cm[1], path: p });
        }
      }
    }
    expect(calls.length).toBeGreaterThan(85);
    const missing = calls.filter((c) => !index.has(`${norm(c.path)} ${c.method}`));
    expect(missing, "tool calls with no matching path+method in the OpenAPI document").toEqual([]);
    expect(index.has("/system/mysecurity get")).toBe(true);
  });
});

describe("gap analysis against mySecurity rows", () => {
  const row = (moduleName: string, moduleFunctionName: string, levels: Partial<SecurityRow> = {}): SecurityRow => ({
    moduleName,
    moduleFunctionName,
    addLevel: "None",
    editLevel: "None",
    deleteLevel: "None",
    inquireLevel: "None",
    ...levels,
  });

  it("reports nothing when every required level is All", () => {
    const rows = roleRecipe("write").map((r) =>
      row(r.module, r.func, { addLevel: "All", editLevel: "All", deleteLevel: "All", inquireLevel: "All" }),
    );
    const report = findPermissionGaps(rows, "write");
    expect(report.gaps).toEqual([]);
    expect(report.satisfied).toBe(report.checked);
    expect(report.tablesToAllow).toContain("Service / Priority");
  });

  it("flags My and None, names a missing row and lists candidates, and ignores punctuation and case", () => {
    const rows: SecurityRow[] = [
      row("Companies", "Company Maintenance", { inquireLevel: "All" }),
      row("companies", "crm / sales activities", { inquireLevel: "All" }),
      row("Service Desk", "Service Tickets", { inquireLevel: "My" }),
      row("Service Desk", "Close Service Tickets", { inquireLevel: "All" }),
    ];
    const report = findPermissionGaps(rows, "read-only");
    const byKey = (m: string, f: string) => report.gaps.find((g) => g.module === m && g.func === f);
    expect(byKey("Companies", "Company Maintenance")).toBeUndefined();
    expect(byKey("Companies", "CRM/Sales Activities")).toBeUndefined();
    expect(byKey("Service Desk", "Service Tickets")?.have).toBe("My");
    const missing = byKey("Service Desk", "Resource Scheduling");
    expect(missing?.have).toBe("missing");
    expect(missing?.candidates).toEqual(["Service Tickets", "Close Service Tickets"]);
    expect(byKey("Finance", "Agreements")?.have).toBe("missing");
    expect(byKey("Service Desk", "Service Tickets")?.tools).toContain("cw_search_tickets");
  });

  it("the summary names each gap and the tables to allow", () => {
    const report = findPermissionGaps([], "read-only");
    const text = summarizePermissionReport(report);
    expect(text).toContain("Write mode read-only");
    expect(text).toContain("Companies > Company Maintenance: Inquire must be All (no row with that name)");
    expect(text).toContain("Table Setup tables to allow");
  });

  it("the write recipe needs Delete only on Time Entry", () => {
    const deletes = roleRecipe("write").filter((r) => r.delete);
    expect(deletes.map((r) => `${r.module} > ${r.func}`)).toEqual(["Time & Expense > Time Entry"]);
    expect(permissionsForTool("cw_delete_time_entry")?.requires[0].level).toBe("Delete");
  });
});

describe("cw_get_my_permissions tool", () => {
  async function connect(writeMode: "read-only" | "write") {
    const server = createMcpServer(config, { writeMode, audit: null });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await server.connect(st);
    await client.connect(ct);
    return client;
  }

  it("is a read tool, pages through mySecurity, and reports gaps for the running mode", async () => {
    const pages: SecurityRow[][] = [[{ moduleName: "Companies", moduleFunctionName: "Company Maintenance", inquireLevel: "All" }], []];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        const body = pages.shift() ?? [];
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
      }),
    );
    const client = await connect("read-only");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("cw_get_my_permissions");

    const result = await client.callTool({ name: "cw_get_my_permissions", arguments: {} });
    expect(urls[0]).toMatch(/\/system\/mySecurity\?.*pageSize=1000/);
    const report = result.structuredContent as { mode: string; gaps: Array<{ module: string; func: string }>; rowCount: number };
    expect(report.mode).toBe("read-only");
    expect(report.rowCount).toBe(1);
    expect(report.gaps.some((g) => g.module === "Companies" && g.func === "Company Maintenance")).toBe(false);
    expect(report.gaps.some((g) => g.module === "Service Desk" && g.func === "Service Tickets")).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Service Desk > Service Tickets: Inquire must be All");
    await client.close();
  });
});
