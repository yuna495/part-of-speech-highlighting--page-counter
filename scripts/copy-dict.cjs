// scripts/copy-dict.cjs
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "kuromoji", "dict");
const dst = path.join(__dirname, "..", "dict");

function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(src)) {
  console.error("kuromoji dict not found:", src);
  process.exit(1);
}

copyDir(src, dst);
console.log("Copied kuromoji dict ->", dst);
