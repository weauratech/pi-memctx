#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function executableName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function resolveQmdBinary() {
  const envBin = process.env.QMD_PATH || process.env.MEMCTX_QMD_BIN;
  if (envBin) return { bin: envBin, source: "env" };

  try {
    const pkgPath = require.resolve("@tobilu/qmd/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.qmd;
    if (binRel) {
      const bin = path.join(path.dirname(pkgPath), binRel);
      if (fs.existsSync(bin)) return { bin, source: "optional-dependency" };
    }
  } catch {
    // optional dependency omitted or unavailable
  }

  const start = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  let dir = start;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "node_modules", ".bin", executableName("qmd")));
    candidates.push(path.join(dir, "vendor", "qmd", `${process.platform}-${process.arch}`, executableName("qmd")));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const local = firstExisting(candidates);
  if (local) return { bin: local, source: local.includes(`${path.sep}vendor${path.sep}`) ? "bundled" : "local-dependency" };

  const pathMatch = firstExisting((process.env.PATH || "").split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, executableName("qmd"))));
  if (pathMatch) return { bin: pathMatch, source: "path" };

  return null;
}

function doctor() {
  const resolved = resolveQmdBinary();
  let qmd = { available: false, source: "missing", bin: undefined, version: undefined, error: undefined };
  if (resolved) {
    qmd = { available: false, ...resolved };
    try {
      qmd.version = execFileSync(resolved.bin, ["--version"], { timeout: Number(process.env.MEMCTX_QMD_PROBE_TIMEOUT_MS || 1200), encoding: "utf-8" }).trim();
      qmd.available = true;
    } catch (err) {
      qmd.error = err instanceof Error ? err.message : String(err);
    }
  }

  console.log([
    "pi-memctx doctor",
    "",
    `node: ${process.version}`,
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    `qmd: ${qmd.available ? "ok" : "missing/unavailable"}`,
    `qmd source: ${qmd.source}`,
    `qmd path: ${qmd.bin || "<none>"}`,
    `qmd version: ${qmd.version || "<unknown>"}`,
    qmd.error ? `qmd error: ${qmd.error}` : "",
    `retrieval backend: ${qmd.available ? "qmd" : "grep fallback"}`,
    "",
    qmd.available ? "status: ok" : "suggestion: install qmd separately (npm install -g @tobilu/qmd) or set QMD_PATH=/path/to/qmd. grep fallback works without qmd.",
  ].filter(Boolean).join("\n"));

  process.exit(qmd.available ? 0 : 1);
}

const command = process.argv[2] || "doctor";
if (["doctor", "--doctor", "-d"].includes(command)) doctor();
if (["--help", "-h", "help"].includes(command)) {
  console.log("Usage: pi-memctx doctor\n\nDiagnose qmd availability for pi-memctx.");
  process.exit(0);
}
console.error(`Unknown command: ${command}`);
console.error("Usage: pi-memctx doctor");
process.exit(2);
