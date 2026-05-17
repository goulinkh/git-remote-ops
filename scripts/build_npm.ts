#!/usr/bin/env -S deno run -A
/**
 * Build the npm package from Deno sources via dnt.
 *
 * Usage:
 *   deno run -A scripts/build_npm.ts [version]
 *
 * The optional version overrides the one in deno.json. Output lands in ./npm/
 * with a runnable `git-remote-ops` bin and ESM/CJS entrypoints. Tests are
 * skipped at build time because the test harness shells out to a real git.
 */
import { build, emptyDir } from "jsr:@deno/dnt@^0.42";

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json"));
const version = Deno.args[0] ?? denoJson.version;
if (!version) {
  console.error("missing version");
  Deno.exit(1);
}

const OUT = "./npm";
await emptyDir(OUT);

await build({
  entryPoints: [
    "./src/index.ts",
    { name: "./cli", path: "./src/cli.ts", kind: "bin" },
  ],
  outDir: OUT,
  shims: { deno: true, crypto: true, undici: true },
  test: false,
  typeCheck: false,
  declaration: "separate",
  compilerOptions: {
    lib: ["ES2022", "DOM"],
    target: "ES2022",
  },
  esModule: true,
  scriptModule: false,
  package: {
    name: "git-remote-ops",
    version,
    description: "Read-only Git over smart HTTP. No clone, no subprocess.",
    license: "MIT",
    author: "Goulin Khoge",
    repository: {
      type: "git",
      url: "git+https://github.com/goulinkh/git-remote-ops.git",
    },
    bugs: {
      url: "https://github.com/goulinkh/git-remote-ops/issues",
    },
    homepage: "https://github.com/goulinkh/git-remote-ops#readme",
    keywords: [
      "git",
      "smart-http",
      "upload-pack",
      "packfile",
      "partial-clone",
      "shallow-clone",
    ],
    bin: { "git-remote-ops": "./esm/cli.js" },
    engines: { node: ">=20" },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", `${OUT}/LICENSE`);
    Deno.copyFileSync("README.md", `${OUT}/README.md`);
    Deno.copyFileSync("AGENTS.md", `${OUT}/AGENTS.md`);
  },
});

console.log(`built npm package -> ${OUT}`);
