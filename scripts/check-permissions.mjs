#!/usr/bin/env node
// Compare the API member's effective ConnectWise permissions with what the
// tools need, without starting the MCP server.
//
//   node --env-file=/opt/mcp/connectwise/.env scripts/check-permissions.mjs [--mode read-only|write] [--rows]
//
// Reads CW_MANAGE_* from the environment, calls GET /system/mySecurity, and
// prints the gaps. Exit code 1 when any required level is not "All". Build
// first (npm run build): this imports the compiled server code.
import { getConfig, CwManageClient } from "../dist/api-client.js";
import { fetchMySecurity, summarizePermissionReport } from "../dist/tools/health.js";
import { findPermissionGaps } from "../dist/permission-matrix.js";
import { resolveWriteMode } from "../dist/tool-policy.js";

const args = process.argv.slice(2);
const modeArg = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : undefined;
const showRows = args.includes("--rows");

const config = getConfig();
if (!config) {
  console.error("Missing CW_MANAGE_COMPANY_ID, CW_MANAGE_PUBLIC_KEY, CW_MANAGE_PRIVATE_KEY or CW_MANAGE_CLIENT_ID. Pass --env-file=<path to .env>.");
  process.exit(2);
}

let mode;
try {
  mode = resolveWriteMode(modeArg ?? process.env.CW_WRITE_MODE);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const client = new CwManageClient(config);
const rows = await fetchMySecurity(client);
const report = findPermissionGaps(rows, mode);

if (showRows) {
  console.log("module | function | add | edit | delete | inquire");
  for (const r of rows) {
    console.log(`${r.moduleName} | ${r.moduleFunctionName} | ${r.addLevel} | ${r.editLevel} | ${r.deleteLevel} | ${r.inquireLevel}`);
  }
  console.log("");
}
console.log(`API member has ${rows.length} permission rows.`);
console.log(summarizePermissionReport(report));
process.exit(report.gaps.length ? 1 : 0);
