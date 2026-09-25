import { expect, test as base } from "@playwright/test";

const allowedOrigin = process.env.E2E_BASE_URL
  ? new URL(process.env.E2E_BASE_URL).origin
  : undefined;

export const test = base.extend({
  context: async ({ context }, use) => {
    if (!allowedOrigin)
      throw new Error("La suite necesita el origen de la instancia E2E aislada.");

    await context.route("**/*", async (route) => {
      let requestOrigin: string;
      try {
        requestOrigin = new URL(route.request().url()).origin;
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (requestOrigin === allowedOrigin) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
    await use(context);
  },
});

export { expect };
