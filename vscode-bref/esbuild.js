const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["./out/extension.js"],
    bundle: true,
    outfile: "./dist/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node18",
    sourcemap: true,
    minify: true,
  })
  .catch(() => process.exit(1));
