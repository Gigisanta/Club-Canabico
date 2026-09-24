import type { Response } from "express";
import { once } from "node:events";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Prisma, type User } from "@prisma/client";
import { db, getSettings } from "./db.js";
import { ownerScope } from "./state.js";
import { businessDate } from "../shared/domain.js";

// Prevent spreadsheet formula execution in exported user-controlled cells.
export function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}

const columns = ["Fecha", "Ticket", "Socio", "Producto", "Responsable", "Cantidad", "Ingresos", "Costo", "Margen", "Moneda"] as const;
type ReportRow = Record<(typeof columns)[number], string | number>;

async function* batches(user: User, requested: string | undefined, from?: string, to?: string): AsyncGenerator<{ rows: ReportRow[]; salesCount: number; total: number; cost: number }> {
  const ownerId = ownerScope(user, requested);
  const settings = await getSettings();
  const where: Prisma.SaleWhereInput = {
    ...(ownerId ? { items: { some: { ownerId } } } : {}),
    ...((from || to) ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
  let cursor: { id: string } | undefined;
  for (;;) {
    const sales = await db.sale.findMany({
      where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500,
      ...(cursor ? { cursor, skip: 1 } : {}),
      select: { id: true, date: true, customer: { select: { name: true } }, total: true, cost: true,
        items: { ...(ownerId ? { where: { ownerId } } : {}), select: { name: true, quantity: true, revenue: true, cost: true, owner: { select: { name: true } } } },
      },
    });
    if (!sales.length) break;
    const rows: ReportRow[] = [];
    let total = 0;
    let cost = 0;
    for (const sale of sales) {
      total += ownerId ? sale.items.reduce((n, item) => n + item.revenue, 0) : sale.total;
      cost += ownerId ? sale.items.reduce((n, item) => n + item.cost, 0) : sale.cost;
      for (const item of sale.items) rows.push({
        Fecha: sale.date, Ticket: sale.id, Socio: sale.customer.name,
        Producto: item.name, Responsable: item.owner.name,
        Cantidad: item.quantity / 1000, Ingresos: item.revenue / 100,
        Costo: item.cost / 100, Margen: (item.revenue - item.cost) / 100,
        Moneda: settings.currency,
      });
    }
    yield { rows, salesCount: sales.length, total, cost };
    cursor = { id: sales.at(-1)!.id };
    if (sales.length < 500) break;
  }
}

export async function exportReport(res: Response, user: User, requested: string | undefined, format: "csv" | "xlsx" | "pdf", from?: string, to?: string) {
  const settings = await getSettings();
  const today = businessDate(settings);
  res.setHeader("Content-Disposition", `attachment; filename="raiz-reporte-${today}.${format}"`);
  if (format === "csv") {
    res.type("text/csv; charset=utf-8");
    res.write("\uFEFF" + columns.map(csvCell).join(",") + "\r\n");
    for await (const batch of batches(user, requested, from, to)) {
      for (const row of batch.rows) {
        if (res.destroyed) return;
        if (!res.write(columns.map((key) => csvCell(row[key])).join(",") + "\r\n")) await once(res, "drain");
      }
    }
    res.end();
    return;
  }
  if (format === "xlsx") {
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const sheet = book.addWorksheet("Ventas");
    sheet.columns = columns.map((key) => ({ header: key, key, width: key === "Ticket" ? 30 : 22 }));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315E43" } };
    sheet.getRow(1).commit();
    for (const key of ["Ingresos", "Costo", "Margen"]) sheet.getColumn(key).numFmt = `"${settings.currency}" #,##0.00`;
    for await (const batch of batches(user, requested, from, to)) {
      if (res.destroyed) return;
      for (const row of batch.rows) sheet.addRow(row).commit();
    }
    sheet.commit();
    await book.commit();
    return;
  }
  const ownerId = ownerScope(user, requested);
  const dates = Prisma.sql`${from ? Prisma.sql`AND s.date >= ${from}` : Prisma.empty}
    ${to ? Prisma.sql`AND s.date <= ${to}` : Prisma.empty}`;
  const [totals, ownerRows] = await Promise.all([
    ownerId ? db.$queryRaw<Array<{ count: bigint; total: bigint; cost: bigint }>>`
      SELECT COUNT(DISTINCT s.id)::bigint AS count, COALESCE(SUM(i.revenue), 0)::bigint AS total,
        COALESCE(SUM(i.cost), 0)::bigint AS cost
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE i."ownerId" = ${ownerId} ${dates}`
    : db.$queryRaw<Array<{ count: bigint; total: bigint; cost: bigint }>>`
      SELECT COUNT(*)::bigint AS count, COALESCE(SUM(s.total), 0)::bigint AS total,
        COALESCE(SUM(s.cost), 0)::bigint AS cost FROM "Sale" s WHERE TRUE ${dates}`,
    db.$queryRaw<Array<{ name: string; revenue: bigint; cost: bigint }>>`
      SELECT u.name, COALESCE(SUM(i.revenue), 0)::bigint AS revenue,
        COALESCE(SUM(i.cost), 0)::bigint AS cost FROM "SaleItem" i
      JOIN "Sale" s ON s.id = i."saleId" JOIN "User" u ON u.id = i."ownerId"
      WHERE TRUE ${dates} ${ownerId ? Prisma.sql`AND i."ownerId" = ${ownerId}` : Prisma.empty}
      GROUP BY u.name ORDER BY u.name`,
  ]);
  const salesCount = Number(totals[0]?.count || 0);
  const total = Number(totals[0]?.total || 0);
  const cost = Number(totals[0]?.cost || 0);
  const doc = new PDFDocument({ margin: 45, size: "A4", info: { Title: "Liquidación por responsable · Raíz" } });
  res.type("application/pdf");
  doc.pipe(res);
  const money = (n: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: settings.currency }).format(n / 100);
  doc.fontSize(24).fillColor("#315e43").text(settings.clubName);
  doc.moveDown(0.5).fontSize(12).fillColor("#222222").text("Liquidación por responsable");
  doc.fontSize(10).fillColor("#666666").text(`${from || "Inicio"} a ${to || today} · Emitido ${today} · ${settings.currency}`);
  doc.moveDown(2);
  for (const row of ownerRows) {
    if (doc.y > 680) doc.addPage();
    doc.fillColor("#222222").fontSize(13).text(row.name);
    const revenue = Number(row.revenue);
    const ownerCost = Number(row.cost);
    doc.moveDown(0.4).fontSize(10).text(`Ingresos: ${money(revenue)}     Costo: ${money(ownerCost)}     Margen: ${money(revenue - ownerCost)}`);
    doc.moveDown(1.2);
  }
  doc.moveDown().fontSize(11).text(`Total de ventas: ${salesCount}`);
  doc.text(`Ingresos netos: ${money(total)}`);
  doc.text(`Margen bruto: ${money(total - cost)}`);
  doc.moveDown(2).fontSize(9).fillColor("#777777").text("Informe interno de gestión. No sustituye un comprobante fiscal.");
  doc.end();
}
