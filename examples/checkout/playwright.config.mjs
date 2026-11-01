import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "checkout.spec.mjs",
  outputDir: "../../test-results/checkout",
  use: { baseURL: "http://127.0.0.1:4174" },
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({ name: browserName, use: { browserName } })),
  webServer: {
    command: "node server.mjs",
    env: { PORT: "4174", CHECKOUT_DB: ":memory:" },
    url: "http://127.0.0.1:4174",
  },
});
