import { buildDashboardExport, type DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { mdToPdf } from "md-to-pdf";

function fmt(value: number): string {
    return Math.round(value).toLocaleString("cs-CZ");
}

function buildMarkdownFromExport(data: DashboardExport): string {
    const investmentScore = data.analysis.investmentScore;
    const momentum = data.analysis.momentum;
    const latestTrend = data.analysis.trends.at(-1);
    const latestTrendChange = latestTrend?.qoqChange;

    return `# REAS Investment Analysis Report

**District:** ${data.meta.target.district} | **Type:** ${data.meta.target.constructionType} | **Disposition:** ${data.meta.target.disposition}
**Target:** ${fmt(data.meta.target.price)} CZK | ${data.meta.target.area} m2 | ${fmt(data.meta.target.price / data.meta.target.area)} CZK/m2
**Generated:** ${new Date(data.meta.generatedAt).toLocaleDateString("cs-CZ")}

---

## Investment Score: ${investmentScore?.grade ?? "N/A"} (${investmentScore?.overall ?? 0}/100)

**Recommendation:** ${investmentScore?.recommendation ?? "N/A"}

${investmentScore?.reasoning?.map((reason) => `- ${reason}`).join("\n") ?? ""}

## Price Comparables (${data.listings.sold.length} sold listings)

| Metric | Value |
|--------|-------|
| Median CZK/m2 | ${fmt(data.analysis.comparables.median)} |
| Mean CZK/m2 | ${fmt(data.analysis.comparables.mean)} |
| P25-P75 range | ${fmt(data.analysis.comparables.p25)} - ${fmt(data.analysis.comparables.p75)} |
| Target percentile | ${data.analysis.comparables.targetPercentile.toFixed(1)}% |

## Market Trends

| Metric | Value |
|--------|-------|
| Direction | ${momentum?.direction ?? "N/A"} |
| YoY change | ${latestTrendChange !== undefined && latestTrendChange !== null ? `${latestTrendChange.toFixed(1)}%` : "N/A"} |
| Velocity | ${momentum ? `${momentum.priceVelocity.toFixed(1)}%/quarter` : "N/A"} |

## Rental Yield

| Metric | Value |
|--------|-------|
| Gross yield | ${data.analysis.yield.grossYield.toFixed(2)}% |
| Net yield | ${data.analysis.yield.netYield.toFixed(2)}% |
| Payback years | ${Number.isFinite(data.analysis.yield.paybackYears) ? data.analysis.yield.paybackYears.toFixed(1) : "N/A"} |

## Time on Market

| Metric | Value |
|--------|-------|
| Median | ${data.analysis.timeOnMarket.median.toFixed(0)} days |
| Mean | ${data.analysis.timeOnMarket.mean.toFixed(0)} days |

## Discount Analysis

| Metric | Value |
|--------|-------|
| Median discount | ${data.analysis.discount.medianDiscount.toFixed(1)}% |
| Max discount | ${data.analysis.discount.maxDiscount.toFixed(1)}% |

## Provider Summary

${data.meta.providerSummary?.map((provider) => `- ${provider.provider} (${provider.sourceContract}): ${provider.count}${provider.error ? ` - ${provider.error}` : ""}`).join("\n") ?? "- No provider summary"}
`.trim();
}

export function buildMarkdownReport(analysis: FullAnalysis): string {
    return buildMarkdownFromExport(buildDashboardExport(analysis));
}

export function buildMarkdownReportFromExport(data: DashboardExport): string {
    return buildMarkdownFromExport(data);
}

export async function exportToPdf(analysis: FullAnalysis, outputPath: string): Promise<void> {
    const markdown = buildMarkdownReport(analysis);
    const pdf = await mdToPdf(
        { content: markdown },
        {
            pdf_options: {
                format: "A4",
                margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
            },
        }
    );

    if (!pdf?.content) {
        throw new Error("PDF generation failed");
    }

    await Bun.write(outputPath, pdf.content);
}

export async function exportDashboardToPdf(data: DashboardExport): Promise<Uint8Array> {
    const markdown = buildMarkdownReportFromExport(data);
    const pdf = await mdToPdf(
        { content: markdown },
        {
            pdf_options: {
                format: "A4",
                margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
            },
        }
    );

    if (!pdf?.content) {
        throw new Error("PDF generation failed");
    }

    return new Uint8Array(pdf.content);
}
