# Setting up the ConnectWise API member

Everything this server can do, it does as one ConnectWise Manage **API member**. The member's
security role is the ceiling: the model can read exactly what the role lets the member read, and in
write mode can change exactly what the role lets the member change. So the setup is, in order, a
role, a member with that role, a key pair for the member, and a Client ID for the integration.

![Setup flow: security role, API member, API keys, Client ID, .env](images/api-member-setup.svg)

Four values come out of this, and they are the only ConnectWise settings the server needs:

| `.env` variable | Where it comes from |
|---|---|
| `CW_MANAGE_COMPANY_ID` | The short company name you type on the Manage login screen |
| `CW_MANAGE_PUBLIC_KEY` | Step 3 |
| `CW_MANAGE_PRIVATE_KEY` | Step 3 (shown once) |
| `CW_MANAGE_CLIENT_ID` | Step 4 |

You need a Manage login with rights to System > Security Roles and System > Members (an
administrator role), and a developer-portal account for step 4.

## 1. Create a security role for the server

Do not reuse Admin, and do not reuse a technician's role. A role of its own means the permission
list is exactly what the server needs, is auditable on one screen, and can be widened later without
touching anyone else.

1. In Manage, open **System > Security Roles**.
2. Click **+** (New). Name the role `MCP Read-Only` and save it.
3. Open the role. Each module expands to a list of permissions, and each permission has four
   access levels: **Add**, **Edit**, **Delete** and **Inquire**. Each level is set to **All**, **My**
   or **None**.
4. Set every permission in the table below to **Inquire: All** and leave Add, Edit and Delete at
   **None**. Leave everything not listed at None.
5. Save.

Permissions for the read-only catalog (63 tools). The right-hand column names the tools that fail
without it, so you can skip a row if you will never use those tools.

| Module | Permission | Tools that need it |
|---|---|---|
| Companies | Company Maintenance | `cw_search_companies`, `cw_get_company`, `cw_list_company_sites` |
| Companies | Contacts | `cw_search_contacts`, `cw_get_contact` |
| Companies | Configurations | `cw_search_configurations`, `cw_get_configuration`, `cw_get_ticket_configurations` |
| Companies | CRM / Sales Activities | `cw_search_activities`, `cw_get_activity` |
| Service Desk | Service Tickets | `cw_search_tickets`, `cw_get_ticket`, `cw_get_ticket_notes`, `cw_list_boards`, `cw_list_statuses` |
| Project | Project Headers | `cw_search_projects`, `cw_get_project`, `cw_get_project_product_status`, `cw_get_project_purchase_order_lines` |
| Project | Project Tickets | `cw_search_project_tickets`, `cw_get_project_ticket`, `cw_get_project_ticket_notes` |
| Time & Expense | Time Entry | `cw_search_time_entries`, `cw_get_time_entry` |
| Schedule | Schedule | `cw_search_schedule_entries`, `cw_list_schedule_types`, `cw_list_schedule_statuses` |
| Sales | Opportunities | `cw_search_opportunities`, `cw_get_opportunity`, `cw_search_opportunity_forecasts`, `cw_search_opportunity_notes`, `cw_search_sales_stages` |
| Sales | Sales Orders | `cw_search_sales_orders`, `cw_get_sales_order`, `cw_get_sales_order_products` |
| Finance | Agreements | `cw_search_agreements`, `cw_get_agreement`, `cw_get_agreement_additions`, `cw_search_agreement_recaps`, `cw_get_agreement_recap` |
| Finance | Invoices | `cw_search_invoices`, `cw_get_invoice` |
| Procurement | Product Catalog | `cw_search_catalog_items`, `cw_get_catalog_item`, `cw_get_catalog_item_inventory` |
| Procurement | Products | `cw_search_procurement_products`, `cw_get_procurement_product` |
| Procurement | Purchase Orders | `cw_search_purchase_orders`, `cw_get_purchase_order`, `cw_get_purchase_order_items` |
| Procurement | Inventory Adjustments | `cw_get_adjustment` |
| System | Member Maintenance | `cw_search_members`, `cw_get_member` |
| System | Table Setup | `cw_list_priorities`, `cw_list_communication_types`, `cw_list_catalog_categories`, `cw_list_catalog_subcategories`, `cw_list_manufacturers`, `cw_list_warehouses`, `cw_list_warehouse_bins`, `cw_list_adjustment_types`, `cw_get_inventory_on_hand` |

Notes on that table:

- **Table Setup** is one permission with its own list of tables. When you set Inquire on it, Manage
  asks which setup tables the role may read. Allow: Priority, Communication Type, Product Category,
  Product Subcategory, Manufacturer, Inventory / Warehouse, Inventory / Warehouse Bin, Inventory /
  Adjustment Type. The server names the table in the error if one is missing.
- `cw_test_connection` reads `/system/info`, which any valid API member can do. It needs no row.
- Module and permission names above are as they appear on the Security Roles screen in current
  Manage releases. If your tenant shows a different wording for a row, pick the nearest match and
  use the verification step at the end: a refused call tells you the module and permission to grant.

### If you later need write mode

Create a **second** role (`MCP Write`) rather than widening the first, and a second API member for
it, so the two servers in `docs/DEPLOYMENT.md` ("Write mode") run as different members. Start from
the read-only table and add only the levels in this table for the write tools you actually plan to
use:

| Module | Permission | Add | Edit | Delete | Tools |
|---|---|---|---|---|---|
| Service Desk | Service Tickets | All | All | None | `cw_create_ticket`, `cw_update_ticket`, `cw_add_ticket_note`, `cw_bundle_tickets`, `cw_update_ticket_configurations` |
| Project | Project Headers | All | None | None | `cw_create_project` |
| Project | Project Tickets | None | All | None | `cw_add_project_ticket_note` |
| Companies | Company Maintenance | All | All | None | `cw_create_company`, `cw_update_company` |
| Companies | Contacts | All | All | None | `cw_create_contact`, `cw_update_contact`, `cw_update_contact_types` |
| Companies | CRM / Sales Activities | All | None | None | `cw_create_activity` |
| Time & Expense | Time Entry | All | All | All | `cw_create_time_entry`, `cw_update_time_entry`, `cw_delete_time_entry` |
| Schedule | Schedule | All | All | None | `cw_create_schedule_entry`, `cw_update_schedule_entry` |
| Finance | Agreements | All | All | None | `cw_create_agreement_addition`, `cw_update_agreement_addition` |
| Finance | Invoices | None | All | None | `cw_update_invoice` |
| Procurement | Product Catalog | All | All | None | `cw_create_catalog_item`, `cw_update_catalog_item` |
| Procurement | Inventory Adjustments | All | All | None | `cw_create_adjustment`, `cw_add_adjustment_detail`, `cw_close_adjustment` |

`cw_create_time_entry` also needs **Edit** on Service Tickets (and Project Tickets for project
work): it briefly turns the ticket's automatic-email flags off around the create so customers are
not emailed. `cw_close_adjustment` posts stock movements that can only be reversed with a counter
adjustment.

## 2. Create the API member

1. Open **System > Members**.
2. Switch to the **API Members** tab (it sits next to the Members tab at the top of the list).
3. Click **+** (New).
4. Fill in the member:

   | Field | Value |
   |---|---|
   | Member ID | `mcp-readonly` (or anything short; this is the member's login name, not a password) |
   | Member Name | `MCP Server (read-only)` |
   | Role ID | `MCP Read-Only` from step 1 |
   | Level | Corporate |
   | Name | the same as Member Name |
   | Location / Business Unit (Department) | your main location and department |
   | Default Territory | your main territory |
   | Time Zone | the tenant's time zone |

   Leave the rest at defaults. An API member has no password and cannot log in interactively, and
   it does not consume a Manage license.
5. Save. The member record reopens with more tabs.

Make a separate member (and role) for the write-mode server if you deploy one; do not share one
member between servers, or the audit trail in Manage cannot tell them apart.

## 3. Generate the API keys

1. On the API member record, open the **API Keys** tab.
2. Click **+** (New).
3. Enter a **Description** that says where the key lives, for example `mcp01 /opt/mcp/connectwise`.
4. Save. Manage shows the **Public Key** and the **Private Key**.
5. Copy both into the host's `.env` now (`CW_MANAGE_PUBLIC_KEY`, `CW_MANAGE_PRIVATE_KEY`). **The
   private key is displayed once.** After you leave the screen it cannot be shown again; a lost
   private key means generating a new pair and deleting the old one.

Rotation is the same screen: add a new pair, update `.env`, recreate the container
(`docker compose up -d`), then delete the old pair. Deleting a key pair revokes it immediately.

## 4. Get a Client ID

ConnectWise requires every API integration to identify itself with a Client ID GUID, sent on each
request as the `clientId` header. It is tied to the integration, not to a member or a tenant, so one
Client ID can serve both the read-only and the write-mode servers.

1. Go to <https://developer.connectwise.com/> and sign in. If you do not have an account, register
   with the same company email address you use for Manage; partner accounts are tied to the
   company's Manage tenant.
2. Open **ClientID** from the top navigation (<https://developer.connectwise.com/ClientID>).
3. Register a new integration:

   | Field | Value |
   |---|---|
   | Integration name | `ECMSI MCP Server` |
   | Description | `MCP server for Claude, read-only by default` |
   | Integration type | Private (for your own company only) |
   | Product | Manage / PSA |

4. The portal shows the GUID. Copy it into `.env` as `CW_MANAGE_CLIENT_ID`.

A Client ID is not a secret in the way the private key is, but treat it as one: it is part of what
authenticates every call, and `.env` is mode 600 anyway.

## 5. Verify

Fill the four values into `/opt/mcp/connectwise/.env`, start the container (`docker compose up -d`),
then from a connected client run `cw_test_connection`. It calls `/system/info` and returns the
tenant's version and licence summary. That proves the company ID, both keys and the Client ID.

Then exercise one tool per module you granted, for example `cw_list_boards`, `cw_search_companies`,
`cw_search_agreements`. A tool whose permission is missing returns an error such as:

```
ConnectWise API GET /finance/agreements returned 403 (reference 2f6c…) ConnectWise refused this for lack of
a security role permission: grant the API member's security role Finance > Agreements (System > Security Roles).
```

Grant the named permission on the role, save, and call the tool again; no restart is needed, the
role change applies to the member's next request.

## What to keep where

| Item | Where | Who can see it |
|---|---|---|
| Private key | `.env` on the host only | root and the container |
| Public key, Client ID, company ID | `.env` on the host | same |
| Role definition | Manage, System > Security Roles | Manage administrators |
| Key description | Manage, the member's API Keys tab | names the host so a stray key can be traced |

Never paste the private key into a chat, a ticket, a client config file or a compose file. If it
has been exposed, generate a new pair and delete the old one; that revokes it immediately.

## Reference

The navigation above matches the ConnectWise Manage client as of 2026 and is consistent with the
setup guides ConnectWise integration partners publish, for example
[Acronis](https://www.acronis.com/en/support/documentation/ConnectWisePSA/creating-api-member-in-connectwise-manage.html),
[N-able](https://documentation.n-able.com/passportal/userguide/Content/psa-integ/cwpsa-create-api-member.htm) and
[Sophos](https://docs.sophos.com/central/partner/help/en-us/ConnectWiseIntegration/SetUpIntegration/ConnectWiseSetup/).
The Client ID registration is described on the
[ConnectWise developer network](https://developer.connectwise.com/Getting_Started). Those pages
have screenshots of the Manage screens; they are not reproduced here because they belong to their
authors and because Manage's UI changes between releases.
