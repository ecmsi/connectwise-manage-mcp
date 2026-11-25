/**
 * The ConnectWise security-role permission each tool needs.
 *
 * This is the single source of truth for the least-privilege role. Three
 * things are generated from it:
 *
 * - docs/PERMISSION-MATRIX.md (scripts/generate-permission-matrix.mjs), the
 *   role recipe an administrator follows on System > Security Roles;
 * - the gap report of `cw_get_my_permissions` and
 *   scripts/check-permissions.mjs, which read the API member's effective
 *   permissions from GET /system/mySecurity and compare;
 * - a test that every registered tool has an entry.
 *
 * Module and function names are as they appear on the Security Roles screen
 * (Companies > Company Maintenance, Service Desk > Service Tickets, ...).
 * The endpoints behind each tool were checked against ConnectWise's published
 * OpenAPI document "Connectwise Manage Public Endpoints" 2026.11
 * (test/fixtures/connectwise-openapi-2026.11-paths.json). ConnectWise does
 * not publish a per-endpoint permission map, so the module/function for each
 * endpoint is the one its screen uses, confirmed where possible against
 * integration vendors' published matrices; the gap report against a live
 * tenant is the final word.
 *
 * Levels: a requirement names one of Add, Edit, Delete or Inquire, and the
 * role must grant it at "All". "My" restricts to records the member owns,
 * which an API member never does.
 *
 * This module has no imports and is side-effect free.
 */

export type PermissionLevel = "Add" | "Edit" | "Delete" | "Inquire";

export interface PermissionRequirement {
  /** Module heading on the Security Roles screen. */
  module: string;
  /** Function row under that module. */
  func: string;
  level: PermissionLevel;
  /** For System > Table Setup: the setup tables that must be allowed. */
  tables?: string[];
  /** Why, when it is not obvious from the tool name. */
  note?: string;
}

export interface ToolPermissionEntry {
  tool: string;
  requires: PermissionRequirement[];
}

const INQ = (module: string, func: string, extra: Partial<PermissionRequirement> = {}): PermissionRequirement => ({
  module,
  func,
  level: "Inquire",
  ...extra,
});
const ADD = (module: string, func: string, extra: Partial<PermissionRequirement> = {}): PermissionRequirement => ({
  module,
  func,
  level: "Add",
  ...extra,
});
const EDIT = (module: string, func: string, extra: Partial<PermissionRequirement> = {}): PermissionRequirement => ({
  module,
  func,
  level: "Edit",
  ...extra,
});
const DEL = (module: string, func: string, extra: Partial<PermissionRequirement> = {}): PermissionRequirement => ({
  module,
  func,
  level: "Delete",
  ...extra,
});

const TABLE = (tables: string[], note?: string): PermissionRequirement => ({
  module: "System",
  func: "Table Setup",
  level: "Inquire",
  tables,
  ...(note ? { note } : {}),
});

const COMPANIES = "Companies";
const SERVICE = "Service Desk";
const PROJECT = "Project";
const TIME = "Time & Expense";
const SALES = "Sales";
const FINANCE = "Finance";
const PROC = "Procurement";
const SYSTEM = "System";

/** Every tool the server registers, with what its ConnectWise calls need. */
export const TOOL_PERMISSIONS: readonly ToolPermissionEntry[] = [
  // Health / diagnostics
  { tool: "cw_test_connection", requires: [] },
  { tool: "cw_get_my_permissions", requires: [] },

  // Tickets
  { tool: "cw_search_tickets", requires: [INQ(SERVICE, "Service Tickets")] },
  { tool: "cw_get_ticket", requires: [INQ(SERVICE, "Service Tickets")] },
  { tool: "cw_get_ticket_notes", requires: [INQ(SERVICE, "Service Tickets")] },
  { tool: "cw_get_ticket_configurations", requires: [INQ(SERVICE, "Service Tickets"), INQ(COMPANIES, "Configurations")] },
  { tool: "cw_create_ticket", requires: [ADD(SERVICE, "Service Tickets")] },
  {
    tool: "cw_update_ticket",
    requires: [
      EDIT(SERVICE, "Service Tickets", {
        note: "Changing a ticket to a closed status also needs Service Desk > Close Service Tickets (Edit).",
      }),
    ],
  },
  { tool: "cw_add_ticket_note", requires: [EDIT(SERVICE, "Service Tickets")] },
  { tool: "cw_bundle_tickets", requires: [EDIT(SERVICE, "Service Tickets")] },
  { tool: "cw_update_ticket_configurations", requires: [EDIT(SERVICE, "Service Tickets"), INQ(COMPANIES, "Configurations")] },
  {
    tool: "cw_list_boards",
    requires: [INQ(SERVICE, "Service Tickets"), TABLE(["Service / Service Board"], "Board lists are a setup table in some tenants.")],
  },
  { tool: "cw_list_statuses", requires: [INQ(SERVICE, "Service Tickets"), TABLE(["Service / Service Board"])] },
  { tool: "cw_list_priorities", requires: [TABLE(["Service / Priority"])] },

  // Companies
  { tool: "cw_search_companies", requires: [INQ(COMPANIES, "Company Maintenance")] },
  { tool: "cw_get_company", requires: [INQ(COMPANIES, "Company Maintenance")] },
  { tool: "cw_list_company_sites", requires: [INQ(COMPANIES, "Company Maintenance")] },
  { tool: "cw_create_company", requires: [ADD(COMPANIES, "Company Maintenance")] },
  { tool: "cw_update_company", requires: [EDIT(COMPANIES, "Company Maintenance")] },

  // Contacts
  { tool: "cw_search_contacts", requires: [INQ(COMPANIES, "Contacts")] },
  { tool: "cw_get_contact", requires: [INQ(COMPANIES, "Contacts")] },
  {
    tool: "cw_create_contact",
    requires: [ADD(COMPANIES, "Contacts"), TABLE(["Company / Communication Type"], "Resolves the email and phone communication types.")],
  },
  { tool: "cw_update_contact", requires: [EDIT(COMPANIES, "Contacts")] },
  { tool: "cw_update_contact_types", requires: [EDIT(COMPANIES, "Contacts"), TABLE(["Company / Contact Type"])] },
  { tool: "cw_list_communication_types", requires: [TABLE(["Company / Communication Type"])] },

  // Configurations
  { tool: "cw_search_configurations", requires: [INQ(COMPANIES, "Configurations")] },
  { tool: "cw_get_configuration", requires: [INQ(COMPANIES, "Configurations")] },

  // Activities
  { tool: "cw_search_activities", requires: [INQ(COMPANIES, "CRM/Sales Activities")] },
  { tool: "cw_get_activity", requires: [INQ(COMPANIES, "CRM/Sales Activities")] },
  { tool: "cw_create_activity", requires: [ADD(COMPANIES, "CRM/Sales Activities")] },

  // Projects
  { tool: "cw_search_projects", requires: [INQ(PROJECT, "Project Headers")] },
  { tool: "cw_get_project", requires: [INQ(PROJECT, "Project Headers")] },
  { tool: "cw_create_project", requires: [ADD(PROJECT, "Project Headers")] },
  { tool: "cw_search_project_tickets", requires: [INQ(PROJECT, "Project Tickets")] },
  { tool: "cw_get_project_ticket", requires: [INQ(PROJECT, "Project Tickets")] },
  { tool: "cw_get_project_ticket_notes", requires: [INQ(PROJECT, "Project Tickets")] },
  { tool: "cw_add_project_ticket_note", requires: [EDIT(PROJECT, "Project Tickets")] },

  // Time entries
  { tool: "cw_search_time_entries", requires: [INQ(TIME, "Time Entry")] },
  { tool: "cw_get_time_entry", requires: [INQ(TIME, "Time Entry")] },
  {
    tool: "cw_create_time_entry",
    requires: [
      ADD(TIME, "Time Entry"),
      EDIT(SERVICE, "Service Tickets", {
        note: "Turns the ticket's automatic-email flags off around the create so customers are not emailed; omit if suppressTicketAutoEmail is always false.",
      }),
      EDIT(PROJECT, "Project Tickets", { note: "Same, for entries against project tickets." }),
    ],
  },
  { tool: "cw_update_time_entry", requires: [EDIT(TIME, "Time Entry")] },
  { tool: "cw_delete_time_entry", requires: [DEL(TIME, "Time Entry")] },

  // Schedule
  { tool: "cw_search_schedule_entries", requires: [INQ(SERVICE, "Resource Scheduling")] },
  { tool: "cw_list_schedule_types", requires: [TABLE(["Schedule / Schedule Type"])] },
  { tool: "cw_list_schedule_statuses", requires: [TABLE(["Schedule / Schedule Status"])] },
  { tool: "cw_create_schedule_entry", requires: [ADD(SERVICE, "Resource Scheduling")] },
  { tool: "cw_update_schedule_entry", requires: [EDIT(SERVICE, "Resource Scheduling")] },

  // Members
  { tool: "cw_search_members", requires: [INQ(SYSTEM, "Member Maintenance")] },
  { tool: "cw_get_member", requires: [INQ(SYSTEM, "Member Maintenance")] },

  // Opportunities
  {
    tool: "cw_search_opportunities",
    requires: [INQ(SALES, "Opportunity"), INQ(SALES, "Closed Opportunity", { note: "Only to include closed opportunities in results." })],
  },
  { tool: "cw_get_opportunity", requires: [INQ(SALES, "Opportunity"), INQ(SALES, "Closed Opportunity", { note: "Only for a closed opportunity." })] },
  { tool: "cw_search_opportunity_forecasts", requires: [INQ(SALES, "Opportunity"), INQ(SALES, "Opportunity Finance")] },
  { tool: "cw_search_opportunity_notes", requires: [INQ(SALES, "Opportunity")] },
  { tool: "cw_search_sales_stages", requires: [TABLE(["Sales / Sales Stage"])] },

  // Sales orders
  { tool: "cw_search_sales_orders", requires: [INQ(SALES, "Sales Orders")] },
  { tool: "cw_get_sales_order", requires: [INQ(SALES, "Sales Orders")] },
  { tool: "cw_get_sales_order_products", requires: [INQ(SALES, "Sales Orders"), INQ(PROC, "Products")] },

  // Agreements and invoices
  { tool: "cw_search_agreements", requires: [INQ(FINANCE, "Agreements")] },
  { tool: "cw_get_agreement", requires: [INQ(FINANCE, "Agreements")] },
  { tool: "cw_get_agreement_additions", requires: [INQ(FINANCE, "Agreements")] },
  { tool: "cw_search_agreement_recaps", requires: [INQ(FINANCE, "Agreements")] },
  { tool: "cw_get_agreement_recap", requires: [INQ(FINANCE, "Agreements")] },
  { tool: "cw_create_agreement_addition", requires: [ADD(FINANCE, "Agreements")] },
  { tool: "cw_update_agreement_addition", requires: [EDIT(FINANCE, "Agreements")] },
  { tool: "cw_search_invoices", requires: [INQ(FINANCE, "Invoicing")] },
  { tool: "cw_get_invoice", requires: [INQ(FINANCE, "Invoicing")] },
  { tool: "cw_update_invoice", requires: [EDIT(FINANCE, "Invoicing")] },

  // Catalog
  { tool: "cw_search_catalog_items", requires: [INQ(PROC, "Product Catalog")] },
  { tool: "cw_get_catalog_item", requires: [INQ(PROC, "Product Catalog")] },
  { tool: "cw_get_catalog_item_inventory", requires: [INQ(PROC, "Product Catalog")] },
  { tool: "cw_create_catalog_item", requires: [ADD(PROC, "Product Catalog")] },
  { tool: "cw_update_catalog_item", requires: [EDIT(PROC, "Product Catalog")] },
  { tool: "cw_list_catalog_categories", requires: [TABLE(["Procurement / Product Category"])] },
  { tool: "cw_list_catalog_subcategories", requires: [TABLE(["Procurement / Product Subcategory"])] },
  { tool: "cw_list_manufacturers", requires: [TABLE(["Procurement / Manufacturer"])] },

  // Procurement: products, purchase orders, project procurement
  { tool: "cw_search_procurement_products", requires: [INQ(PROC, "Products")] },
  { tool: "cw_get_procurement_product", requires: [INQ(PROC, "Products")] },
  { tool: "cw_search_purchase_orders", requires: [INQ(PROC, "Purchase Orders")] },
  { tool: "cw_get_purchase_order", requires: [INQ(PROC, "Purchase Orders")] },
  { tool: "cw_get_purchase_order_items", requires: [INQ(PROC, "Purchase Orders")] },
  {
    tool: "cw_get_project_product_status",
    requires: [INQ(PROJECT, "Project Headers"), INQ(SERVICE, "Service Tickets"), INQ(PROC, "Products"), INQ(PROC, "Purchase Orders")],
  },
  {
    tool: "cw_get_project_purchase_order_lines",
    requires: [INQ(PROJECT, "Project Headers"), INQ(SERVICE, "Service Tickets"), INQ(PROC, "Products"), INQ(PROC, "Purchase Orders")],
  },

  // Procurement: inventory
  {
    tool: "cw_list_warehouses",
    requires: [TABLE(["Inventory / Warehouse"], "Warehouses are a setup table, not a Procurement record.")],
  },
  { tool: "cw_list_warehouse_bins", requires: [TABLE(["Inventory / Warehouse Bin"])] },
  {
    tool: "cw_get_inventory_on_hand",
    requires: [
      INQ(PROC, "Product Catalog"),
      TABLE(["Inventory / Warehouse", "Inventory / Warehouse Bin"], "Only for the whole-instance bin scan; with catalogItemId the catalog permission is enough."),
    ],
  },
  { tool: "cw_list_adjustment_types", requires: [TABLE(["Inventory / Adjustment Type"])] },
  { tool: "cw_get_adjustment", requires: [INQ(PROC, "Inventory Adjustments")] },
  { tool: "cw_create_adjustment", requires: [ADD(PROC, "Inventory Adjustments")] },
  { tool: "cw_add_adjustment_detail", requires: [ADD(PROC, "Inventory Adjustments")] },
  {
    tool: "cw_close_adjustment",
    requires: [EDIT(PROC, "Inventory Adjustments", { note: "Posts stock movements; reversible only with a counter adjustment." })],
  },
];

const READ_PREFIXES = ["cw_get_", "cw_search_", "cw_list_", "cw_test_"];

function isReadTool(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

/** The matrix entry for a tool, or undefined when the tool is unknown. */
export function permissionsForTool(tool: string): ToolPermissionEntry | undefined {
  return TOOL_PERMISSIONS.find((e) => e.tool === tool);
}

/** The tools a write mode registers: read tools only, or all. */
export function toolsForMode(mode: "read-only" | "write"): ToolPermissionEntry[] {
  return TOOL_PERMISSIONS.filter((e) => mode === "write" || isReadTool(e.tool));
}

export interface RoleRecipeRow {
  module: string;
  func: string;
  add: boolean;
  edit: boolean;
  delete: boolean;
  inquire: boolean;
  tables: string[];
  tools: string[];
  notes: string[];
}

/**
 * Aggregate the per-tool requirements into one row per module/function: the
 * recipe an administrator applies to the role for the given mode.
 */
export function roleRecipe(mode: "read-only" | "write"): RoleRecipeRow[] {
  const rows = new Map<string, RoleRecipeRow>();
  for (const entry of toolsForMode(mode)) {
    for (const req of entry.requires) {
      const key = `${req.module}|${req.func}`;
      let row = rows.get(key);
      if (!row) {
        row = { module: req.module, func: req.func, add: false, edit: false, delete: false, inquire: false, tables: [], tools: [], notes: [] };
        rows.set(key, row);
      }
      if (req.level === "Add") row.add = true;
      if (req.level === "Edit") row.edit = true;
      if (req.level === "Delete") row.delete = true;
      if (req.level === "Inquire") row.inquire = true;
      for (const t of req.tables ?? []) if (!row.tables.includes(t)) row.tables.push(t);
      if (!row.tools.includes(entry.tool)) row.tools.push(entry.tool);
      if (req.note) {
        const note = `${entry.tool}: ${req.note}`;
        if (!row.notes.includes(note)) row.notes.push(note);
      }
    }
  }
  const order = ["Companies", "Service Desk", "Project", "Time & Expense", "Sales", "Finance", "Procurement", "System"];
  return [...rows.values()].sort(
    (a, b) => order.indexOf(a.module) - order.indexOf(b.module) || a.func.localeCompare(b.func),
  );
}

/** One row of GET /system/mySecurity (or /system/securityRoles/{id}/settings). */
export interface SecurityRow {
  moduleName?: string | null;
  moduleIdentifier?: string | null;
  moduleFunctionName?: string | null;
  moduleFunctionIdentifier?: string | null;
  addLevel?: string | null;
  editLevel?: string | null;
  deleteLevel?: string | null;
  inquireLevel?: string | null;
}

export interface PermissionGap {
  module: string;
  func: string;
  level: PermissionLevel;
  /** "All" satisfies; "My" or "None" is a gap; "missing" means no row matched the name. */
  have: "My" | "None" | "missing";
  tools: string[];
  /** Rows in the same module, when the function name did not match, so an operator can spot a renamed row. */
  candidates?: string[];
}

export interface PermissionReport {
  mode: "read-only" | "write";
  checked: number;
  satisfied: number;
  gaps: PermissionGap[];
  /** Table Setup tables the role must allow; not verifiable through mySecurity. */
  tablesToAllow: string[];
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Compare the member's effective permissions with the recipe for `mode`. */
export function findPermissionGaps(rows: SecurityRow[], mode: "read-only" | "write"): PermissionReport {
  const recipe = roleRecipe(mode);
  const gaps: PermissionGap[] = [];
  let checked = 0;
  let satisfied = 0;
  const tables = new Set<string>();
  for (const r of recipe) {
    for (const t of r.tables) tables.add(t);
    const match = rows.find((x) => norm(x.moduleName) === norm(r.module) && norm(x.moduleFunctionName) === norm(r.func));
    const levels: Array<[PermissionLevel, boolean, string | null | undefined]> = [
      ["Add", r.add, match?.addLevel],
      ["Edit", r.edit, match?.editLevel],
      ["Delete", r.delete, match?.deleteLevel],
      ["Inquire", r.inquire, match?.inquireLevel],
    ];
    for (const [level, needed, have] of levels) {
      if (!needed) continue;
      checked++;
      if (match && have === "All") {
        satisfied++;
        continue;
      }
      const gap: PermissionGap = {
        module: r.module,
        func: r.func,
        level,
        have: !match ? "missing" : have === "My" ? "My" : "None",
        tools: r.tools,
      };
      if (!match) {
        gap.candidates = rows
          .filter((x) => norm(x.moduleName) === norm(r.module))
          .map((x) => x.moduleFunctionName ?? "")
          .filter(Boolean)
          .slice(0, 40);
      }
      gaps.push(gap);
    }
  }
  return { mode, checked, satisfied, gaps, tablesToAllow: [...tables].sort() };
}

/** docs/PERMISSION-MATRIX.md, generated; see scripts/generate-permission-matrix.mjs. */
export function renderPermissionMatrixMarkdown(): string {
  const lines: string[] = [];
  lines.push("# Permission matrix");
  lines.push("");
  lines.push("<!-- GENERATED by scripts/generate-permission-matrix.mjs from src/permission-matrix.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push(
    "What the API member's ConnectWise security role must grant, per tool and as a role recipe. " +
      "Module and function names are the rows on **System > Security Roles**. Every level named here " +
      "must be set to **All**; \"My\" is not enough for an API member. Endpoints behind each tool are " +
      "checked against ConnectWise's published OpenAPI document (version 2026.11) by the test suite. " +
      "Verify the result against a live tenant with `cw_get_my_permissions` or `scripts/check-permissions.mjs`; " +
      "see [API-MEMBER-SETUP.md](API-MEMBER-SETUP.md).",
  );
  for (const mode of ["read-only", "write"] as const) {
    lines.push("");
    lines.push(`## Role recipe: ${mode === "read-only" ? "MCP Read-Only" : "MCP Write"} (\`CW_WRITE_MODE=${mode}\`)`);
    lines.push("");
    lines.push("| Module | Function | Add | Edit | Delete | Inquire | Tools |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const r of roleRecipe(mode)) {
      const mark = (b: boolean) => (b ? "**All**" : "None");
      lines.push(`| ${r.module} | ${r.func} | ${mark(r.add)} | ${mark(r.edit)} | ${mark(r.delete)} | ${mark(r.inquire)} | ${r.tools.map((t) => `\`${t}\``).join(", ")} |`);
    }
    const tables = roleRecipe(mode).flatMap((r) => r.tables);
    if (tables.length) {
      lines.push("");
      lines.push("Table Setup tables to allow on this role: " + [...new Set(tables)].sort().map((t) => `**${t}**`).join(", ") + ".");
    }
    const notes = roleRecipe(mode).flatMap((r) => r.notes);
    if (notes.length) {
      lines.push("");
      lines.push("Notes:");
      lines.push("");
      for (const n of [...new Set(notes)].sort()) lines.push(`- ${n}`);
    }
  }
  lines.push("");
  lines.push("## Per tool");
  lines.push("");
  lines.push("| Tool | Needs |");
  lines.push("|---|---|");
  for (const e of [...TOOL_PERMISSIONS].sort((a, b) => a.tool.localeCompare(b.tool))) {
    const needs = e.requires.length
      ? e.requires
          .map((r) => `${r.module} > ${r.func} (${r.level})${r.tables ? ` [${r.tables.join("; ")}]` : ""}`)
          .join("; ")
      : "none";
    lines.push(`| \`${e.tool}\` | ${needs} |`);
  }
  lines.push("");
  return lines.join("\n");
}
