import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    storage: "src/storage/index.ts",
  },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
});
