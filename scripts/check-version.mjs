#!/usr/bin/env node
// Fail when the version is not the same everywhere it is written down.
//   npm run version:check            # all sites agree with package.json
//   npm run version:check -- 2.2.0   # ...and package.json is exactly 2.2.0 (the release tag)
// Sites: package.json, package-lock.json (root and packages[""]), the MCP server
// metadata in src/mcp-server.ts, and the image tag in docker-compose.yml.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const errors = [];

function read(name) {
  try {
    return readFileSync(path.join(root, name), "utf8");
  } catch {
    errors.push(`${name} must be readable`);
    return "";
  }
}
function json(name) {
  try {
    return JSON.parse(read(name));
  } catch {
    errors.push(`${name} must contain valid JSON`);
    return {};
  }
}

const pkg = json("package.json");
const lock = json("package-lock.json");
const server = read("src/mcp-server.ts");
const compose = read("docker-compose.yml");

const version = typeof pkg.version === "string" ? pkg.version : "";
if (!SEMVER.test(version)) errors.push(`package.json version is not valid semver: ${version || "missing"}`);

const sites = [
  ["package-lock.json version", lock.version],
  ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
  ["src/mcp-server.ts server version", /\bversion:\s*"([^"]+)"/.exec(server)?.[1]],
  ["docker-compose.yml image tag", /image:\s*ghcr\.io\/ecmsi\/connectwise-manage-mcp:(\S+)/.exec(compose)?.[1]],
];
for (const [label, found] of sites) {
  if (found !== version) errors.push(`${label} must be ${version}; found ${found ?? "missing"}`);
}

const expected = process.argv[2];
if (expected && expected !== version) errors.push(`expected ${expected} (the release tag) but package.json says ${version}`);

if (errors.length) {
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log(`Version is consistent: ${version}`);
