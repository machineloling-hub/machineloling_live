// Best-effort undefined-reference check. For each module, gather:
//   * names declared in the file (function/const/let/var/class + destructuring)
//   * names imported (default, named, namespace)
//   * known globals (browser, ES, our HTML script-tag globals)
// Then collect every identifier reference and report ones not in any of those.
//
// This is a regex-based approximation, not a real parser — it will produce
// some false positives (object property names, comment-only names, etc.) so
// review the output rather than treating it as authoritative. It's good
// enough to surface obvious "forgot to import X" bugs.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "..", "frontend", "src");

const GLOBALS = new Set([
  // ES + Web stdlib
  "window","document","console","fetch","Math","Number","String","Array",
  "Object","Set","Map","Promise","JSON","URL","URLSearchParams","Boolean",
  "Date","RegExp","Error","TypeError","RangeError","Infinity","NaN",
  "undefined","null","true","false","this","arguments","globalThis",
  "setTimeout","clearTimeout","setInterval","clearInterval",
  "parseInt","parseFloat","isFinite","isNaN","encodeURIComponent","decodeURIComponent",
  "Uint8Array","Float32Array","Int32Array","ArrayBuffer",
  "Symbol","Reflect","Proxy",
  // External script (CDN)
  "Plotly",
  // Reserved words / control flow tokens that may match the regex
  "if","else","for","while","do","switch","case","default","break","continue",
  "return","function","const","let","var","class","new","typeof","instanceof",
  "in","of","delete","void","try","catch","finally","throw","async","await",
  "import","export","from","as","yield","static","extends","super","get","set",
  // Window-attached singletons set in init()
  "cmpSS","poolMS","pbDefMS","pbMayMS",
]);

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function declaredNames(src) {
  const names = new Set();
  // function NAME / async function NAME / class NAME
  for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // const/let/var (incl. destructuring)
  for (const m of src.matchAll(/(?:^|\s)(?:const|let|var)\s+([^=;\n]+?)\s*=/g)) {
    const lhs = m[1];
    // Pull bare names + destructuring binds (skip "default:" rename targets)
    for (const n of lhs.matchAll(/([A-Za-z_$][\w$]*)/g)) names.add(n[1]);
  }
  // function params (best-effort, captures are imperfect for defaults)
  for (const m of src.matchAll(/(?:function\s*\*?\s*[A-Za-z_$\w]*\s*|=>\s*|^\s*)\(([^)]*)\)\s*(?:=>|\{)/gm)) {
    const params = m[1];
    for (const n of params.matchAll(/([A-Za-z_$][\w$]*)/g)) names.add(n[1]);
  }
  // for (const x of ...) / for (let i = ...)
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // catch (e)
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{\s*([^}]+)\s*\}\s*from/g)) {
    for (const tok of m[1].split(",")) {
      const n = tok.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  return names;
}

// Strip comments + string/template literals so identifiers inside them don't
// count as references. Leaves an "X" placeholder so positions don't shift.
function stripNonCode(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  src = src.replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  src = src.replace(/`(?:[^`\\$]|\\.|\$\{[^}]*\})*`/gs, '"X"');
  src = src.replace(/"(?:[^"\\]|\\.)*"/g, '"X"');
  src = src.replace(/'(?:[^'\\]|\\.)*'/g, "'X'");
  return src;
}

function references(src) {
  // identifiers NOT preceded by `.` and NOT followed by `:` (object property).
  const out = new Set();
  for (const m of src.matchAll(/(?<![\.\w$])([A-Za-z_$][\w$]*)\s*(?!\s*:)/g)) {
    out.add(m[1]);
  }
  return out;
}

let bad = 0;
for (const f of listJs(srcRoot)) {
  const rel = path.relative(srcRoot, f).replaceAll("\\", "/");
  const raw = fs.readFileSync(f, "utf8");
  const stripped = stripNonCode(raw);
  const decl = declaredNames(stripped);
  const imp = importedNames(stripped);
  const refs = references(stripped);
  const known = new Set([...decl, ...imp, ...GLOBALS]);
  // Numeric literals end up matched too — filter
  const undefs = [...refs].filter((n) => !/^\d/.test(n) && !known.has(n));
  // Skip anything that looks like an object-property key in an HTML attribute
  // or template — heuristic; can't fully avoid without a real parser.
  if (undefs.length) {
    console.log(`--- ${rel} (${undefs.length} candidates):`);
    for (const n of undefs.sort()) console.log("    " + n);
    bad += undefs.length;
  }
}
if (bad === 0) console.log("OK — no undefined-reference candidates.");
else console.log(`\n${bad} candidate(s) — review manually (some are false positives).`);
