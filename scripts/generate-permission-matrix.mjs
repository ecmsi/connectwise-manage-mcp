#!/usr/bin/env node
// Write docs/PERMISSION-MATRIX.md from src/permission-matrix.ts (via dist).
//   npm run build && npm run docs:matrix
// A test fails when the committed file is out of date.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPermissionMatrixMarkdown } from "../dist/permission-matrix.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "PERMISSION-MATRIX.md");
writeFileSync(out, renderPermissionMatrixMarkdown());
console.log(`wrote ${path.relative(root, out)}`);
