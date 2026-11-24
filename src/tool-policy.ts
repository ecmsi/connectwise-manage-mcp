/**
 * Tool registration policy: write-mode gating and per-call audit logging.
 *
 * `CW_WRITE_MODE=read-only` (the default) keeps every tool that can change
 * ConnectWise data out of the server entirely: the tool is not listed and
 * cannot be called, rather than being present and refusing. `CW_WRITE_MODE=write`
 * registers the full catalog.
 *
 * Classification is by name. Every tool this server registers follows the
 * `cw_<verb>_<noun>` convention, and the read verbs are `get`, `search`,
 * `list` and `test`. A name outside that set is treated as a write, so a new
 * tool is excluded from read-only mode until it is deliberately named as a
 * read. A test (`tool-policy.test.ts`) scans the tool sources and fails if a
 * read-named tool issues anything but GET.
 *
 * The audit hook writes one JSON line per tool call to stderr with the tool
 * name, outcome and duration. Arguments and results are never logged: they
 * carry PSA data and, for some tools, free text written by customers.
 */
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

export type WriteMode = "read-only" | "write";

export const DEFAULT_WRITE_MODE: WriteMode = "read-only";

const READ_ONLY_PREFIXES = ["cw_get_", "cw_search_", "cw_list_", "cw_test_"] as const;

/** True when the tool name says it only reads. */
export function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** True when a tool with this name may be registered under `mode`. */
export function isToolAllowed(name: string, mode: WriteMode): boolean {
  return mode === "write" || isReadOnlyToolName(name);
}

/**
 * Parse a CW_WRITE_MODE value. Unset and empty mean read-only. Anything other
 * than the two modes (plus the obvious spellings) is an error, so a typo
 * cannot silently widen or narrow the catalog.
 */
export function resolveWriteMode(value: string | undefined): WriteMode {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "" || raw === "read-only" || raw === "readonly" || raw === "read_only") return "read-only";
  if (raw === "write" || raw === "full" || raw === "read-write") return "write";
  throw new Error(`CW_WRITE_MODE must be "read-only" or "write", got ${JSON.stringify(value)}`);
}

export interface ToolAuditEntry {
  tool: string;
  ok: boolean;
  ms: number;
  /** Error class name when the handler threw. Never the message. */
  error?: string;
}

export type ToolAuditHook = (entry: ToolAuditEntry) => void;

/** Default audit sink: one JSON line on stderr. */
export function logToolAudit(entry: ToolAuditEntry): void {
  console.error(JSON.stringify({ event: "tool_call", ts: new Date().toISOString(), ...entry }));
}

export interface ToolPolicy {
  writeMode: WriteMode;
  /** Receives one entry per tool call. `null` turns auditing off. */
  audit?: ToolAuditHook | null;
}

type AnyFn = (...args: unknown[]) => unknown;
type RegisterFn = (...args: unknown[]) => RegisteredTool;

/**
 * An McpServer that applies the write-mode policy at registration time and
 * wraps every tool handler with the audit hook. Tool modules register
 * against it exactly as they would against a plain McpServer.
 */
export class PolicyMcpServer extends McpServer {
  readonly writeMode: WriteMode;
  /** Names registered and kept, in registration order. */
  readonly registeredTools: string[] = [];
  /** Names refused by the write mode, in registration order. */
  readonly skippedTools: string[] = [];
  private readonly audit: ToolAuditHook | null;

  constructor(
    serverInfo: Implementation,
    options: ConstructorParameters<typeof McpServer>[1],
    policy: ToolPolicy,
  ) {
    super(serverInfo, options);
    this.writeMode = policy.writeMode;
    this.audit = policy.audit === undefined ? logToolAudit : policy.audit;
  }

  override tool(...args: unknown[]): RegisteredTool {
    return this.gate(args, (super.tool as unknown as RegisterFn).bind(this));
  }

  override registerTool(...args: unknown[]): RegisteredTool {
    return this.gate(args, (super.registerTool as unknown as RegisterFn).bind(this));
  }

  private gate(args: unknown[], register: RegisterFn): RegisteredTool {
    const name = String(args[0]);
    // The handler is always the last argument of every tool()/registerTool()
    // overload. A task-style handler object is passed through unwrapped.
    const last = args.length - 1;
    if (this.audit && typeof args[last] === "function") {
      args[last] = this.wrapHandler(name, args[last] as AnyFn);
    }
    const registered = register(...args);
    if (isToolAllowed(name, this.writeMode)) {
      this.registeredTools.push(name);
    } else {
      // Register-then-remove rather than skip: the SDK owns the registry, and
      // removal through its own API cannot drift from its bookkeeping.
      registered.remove();
      this.skippedTools.push(name);
    }
    return registered;
  }

  private wrapHandler(name: string, handler: AnyFn): AnyFn {
    const audit = this.audit as ToolAuditHook;
    return async (...handlerArgs: unknown[]) => {
      const started = performance.now();
      try {
        const result = await handler(...handlerArgs);
        const isError = Boolean((result as { isError?: unknown } | null)?.isError);
        audit({ tool: name, ok: !isError, ms: Math.round(performance.now() - started) });
        return result;
      } catch (err) {
        audit({
          tool: name,
          ok: false,
          ms: Math.round(performance.now() - started),
          error: err instanceof Error ? err.name : "unknown",
        });
        throw err;
      }
    };
  }
}
