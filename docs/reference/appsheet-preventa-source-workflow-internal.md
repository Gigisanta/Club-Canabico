# AppSheet `Pre_Venta` workflow: implementation design

**Internal implementation note.** This records the captured source behavior and a safe Bombo mapping proposal. It is not a claim of complete AppSheet parity, and no production code or runtime action was changed while the currency policy is unresolved.

## Decision still required

`Pre_Venta` has no captured currency field. Bombo stores `OperationOrder.currency` as a required string, and the current shared invoice input accepts only `ARS` or `USD` (`prisma/schema.prisma`, `shared/operations/appsheet.ts`). The form's `ARS` default is not evidence that the source amounts are ARS. Before implementation, decide whether this source workflow is always ARS, always USD, or may vary and, if it varies, identify the authoritative source for each record. Do not default, infer from payment method, or persist a made-up currency. The current invoice input/quote builder is not a substitute for this source-specific contract.

## Captured form and source actions

The sanitized AppSheet inventory records this order:

1. `Pre_Venta_Form`: sale date, then client.
2. `Control_Preventa_Detail`: related detail rows, segment, header grams and sale totals, payment/transfer values, delivery date, registered and declared addresses, zone, motorcycle tariffs/transfers/admin/total, and note.
3. Each `Pre_Detalle_Fact` row: product type, article, variety, grams, per-gram line price, line total, tariff scale.

Only `Pre_Fechaventa` is marked with `TODAY()` in the captured header schema. Header segment, grams, subtotal, payment and transfer fields, delivery/address/zone fields, motorcycle amounts, total and note are operator-entered values. They are independent inputs: preserve them as entered; do not derive header grams or subtotal from details, or total/service amounts from other amounts.

On the detail schema, `Pre_Fecha` uses `NOW()`. `Pre_Cantidad_Gr` is Decimal with two decimal digits and no captured min/max/step/`Valid_If`; preserve fractional quantities and do not invent a positive lower bound or cap. The captured line formulas are:

- `Pre_Escala_Tarifaria`: select the catalog band for the manually selected segment (5, 10, 15, or 30 grams).
- `Pre_Precio_gramo_línea`: look up the selected catalog price for 5, 10, 15, 20, 25, or 30 grams; default to zero.
- `Pre_Valor_Total`: quantity multiplied by the line price.

The source segment enum is exactly `Menos de 10 gramos`, `Entre 10 y 15 gramos`, `Entre 15 y 30 gramos`, and `más de 30 gramos`. The 20/25-gram catalog prices are not selected by those four captured segment choices. Keep the chosen segment, formula band, captured unit price, and captured line total as separate facts; do not silently substitute a nearby catalog band.

The captured `Confirmar_preventa` composite runs `Crear Factura`, copies child rows with `Carga_Detalle_Factura`, runs `Crear_Factura_Moto`, then marks the preorder confirmed. `Crear Factura` copies header fields directly rather than recalculating them. Its payment mapping is `Efectivo` to ARS and other captured choices to `Transferencia`. The motorcycle action is unconditional and sets service total to client tariff plus admin tariff. No captured step recalculates the other manual header totals.

## Confirmed source inconsistencies and limits

- The scale formula emits `Precio_5_Gramos`, `Precio_10_Gramos`, `Precio_15_Gramos`, or `Precio_30_Gramos`; the copy action recognizes only `Pack 5 (5 a 10 Gr)`, `Pack 10 (10 a 15 Gr)`, `Pack 15 (15 a 30 Gr)`, and `Pack 30 (más de 30 Gr)`, with an empty-string default. These declared outputs and inputs do not match, so a copied `Escala_Tarifaria` is expected to be blank when the formula emits one of its named price bands. This is derived from the captured expressions; it was not executed in AppSheet. Preserve the original expressions and historical values. The approved migration plan permits a documented safe equivalent for new operations once the error and its correction are verified; no extra owner approval is required by this note.
- The enum uses lowercase `más`, while the formula case is captured with uppercase `Más`. The official [`SWITCH()` reference](https://support.google.com/appsheet/answer/10107700?hl=en) describes matching cases but does not settle case sensitivity. Whether the over-30 branch matches is unresolved. Do not normalize the text or claim its runtime outcome from the capture alone.
- `Bot_Carga_Venta_Stock` listens for additions and updates to `C_Detalle_Fact` and adds `Mov_Stock1` rows for positive quantities. The captured confirmation adds details, so the source configuration includes a stock-movement path. Bombo's `InvoiceConfirmed` separately reserves stock inside its transaction (`server/operations/orders.ts`). If the new workflow writes into both paths, it must choose one authoritative movement path and prove it cannot double reserve or duplicate a movement. The capture has `fullParity:false`; it does not establish every external task or automation.
- AppSheet's exact `TODAY()`/`NOW()` timezone and client/runtime evaluation were not established by the available capture. A Bombo timestamp mapping needs an explicit authoritative timezone and must retain the date/timestamp as separate source facts.

Evidence inspected in the sanitized capture: `.local/appsheet-real-20261009/appsheet-definition-inventory-live-parity-final.json` for schema/formula declarations; `.local/appsheet-real-20261009/appsheet-definition-live-20261009-parity.html` around lines 59209–59272 and 59322+ for action mappings and composite order; `.local/appsheet-real-20261009/appsheet-bots-observed-1.001739.json` for stock bot triggers. These are captured definitions, not live behavioral proof.

## Proposed Bombo boundary after currency decision

Add a source-specific `Pre_Venta` input/update/confirm contract and preserve the existing native/generic `appsheet-invoice` behavior. Identify the source branch explicitly (for example `appsheet-preventa`) and dispatch updates and confirmation by `quote.source`; retain legacy preorders that lack the new source marker on their existing path. Keep the raw source header and source detail snapshot in a separately typed, versioned portion of the order quote so the source values/formula results are not replaced by the derived generic invoice quote.

The pending create and edit entry points should persist the entered header and child values, formula-derived price/total snapshots, and formula timestamps, without creating invoice, delivery, or stock effects. Pending edits need an expected version/idempotency guard. Confirmation should consume the saved source snapshot, validate the operator confirmation without adding a customer-consent step, and create the Bombo financial/stock/delivery effects once in a single transaction. A rejected command must leave the stored preorder and all effects unchanged; a failure after partial work must roll the transaction back. Keep the source's independently entered totals separate even if Bombo also calculates an operational projection.

Use decimal strings or other lossless decimal representation for raw amounts and grams at the input boundary. Convert money to Bombo's integer minor units only after currency, scale, and rounding behavior are resolved. The current capture gives Price fields two decimal places, but some related Number fields do not provide an equivalent precision rule; do not impose a rounding policy on those fields without evidence.

## Required behavior checks before calling the implementation complete

Exercise the actual command/form entry paths, not only formula helpers:

- Create a pending source preorder with manual header totals that intentionally differ from summed detail totals; verify the saved values remain independent and no stock, delivery, or confirmed-invoice effect appears.
- Edit a pending preorder, including a fractional two-decimal quantity and an empty/no-lot catalog source where the current pending workflow permits it; verify the draft is retained on command rejection and persisted source values remain unchanged.
- Reject invalid currency, malformed/missing line identities, stale version, and insufficient confirmation prerequisites; verify no command mutation or downstream effects.
- Confirm a valid source preorder; verify one order/line/stock/delivery effect per intended item, exact stored source values, and no duplicate stock movement.
- Inject a failure after the first transactional effect; verify rollback of the order state and all associated effects.
- Keep a regression case for the formula/copy scale mismatch and verify its documented safe equivalent in Bombo while retaining the original expression and historical values. Do not assert the unresolved `Más`/`más` runtime behavior without read-only AppSheet evidence. Leave the source unchanged.

These checks are a test plan only; no runner, database, service, AppSheet action, or test fixture was run for this note.
