// Loads machine-local interpreter paths from the uncommitted repo-root .env.
// Tests spawn the same PY_BIN/NODE_BIN the production wrappers use (uniform interpreter).
const fs = require("node:fs"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
for (const line of (() => { try { return fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
const PY = process.env.PY_BIN || "python3";
module.exports = { ROOT, PY };
