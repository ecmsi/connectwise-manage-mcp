import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { findPermissionGaps, type PermissionReport, type SecurityRow } from "../permission-matrix.js";

const MY_SECURITY_PAGE_SIZE = 1000;

/** Every row of GET /system/mySecurity for the authenticated API member. */
export async function fetchMySecurity(client: CwManageClient): Promise<SecurityRow[]> {
  const rows: SecurityRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await client.get<SecurityRow[]>("/system/mySecurity", {
      page,
      pageSize: MY_SECURITY_PAGE_SIZE,
      fields: "moduleName,moduleIdentifier,moduleFunctionName,moduleFunctionIdentifier,addLevel,editLevel,deleteLevel,inquireLevel",
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < MY_SECURITY_PAGE_SIZE) break;
  }
  return rows;
}

/** A short human-readable summary of a permission report. */
export function summarizePermissionReport(report: PermissionReport): string {
  const lines: string[] = [];
  lines.push(
    `Write mode ${report.mode}: ${report.satisfied} of ${report.checked} required permission levels granted at All; ${report.gaps.length} gap(s).`,
  );
  for (const g of report.gaps) {
    const have = g.have === "missing" ? "no row with that name" : `currently ${g.have}`;
    lines.push(`- ${g.module} > ${g.func}: ${g.level} must be All (${have}). Needed by ${g.tools.join(", ")}.`);
    if (g.candidates?.length) lines.push(`  Rows in that module: ${g.candidates.join(" | ")}`);
  }
  if (report.tablesToAllow.length) {
    lines.push(
      `System > Table Setup tables to allow (not visible through mySecurity, verify on the role): ${report.tablesToAllow.join("; ")}.`,
    );
  }
  return lines.join("\n");
}

export function registerHealthTools(
  server: McpServer,
  client: CwManageClient,
  writeMode: "read-only" | "write" = "read-only",
) {
  server.tool(
    "cw_test_connection",
    "Test the connection to ConnectWise Manage by fetching system info. Returns API version and licensing details.",
    {},
    async () => {
      const result = await client.get("/system/info");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_my_permissions",
    "Read the API member's effective ConnectWise security permissions (GET /system/mySecurity) and compare them with what this server's tools need for a write mode (default: the mode the server is running in). Reports each module > function whose Add/Edit/Delete/Inquire level is not All, which tools that blocks, and the System > Table Setup tables the role must allow. Needs no permission itself. Use it after creating or changing the API member's security role.",
    {
      writeMode: z
        .enum(["read-only", "write"])
        .optional()
        .describe("Which tool set to check against. Defaults to the server's current write mode."),
      includeRows: z
        .boolean()
        .optional()
        .describe("Also return every permission row the member has (module, function, four levels). Default false."),
    },
    async ({ writeMode: requested, includeRows }) => {
      const mode = requested ?? writeMode;
      const rows = await fetchMySecurity(client);
      const report = findPermissionGaps(rows, mode);
      const structuredContent: Record<string, unknown> = { ...report, rowCount: rows.length };
      if (includeRows) {
        structuredContent.rows = rows.map((r) => ({
          module: r.moduleName,
          func: r.moduleFunctionName,
          add: r.addLevel,
          edit: r.editLevel,
          delete: r.deleteLevel,
          inquire: r.inquireLevel,
        }));
      }
      // Gaps are a finding, not a failure: the call itself succeeded.
      return {
        content: [{ type: "text", text: summarizePermissionReport(report) }],
        structuredContent,
      };
    },
  );
}
