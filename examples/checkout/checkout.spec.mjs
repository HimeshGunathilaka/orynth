import { expect, test } from "@playwright/test";

test("recovers a committed order after reload without another POST", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("status")).toContainText("Confirmation lost");
  await expect(page.locator("#total")).toHaveText("1");

  // The UI must remain able to recover even with all further submissions blocked.
  const resubmissions = [];
  await context.route("**/api/orders", (route) => {
    resubmissions.push(route.request().method());
    return route.abort();
  });
  await page.reload();
  await expect(page.getByRole("status")).toContainText("restored");
  const tab = await context.newPage();
  await tab.goto(page.url());
  await expect(tab.getByRole("status")).toContainText("restored");
  await tab.getByRole("button", { name: "Check order status" }).click();
  await expect(tab.getByRole("status")).toHaveText(/Order #\d+ confirmed/);
  await expect(tab.locator("#total")).toHaveText("1");
  expect(resubmissions).toEqual([]);
});

test("a new checkout gets a different key and an ordinary confirmation", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Drop the confirmation after saving").uncheck();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("status")).toHaveText(/Order #\d+ confirmed/);
  const key = await page.locator("#key").textContent();
  await page.getByRole("button", { name: "Start another checkout" }).click();
  await expect(page.locator("#total")).toHaveText("0");
  await expect(page.locator("#key")).not.toHaveText(key);
});

test("the backend replays matching writes and isolates browser sessions", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Ready to place your order.");
  const key = await page.locator("#key").textContent();
  const send = (quantity) => context.request.post("/api/orders", { headers: { "Idempotency-Key": key }, data: { quantity } });
  const responses = await Promise.all([send(1), send(1)]);
  for (const response of responses) expect(response.ok()).toBe(true);
  expect(await responses[0].json()).toEqual(await responses[1].json());
  expect((await send(2)).status()).toBe(422);
  expect(await (await context.request.get(`/api/count?key=${key}`)).json()).toEqual({ total: 1 });

  await context.clearCookies();
  expect((await context.request.get(`/api/outcome?key=${key}`)).status()).toBe(401);
  await page.reload();
  await expect(page.locator("#total")).toHaveText("0");
  expect(await (await context.request.get(`/api/outcome?key=${key}`)).json()).toEqual({ status: "not-found" });
});
