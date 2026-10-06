import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { cutoverGateIds } from "../../shared/operations/contracts";
import { test, expect } from "./isolated";

const syntheticEvidence = { note: "Evidencia sintética para una prueba local; no acredita una operación real." };

async function login(page: Page) {
  await page.goto("/app/operations");
  await page.getByRole("button", { name: "Explorar club de demostración" }).click();
  await expect(page.locator(".ops-home-page")).toBeVisible();
}

async function operationsGet(page: Page, path: string) {
  const response = await page.request.get(`/api/operations/${path}`);
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

async function submitUiCommand(page: Page, command: string) {
  const responsePromise = page.waitForResponse(response => {
    if (!response.url().endsWith("/api/operations/commands") || response.request().method() !== "POST") return false;
    try {
      return response.request().postDataJSON().command === command;
    } catch {
      return false;
    }
  });
  await page.getByRole("dialog").getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return body;
}

async function syntheticCommand(page: Page, command: string, targetId: string, expectedVersion: number, data: Record<string, unknown>) {
  const response = await page.request.post("/api/operations/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      expectedVersion,
      occurredAt: new Date().toISOString(),
      command,
      data,
    },
  });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

async function setupRouteStop(page: Page, stopSequence: number) {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await syntheticCommand(page, "OrderCreated", orderId, 0, {
    memberId: "ops-member",
    channel: "delivery",
    currency: "ARS",
    address: { street: "Dirección sintética 123" },
  });
  await syntheticCommand(page, "OrderQuoted", orderId, 1, {
    currency: "ARS",
    paymentMethod: "cash",
    items: [{ id: lineId, skuId: "ops-sku-a", quantity: "1", policyId: "ops-policy", scale: "escala-1" }],
    deliveryMinor: "50000",
    deliveryPolicyEvidence: syntheticEvidence,
  });
  const confirmation = await syntheticCommand(page, "OrderConfirmed", orderId, 2, {
    quoteVersion: 1,
    acceptance: syntheticEvidence,
  }) as { result: { deliveryId: string } };
  const deliveryId = confirmation.result.deliveryId;
  const confirmedOrder = await operationsGet(page, `orders/${orderId}`) as {
    order: { id: string; commercialState: string; fulfillmentState: string; quoteVersion: number };
    deliveries: Array<{ id: string; status: string; routeId: string | null }>;
  };
  expect(confirmedOrder.order).toMatchObject({ id: orderId, commercialState: "confirmed", fulfillmentState: "unprepared", quoteVersion: 1 });
  expect(confirmedOrder.deliveries).toContainEqual(expect.objectContaining({ id: deliveryId, status: "pending", routeId: null }));
  const routesBeforeAssignment = await operationsGet(page, "routes") as {
    versions: Record<string, number>;
  };
  const deliveryVersion = routesBeforeAssignment.versions[deliveryId];
  expect(Number.isSafeInteger(deliveryVersion), `Falta versión para la entrega ${deliveryId}`).toBe(true);
  await syntheticCommand(page, "DeliveryAssigned", deliveryId, deliveryVersion, {
    routeId: "ops-route",
    driverId: "ops-driver",
    stopSequence,
    evidence: syntheticEvidence,
  });
  return { orderId, deliveryId };
}

function collectPageCommandWrites(page: Page) {
  const writes: Array<Record<string, unknown>> = [];
  page.on("request", request => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (url.pathname === "/api/operations/commands") writes.push(request.postDataJSON() as Record<string, unknown>);
  });
  return writes;
}

test("an empty planned route stays visible with its driver, date, and translated status", async ({ page }) => {
  await login(page);
  const shiftDate = "2099-07-15";
  await page.getByRole("button", { name: "Rutas y entregas", exact: true }).click();
  await page.locator(".ops-header-actions").getByRole("button", { name: "＋ Nueva ruta", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Repartidor autorizado").selectOption("ops-driver");
  await dialog.getByLabel("Fecha del turno").fill(shiftDate);
  const receipt = await submitUiCommand(page, "RouteCreated") as {
    targetId: string;
    result: { route: { id: string; driverId: string; shiftDate: string; status: string } };
  };

  const routeRow = page.locator("tbody tr").filter({ hasText: shiftDate }).filter({ hasText: "Repartidor de ensayo" });
  await expect(routeRow).toBeVisible();
  await expect(routeRow.getByRole("cell").nth(2)).toHaveText("Programado");
  const routes = await operationsGet(page, "routes") as {
    items: Array<{ id: string; driverId: string; shiftDate: string; status: string; closedWithPending: boolean }>;
    deliveries: Array<{ routeId: string }>;
    versions: Record<string, number>;
  };
  const persisted = routes.items.find(route => route.id === receipt.targetId);
  expect(receipt.result.route.id).toBe(receipt.targetId);
  expect(persisted).toMatchObject({ id: receipt.targetId, driverId: "ops-driver", shiftDate, status: "planned", closedWithPending: false });
  expect(routes.deliveries.some(delivery => delivery.routeId === receipt.targetId)).toBe(false);
  expect(routes.versions[receipt.targetId]).toBe(1);
});

test("route-order editing is local until confirmed and stale drafts require a fresh snapshot", async ({ page }) => {
  await login(page);
  const stopB = await setupRouteStop(page, 2);
  const stopC = await setupRouteStop(page, 3);
  const before = await operationsGet(page, "routes") as {
    items: Array<{ id: string }>;
    deliveries: Array<{ id: string; orderId: string; routeId: string | null; status: string; stopSequence: number }>;
    versions: Record<string, number>;
  };
  const route = before.items.find(item => item.id === "ops-route");
  expect(route).toBeDefined();
  const stopsBefore = before.deliveries
    .filter(delivery => delivery.routeId === "ops-route" && delivery.status !== "cancelled")
    .sort((left, right) => left.stopSequence - right.stopSequence)
    .map(delivery => delivery.id);
  expect(stopsBefore).toHaveLength(3);
  expect(stopsBefore).toEqual(expect.arrayContaining([stopB.deliveryId, stopC.deliveryId]));
  expect(before.deliveries.find(delivery => delivery.id === stopB.deliveryId)).toMatchObject({ routeId: "ops-route", status: "assigned", stopSequence: 2 });
  expect(before.deliveries.find(delivery => delivery.id === stopC.deliveryId)).toMatchObject({ routeId: "ops-route", status: "assigned", stopSequence: 3 });
  const routeVersionBefore = before.versions["ops-route"];
  expect(Number.isSafeInteger(routeVersionBefore)).toBe(true);
  const existingDelivery = before.deliveries.find(delivery => delivery.orderId === "ops-delivery-order" && delivery.routeId === "ops-route");
  expect(existingDelivery).toBeDefined();
  expect(stopsBefore).toEqual([existingDelivery!.id, stopB.deliveryId, stopC.deliveryId]);
  const titleA = `Pedido #${existingDelivery!.orderId}`;
  const titleB = `Pedido #${stopB.orderId.slice(0, 8).toUpperCase()}`;
  const titleC = `Pedido #${stopC.orderId.slice(0, 8).toUpperCase()}`;

  await page.getByRole("button", { name: "Rutas y entregas", exact: true }).click();
  const refresh = page.waitForResponse(response => response.url().includes("/api/operations/routes") && response.request().method() === "GET");
  await page.getByRole("button", { name: "Actualizar consola" }).click();
  await refresh;
  const startEditor = page.getByRole("button", { name: /^Cambiar orden de paradas · .* · Repartidor de ensayo$/ });
  await expect(startEditor).toBeVisible();
  await expect(startEditor).toBeEnabled();
  const writes = collectPageCommandWrites(page);

  // Opening, changing a local draft, and cancelling must not issue a command or persist an order.
  await startEditor.click();
  let editor = page.getByRole("region", { name: /^Editar orden de paradas/ });
  let preview = editor.getByRole("list", { name: "Vista previa humana del recorrido" });
  await expect(preview.locator("li").nth(0)).toContainText(titleA);
  await expect(preview.locator("li").nth(1)).toContainText(titleB);
  await expect(preview.locator("li").nth(2)).toContainText(titleC);
  await editor.getByRole("button", { name: `Bajar ${titleA} una posición` }).click();
  await expect(preview.locator("li").nth(0)).toContainText(titleB);
  await expect(preview.locator("li").nth(1)).toContainText(titleA);
  await expect(preview.locator("li").nth(2)).toContainText(titleC);
  await editor.getByRole("button", { name: "Cancelar edición", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(writes).toEqual([]);
  const afterCancel = await operationsGet(page, "routes") as typeof before;
  expect(afterCancel.deliveries.filter(delivery => delivery.routeId === "ops-route" && delivery.status !== "cancelled")
    .sort((left, right) => left.stopSequence - right.stopSequence).map(delivery => delivery.id)).toEqual(stopsBefore);
  expect(afterCancel.versions["ops-route"]).toBe(routeVersionBefore);

  // A concurrent, valid API command changes the route while a UI draft is open.
  await startEditor.click();
  editor = page.getByRole("region", { name: /^Editar orden de paradas/ });
  preview = editor.getByRole("list", { name: "Vista previa humana del recorrido" });
  await editor.getByRole("button", { name: `Bajar ${titleA} una posición` }).click();
  await expect(preview.locator("li").nth(0)).toContainText(titleB);
  await expect(preview.locator("li").nth(1)).toContainText(titleA);
  await expect(preview.locator("li").nth(2)).toContainText(titleC);
  for (const name of [
    `Bajar ${titleB} una posición`,
    `Subir ${titleA} una posición`,
    `Bajar ${titleA} una posición`,
    `Subir ${titleC} una posición`,
  ]) await expect(editor.getByRole("button", { name })).toBeEnabled();
  await expect(editor.getByRole("button", { name: "Agregar evidencia y revisar" })).toBeEnabled();
  const externalOrder = [stopC.deliveryId, stopB.deliveryId, existingDelivery!.id];
  const concurrentReceipt = await syntheticCommand(page, "RouteReordered", "ops-route", routeVersionBefore, {
    deliveryIds: externalOrder,
    evidence: syntheticEvidence,
  }) as { result: { deliveryIds: string[] } };
  expect(concurrentReceipt.result.deliveryIds).toEqual(externalOrder);
  const externalState = await operationsGet(page, "routes") as typeof before;
  expect(externalState.deliveries
    .filter(delivery => delivery.routeId === "ops-route" && delivery.status !== "cancelled")
    .sort((left, right) => left.stopSequence - right.stopSequence).map(delivery => delivery.id)).toEqual(externalOrder);
  expect(externalState.versions["ops-route"]).toBe(routeVersionBefore + 1);
  const refreshedRoutes = page.waitForResponse(response => response.url().includes("/api/operations/routes") && response.request().method() === "GET");
  await page.getByRole("button", { name: "Actualizar consola" }).click();
  await refreshedRoutes;
  await expect(editor.getByRole("alert")).toContainText("La ruta cambió desde que abriste este borrador");
  await expect(preview.locator("li").nth(0)).toContainText(titleB);
  await expect(preview.locator("li").nth(1)).toContainText(titleA);
  await expect(preview.locator("li").nth(2)).toContainText(titleC);
  for (const name of [
    `Bajar ${titleB} una posición`,
    `Subir ${titleA} una posición`,
    `Bajar ${titleA} una posición`,
    `Subir ${titleC} una posición`,
  ]) await expect(editor.getByRole("button", { name })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Agregar evidencia y revisar" })).toBeDisabled();
  expect(writes).toEqual([]);

  // Cancelling and reopening captures the new revision. Only this current draft may write.
  await editor.getByRole("button", { name: "Cancelar edición", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await startEditor.click();
  editor = page.getByRole("region", { name: /^Editar orden de paradas/ });
  preview = editor.getByRole("list", { name: "Vista previa humana del recorrido" });
  await expect(preview.locator("li").nth(0)).toContainText(titleC);
  await expect(preview.locator("li").nth(1)).toContainText(titleB);
  await expect(preview.locator("li").nth(2)).toContainText(titleA);
  await editor.getByRole("button", { name: `Bajar ${titleC} una posición` }).click();
  await expect(preview.locator("li").nth(0)).toContainText(titleB);
  await expect(preview.locator("li").nth(1)).toContainText(titleC);
  await expect(preview.locator("li").nth(2)).toContainText(titleA);
  await editor.getByRole("button", { name: "Agregar evidencia y revisar" }).click();
  const commandDialog = page.getByRole("dialog");
  await commandDialog.getByLabel("Evidencia del cambio de recorrido").fill("Revisión sintética del orden propuesto.");
  const routeVersionAfterExternal = (await operationsGet(page, "routes") as typeof before).versions["ops-route"];
  const expectedFinalOrder = [stopB.deliveryId, stopC.deliveryId, existingDelivery!.id];
  const confirmation = page.waitForResponse(response => {
    if (!response.url().endsWith("/api/operations/commands") || response.request().method() !== "POST") return false;
    try {
      return response.request().postDataJSON().command === "RouteReordered";
    } catch {
      return false;
    }
  });
  await commandDialog.getByRole("button", { name: "Revisar y registrar", exact: true }).click();
  const accepted = await confirmation;
  const acceptedBody = await accepted.json() as { result: { deliveryIds: string[] } };
  expect(accepted.status(), JSON.stringify(acceptedBody)).toBe(200);
  expect(acceptedBody.result.deliveryIds).toEqual(expectedFinalOrder);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ command: "RouteReordered", targetId: "ops-route", expectedVersion: routeVersionAfterExternal });
  expect((writes[0]!.data as { deliveryIds: string[] }).deliveryIds).toEqual(expectedFinalOrder);

  const finalState = await operationsGet(page, "routes") as typeof before;
  const persistedOrder = finalState.deliveries
    .filter(delivery => delivery.routeId === "ops-route" && delivery.status !== "cancelled")
    .sort((left, right) => left.stopSequence - right.stopSequence)
    .map(delivery => delivery.id);
  expect(persistedOrder).toEqual(expectedFinalOrder);
  expect(finalState.versions["ops-route"]).toBe(routeVersionAfterExternal + 1);
  for (const id of expectedFinalOrder) expect(finalState.versions[id]).toBe(before.versions[id]! + 2);
});

function gateRecord(id: string) {
  return {
    id,
    status: "approved",
    evidence: { note: `Revisión sintética de ${id}.` },
    approvedBy: "01000000-0000-4000-8000-000000000001",
    reviewedBy: "01000000-0000-4000-8000-000000000002",
    approvedAt: "2026-10-05T12:00:00.000Z",
  };
}

test("replacement guide shows missing evidence and never declares cutover complete", async ({ page }) => {
  let allApproved = false;
  const authorityReads: string[] = [];
  const writes: string[] = [];

  // Mirrors GET /api/operations/authority: { authority, gates }.
  await page.route("**/api/operations/authority", async route => {
    expect(route.request().method()).toBe("GET");
    authorityReads.push(route.request().url());
    const gates = cutoverGateIds
      .slice(0, allApproved ? cutoverGateIds.length : cutoverGateIds.length - 1)
      .map(gateRecord);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authority: {
          id: "operations",
          mode: "shadow",
          epoch: 1,
          firstRealWriteAt: null,
          approvedBy: null,
          evidence: null,
          updatedAt: "2026-10-05T12:00:00.000Z",
        },
        gates,
      }),
    });
  });

  await login(page);
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/operations/") && request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.getByRole("button", { name: "Habilitación y auditoría", exact: true }).click();
  const guide = page.locator(".rr-readiness");
  await expect(guide.getByRole("heading", { name: "Revisión del reemplazo total" })).toBeVisible();
  await expect(guide.locator(".rr-gate")).toHaveCount(14);
  await expect(guide.getByText("Revisión registrada", { exact: true })).toHaveCount(13);
  await expect(guide.getByText("Sin evidencia registrada", { exact: true })).toHaveCount(1);
  await expect(guide.locator(".rr-gate").filter({ hasText: "Decisión de traspaso" }))
    .toContainText("Sin evidencia registrada");
  await expect(guide.locator(".rr-boundary"))
    .toContainText("la guía no declara por sí sola que el reemplazo esté ejecutado");

  allApproved = true;
  const refreshedAuthority = page.waitForResponse(response =>
    response.url().includes("/api/operations/authority") && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Actualizar consola" }).click();
  expect((await refreshedAuthority).status()).toBe(200);
  await expect(guide.getByText("Revisión registrada", { exact: true })).toHaveCount(14);
  await expect(guide.locator(".rr-boundary"))
    .toContainText("la guía no declara por sí sola que el reemplazo esté ejecutado");
  await expect(guide.getByRole("heading", { name: /reemplazo completado|corte realizado/i })).toHaveCount(0);
  expect(authorityReads.length).toBeGreaterThanOrEqual(2);
  expect(writes).toEqual([]);
});
