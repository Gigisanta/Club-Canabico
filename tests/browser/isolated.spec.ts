import { expect, test } from "./isolated";

test("browser fixture blocks outbound writes before network access", async ({ page }) => {
  await page.goto("/");
  const blockedRequest = page.waitForEvent("requestfailed", (request) =>
    request.url() === "https://example.invalid/e2e-must-stay-local",
  );
  const fetchRejected = await page.evaluate(async () => {
    try {
      await fetch("https://example.invalid/e2e-must-stay-local", {
        method: "POST",
        mode: "no-cors",
        body: "must remain local",
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(fetchRejected).toBe(true);
  expect((await blockedRequest).failure()?.errorText).toContain("ERR_BLOCKED_BY_CLIENT");
});
