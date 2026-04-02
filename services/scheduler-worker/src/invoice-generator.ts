import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { PrismaClient } from '@bronco/db';

export interface DailyUsageRow {
  date: string; // 'YYYY-MM-DD'
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  baseCostUsd: number;
  billedCostUsd: number;
  requestCount: number;
}

export interface InvoiceData {
  clientName: string;
  invoiceNumber: number;
  periodStart: Date;
  periodEnd: Date;
  /** Billing multiplier applied to base cost. 1.25 = 25% markup, 1.0 = no markup. */
  markupMultiplier: number;
  dailyRows: DailyUsageRow[];
  totalBaseCostUsd: number;
  totalBilledCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

export async function aggregateDailyUsage(
  db: PrismaClient,
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
  /** Billing multiplier applied to base cost. 1.25 = 25% markup, 1.0 = no markup. */
  markupMultiplier: number,
): Promise<Omit<InvoiceData, 'clientName' | 'invoiceNumber' | 'markupMultiplier'>> {
  const rows = await db.$queryRaw<Array<{
    date: string;
    input_tokens: bigint;
    output_tokens: bigint;
    base_cost: number | null;
    request_count: bigint;
  }>>`
    SELECT
      DATE_TRUNC('day', created_at)::date::text AS date,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(cost_usd) AS base_cost,
      COUNT(*)::bigint AS request_count
    FROM ai_usage_logs
    WHERE client_id = ${clientId}::uuid
      AND created_at >= ${periodStart}
      AND created_at < ${periodEnd}
    GROUP BY DATE_TRUNC('day', created_at)
    ORDER BY DATE_TRUNC('day', created_at)
  `;

  let totalBase = 0;
  let totalBilled = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalReqs = 0;

  const dailyRows: DailyUsageRow[] = rows.map((r) => {
    const inputTokens = Number(r.input_tokens);
    const outputTokens = Number(r.output_tokens);
    const baseCostUsd = Number(r.base_cost ?? 0);
    const billedCostUsd = baseCostUsd * markupMultiplier;
    const requestCount = Number(r.request_count);

    totalBase += baseCostUsd;
    totalBilled += billedCostUsd;
    totalIn += inputTokens;
    totalOut += outputTokens;
    totalReqs += requestCount;

    return {
      date: r.date,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      baseCostUsd,
      billedCostUsd,
      requestCount,
    };
  });

  return {
    periodStart,
    periodEnd,
    dailyRows,
    totalBaseCostUsd: totalBase,
    totalBilledCostUsd: totalBilled,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    requestCount: totalReqs,
  };
}

export async function generateInvoicePdf(data: InvoiceData, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = createWriteStream(outputPath);
    doc.pipe(stream);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('AI Usage Invoice', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Client: ${data.clientName}`);
    doc.text(`Invoice #: ${String(data.invoiceNumber).padStart(4, '0')}`);
    doc.text(`Period: ${data.periodStart.toISOString().slice(0, 10)} to ${data.periodEnd.toISOString().slice(0, 10)}`);
    doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`);
    const markupDisplay = data.markupMultiplier === 1.0
      ? 'No markup (1\u00D7)'
      : `${((data.markupMultiplier - 1) * 100).toFixed(1)}% markup (${data.markupMultiplier}\u00D7)`;
    doc.text(`Rate: ${markupDisplay}`);
    doc.moveDown(1);

    // Daily breakdown table header
    doc.fontSize(10).font('Helvetica-Bold');
    const col = { date: 50, reqs: 160, tokIn: 220, tokOut: 300, base: 380, billed: 460 };
    const headerY = doc.y;
    doc.text('Date', col.date, headerY);
    doc.text('Requests', col.reqs, headerY);
    doc.text('Tok In', col.tokIn, headerY);
    doc.text('Tok Out', col.tokOut, headerY);
    doc.text('Base ($)', col.base, headerY);
    doc.text('Billed ($)', col.billed, headerY);
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    // Daily rows
    doc.font('Helvetica').fontSize(9);
    for (const row of data.dailyRows) {
      const y = doc.y;
      doc.text(row.date, col.date, y);
      doc.text(String(row.requestCount), col.reqs, y);
      doc.text(row.inputTokens.toLocaleString(), col.tokIn, y);
      doc.text(row.outputTokens.toLocaleString(), col.tokOut, y);
      doc.text(row.baseCostUsd.toFixed(4), col.base, y);
      doc.text(row.billedCostUsd.toFixed(4), col.billed, y);
      doc.moveDown(0.8);
    }

    // Totals
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10);
    const totY = doc.y;
    doc.text('TOTAL', col.date, totY);
    doc.text(String(data.requestCount), col.reqs, totY);
    doc.text(data.totalInputTokens.toLocaleString(), col.tokIn, totY);
    doc.text(data.totalOutputTokens.toLocaleString(), col.tokOut, totY);
    doc.text(`$${data.totalBaseCostUsd.toFixed(4)}`, col.base, totY);
    doc.text(`$${data.totalBilledCostUsd.toFixed(4)}`, col.billed, totY);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

export function nextInvoiceNumber(lastInvoiceNumber: number | null): number {
  return (lastInvoiceNumber ?? 0) + 1;
}

export function ensureInvoiceDir(storagePath: string): void {
  mkdirSync(storagePath, { recursive: true });
}

export function computeNextPeriodEnd(
  billingPeriod: string,
  billingAnchorDay: number,
  lastPeriodEnd: Date | null,
): Date | null {
  const now = new Date();
  const base = lastPeriodEnd ?? new Date(now.getFullYear(), now.getMonth(), 1); // default: start of current month

  if (billingPeriod === 'weekly') {
    return new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  if (billingPeriod === 'biweekly') {
    return new Date(base.getTime() + 14 * 24 * 60 * 60 * 1000);
  }
  if (billingPeriod === 'monthly') {
    if (lastPeriodEnd === null) {
      // First invoice ever: use the anchor day in the current month if it hasn't passed
      // yet, otherwise use the anchor day in the next month. Compare at date granularity
      // (start-of-day) so the entire anchor day counts as "not yet passed".
      const anchorThisMonth = new Date(
        base.getFullYear(),
        base.getMonth(),
        Math.min(billingAnchorDay, daysInMonth(base.getFullYear(), base.getMonth())),
      );
      const nowStartOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (nowStartOfDay < anchorThisMonth) {
        // Anchor day is still upcoming this month — use it as the first period end
        return anchorThisMonth;
      }
      // Anchor day has already passed this month — use the anchor in next month
      const nextMonth = new Date(base);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextMonth.setDate(Math.min(billingAnchorDay, daysInMonth(nextMonth.getFullYear(), nextMonth.getMonth())));
      return nextMonth;
    }
    const nextMonth = new Date(base);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(Math.min(billingAnchorDay, daysInMonth(nextMonth.getFullYear(), nextMonth.getMonth())));
    return nextMonth;
  }
  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}
