import { defineConfig } from "vitest/config";

// Without this file vitest falls back to vite.config.ts, whose `root: "ui"`
// exists only to build the MCP Apps card bundle — tests live at the repo
// root, so pin vitest to the defaults here.
//
// `dist/` is gitignored but tsc compiles test files into it alongside
// source (tsconfig has no test-file exclude), so after any local/CI build
// vitest's default include glob picks up the compiled dist/*.test.js
// copies too, silently doubling the reported test count. Exclude it
// explicitly rather than relying on vitest's node_modules-only default.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The server defaults to CW_WRITE_MODE=read-only, which leaves every
    // create/update/delete tool unregistered. The contract tests exercise
    // those tools, so the suite runs in write mode; tool-policy.test.ts and
    // the HTTP tests set the mode explicitly where it is what is under test.
    env: {
      CW_WRITE_MODE: "write",
    },
  },
});
