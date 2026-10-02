import { test, expect } from "./isolated";

// Real rendered UI and requests, using only the isolated runner's synthetic club.
test("operations desktop and mobile show business tasks, exact account currencies and coverage", async ({ page }, testInfo) => {
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("response",response=>{if(response.url().includes("/api/")&&response.status()>=500)errors.push(`${response.status()} ${new URL(response.url()).pathname}`);});
  await page.goto("/app/operations");
  await page.getByRole("button",{name:"Explorar club de demostración"}).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
  await expect(page.locator(".ops-home-page")).toContainText("Contribución");
  await expect(page.locator(".ops-topbar")).toContainText("Ensayo");
  await expect(page.locator(".ops-home-page .ops-spinner")).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath("operations-desktop.png"),fullPage:true});
  await page.getByRole("button",{name:"Cuentas y saldos",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Cuentas y saldos",exact:true})).toBeVisible();
  await expect(page.locator(".ops-content")).toContainText("ARS");
  await expect(page.locator(".ops-content")).toContainText("USD");
  await page.screenshot({path:testInfo.outputPath("operations-accounts.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole("button",{name:"Abrir menú",exact:true}).click();
  await page.getByRole("button",{name:"Pedidos",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Pedidos",exact:true})).toBeVisible();
  await expect.poll(async () => { const box = await page.locator(".ops-sidebar").boundingBox(); return box !== null && box.x + box.width <= 0; }).toBe(true);
  await page.screenshot({path:testInfo.outputPath("operations-mobile.png"),fullPage:true,animations:"disabled"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
