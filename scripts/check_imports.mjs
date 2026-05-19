// Static check: walk every module under frontend/src/, parse its imports,
// and ensure every imported name is actually exported by the target file.
// Run with: node scripts/check_imports.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..", "frontend", "src");

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function exportsOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const names = new Set();
  // export { a, b, c };
  for (const m of src.matchAll(/export\s*\{\s*([^}]+)\s*\}\s*;/g)) {
    for (const tok of m[1].split(",")) {
      const n = tok.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  // export function foo / export const foo / export let foo
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return names;
}

function importsOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(/import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ names, from: m[2] });
  }
  return out;
}

let bad = 0;
for (const f of listJs(srcRoot)) {
  const rel = path.relative(srcRoot, f).replaceAll("\\", "/");
  for (const imp of importsOf(f)) {
    if (!imp.from.startsWith(".")) continue;
    const target = path.resolve(path.dirname(f), imp.from);
    if (!fs.existsSync(target)) {
      console.log(`MISSING ${rel} -> ${imp.from} (no such file)`);
      bad++;
      continue;
    }
    const exp = exportsOf(target);
    for (const n of imp.names) {
      if (!exp.has(n)) {
        console.log(`UNDEF   ${rel} imports '${n}' from ${imp.from} but it isn't exported there`);
        bad++;
      }
    }
  }
}

if (bad === 0) console.log(`OK — all imports resolve across ${listJs(srcRoot).length} modules.`);
else { console.log(`\n${bad} issue(s).`); process.exit(1); }
