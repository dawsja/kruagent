// Fails when an API route handler is exported without the session guard.
// Only /api/auth (Better Auth itself) and /api/health are public.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve("app/api");
const PUBLIC = new Set(["auth/[...all]/route.ts", "health/route.ts"]);
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const problems = [];
let checked = 0;
for (const file of walk(root)) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (!rel.endsWith("route.ts") || PUBLIC.has(rel)) continue;
  checked += 1;
  const source = readFileSync(file, "utf8");
  if (new RegExp(`export\\s+(async\\s+)?function\\s+(${METHODS})\\b`).test(source)) {
    problems.push(`${rel}: exports a handler function directly`);
  }
  const exported = [...source.matchAll(new RegExp(`export\\s+const\\s+(${METHODS})\\s*=\\s*([^;]+);`, "g"))];
  if (exported.length === 0) problems.push(`${rel}: no guarded handlers found`);
  for (const [, method, value] of exported) {
    if (!value.trim().startsWith("withSession(")) {
      problems.push(`${rel}: ${method} is not wrapped in withSession`);
    }
  }
}

if (problems.length) {
  console.error(`Unguarded API routes:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Route guards ok: ${checked} API route files require a session.`);
