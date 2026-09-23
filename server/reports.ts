import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { getState } from "./state.js";
// Prevent spreadsheet formula execution in exported user-controlled cells.
export function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}
export async function exportReport(
  res: Response,
  state: Awaited<ReturnType<typeof getState>>,
  format: "csv" | "xlsx" | "pdf",
  from?: string,
  to?: string,
) {
  const sales = state.sales.filter(
    (s) => (!from || s.date >= from) && (!to || s.date <= to),
  );
  const rows = sales.flatMap((s) =>
    s.items.map((i) => ({
      Fecha: s.date,
      Ticket: s.id,
      Socio: state.customers.find((c) => c.id === s.customerId)?.name || "",
      Producto: i.name,
      Responsable:
        state.users.find((u) => u.id === i.ownerId)?.name || i.ownerId,
      Cantidad: i.quantity / 1000,
      Ingresos: i.revenue / 100,
      Costo: i.cost / 100,
      Margen: (i.revenue - i.cost) / 100,
      Moneda: state.settings.currency,
    })),
  );
  const columns = [
    "Fecha",
    "Ticket",
    "Socio",
    "Producto",
    "Responsable",
    "Cantidad",
    "Ingresos",
    "Costo",
    "Margen",
    "Moneda",
  ];
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="raiz-reporte-${state.today}.${format}"`,
  );
  if (format === "csv") {
    res
      .type("text/csv; charset=utf-8")
      .send(
        "\uFEFF" +
          [
            columns.map(csvCell).join(","),
            ...rows.map((r) => Object.values(r).map(csvCell).join(",")),
          ].join("\r\n"),
      );
    return;
  }
  if (format === "xlsx") {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Ventas");
    sheet.columns = columns.map((c) => ({
      header: c,
      key: c,
      width: c === "Ticket" ? 30 : 22,
    }));
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF6D28D9" },
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const key of ["Ingresos", "Costo", "Margen"])
      sheet.getColumn(key).numFmt = `"${state.settings.currency}" #,##0.00`;
    res.type(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    await book.xlsx.write(res);
    res.end();
    return;
  }
  const doc = new PDFDocument({
    margin: 45,
    size: "A4",
    info: { Title: "Liquidación por responsable · Raíz" },
  });
  res.type("application/pdf");
  doc.pipe(res);
  const money = (n: number) =>
    new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: state.settings.currency,
    }).format(n / 100);
  doc.fontSize(24).fillColor("#6d28d9").text(state.settings.clubName);
  doc
    .moveDown(0.5)
    .fontSize(12)
    .fillColor("#222222")
    .text("Liquidación por responsable");
  doc
    .fontSize(10)
    .fillColor("#666666")
    .text(
      `${from || "Inicio"} a ${to || state.today} · Emitido ${state.today} · ${state.settings.currency}`,
    );
  doc.moveDown(2);
  const owners = new Set(rows.map((r) => r.Responsable));
  for (const owner of owners) {
    if (doc.y > 680) doc.addPage();
    const own = rows.filter((r) => r.Responsable === owner);
    const revenue = Math.round(own.reduce((n, r) => n + r.Ingresos, 0) * 100);
    const cost = Math.round(own.reduce((n, r) => n + r.Costo, 0) * 100);
    doc.fillColor("#222222").fontSize(13).text(owner);
    doc
      .moveDown(0.4)
      .fontSize(10)
      .text(
        `Ingresos: ${money(revenue)}     Costo: ${money(cost)}     Margen: ${money(revenue - cost)}`,
      );
    doc.moveDown(1.2);
  }
  doc.moveDown().fontSize(11).text(`Total de ventas: ${sales.length}`);
  doc.text(`Ingresos netos: ${money(sales.reduce((n, s) => n + s.total, 0))}`);
  doc.text(
    `Margen bruto: ${money(sales.reduce((n, s) => n + s.total - s.cost, 0))}`,
  );
  doc
    .moveDown(2)
    .fontSize(9)
    .fillColor("#777777")
    .text("Informe interno de gestión. No sustituye un comprobante fiscal.");
  doc.end();
}
