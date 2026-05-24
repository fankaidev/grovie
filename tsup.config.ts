import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/admin-console-worker.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
