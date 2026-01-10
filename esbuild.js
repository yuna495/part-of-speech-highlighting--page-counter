const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`
        );
      });
      console.log("[watch] build finished");
    });
  },
};

const copyDictPlugin = {
  name: "copy-dict-plugin",
  setup(build) {
    build.onEnd(() => {
      const srcDir = path.join(__dirname, "node_modules", "kuromoji", "dict");
      const destDir = path.join(__dirname, "dist", "dict");
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.readdirSync(srcDir).forEach((file) => {
        if (file.endsWith(".dat") || file.endsWith(".dat.gz")) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      });
      console.log("[build] copied kuromoji dicts to dist/dict");
    });
  },
};

const aliasPlugin = {
  name: "alias-plugin",
  setup(build) {
    build.onResolve({ filter: /^kuromojin$/ }, (args) => {
      return {
        path: path.join(__dirname, "src", "kuromojin_shim.js"),
      };
    });
  },
};



async function main() {
  const ctx = await esbuild.context({
    entryPoints: [
    "./src/extension.js",
    "./src/worker/linterWorker.js",
    "./src/worker/semanticWorker.js",
  ],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outdir: "dist",
    external: ["vscode", "puppeteer-core"], // exclude vscode api and puppeteer
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin, copyDictPlugin, aliasPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
