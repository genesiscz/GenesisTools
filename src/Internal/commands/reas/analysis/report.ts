import { formatTable } from "@app/utils/table";
import pc from "picocolors";
import type { AnalysisFilters, MfRentalBenchmark, SrealityRental, TargetProperty } from "../types";
import type { ComparablesResult } from "./comparables";
import type { DiscountResult } from "./discount";
import type { YieldResult } from "./rental-yield";
import type { TimeOnMarketResult } from "./time-on-market";
import type { TrendsResult } from "./trends";

export interface FullAnalysis {
    comparables: ComparablesResult;
    trends: TrendsResult;
    yield: YieldResult;
    timeOnMarket: TimeOnMarketResult;
    discount: DiscountResult;
    rentalListings: SrealityRental[];
    mfBenchmarks: MfRentalBenchmark[];
    target: TargetProperty;
    filters: AnalysisFilters;
}

const SEPARATOR_WIDTH = 72;

function fmt(n: number): string {
    return Math.round(n).toLocaleString("cs-CZ");
}

function fmtDec(n: number, decimals: number): string {
    return n.toFixed(decimals);
}

function fmtMil(n: number): string {
    return `${(n / 1_000_000).toFixed(2)}M`;
}

function pctStr(n: number): string {
    const sign = n >= 0 ? "+" : "";
    return `${sign}${fmtDec(n, 1)}%`;
}

function pctColor(n: number): string {
    const str = pctStr(n);

    if (n > 0) {
        return pc.green(str);
    }

    if (n < 0) {
        return pc.red(str);
    }

    return pc.dim(str);
}

function truncAddr(addr: string, max = 35): string {
    if (addr.length <= max) {
        return addr;
    }

    return `${addr.slice(0, max - 3)}...`;
}

function sectionHeader(title: string): string {
    const sep = pc.dim("=".repeat(SEPARATOR_WIDTH));
    return `\n${sep}\n  ${pc.cyan(pc.bold(title))}\n${sep}`;
}

function labelValue(label: string, value: string, indent = 4): string {
    const pad = " ".repeat(indent);
    return `${pad}${pc.dim(label.padEnd(22))}${value}`;
}

function dispositionToVK(disposition: string): "VK1" | "VK2" | "VK3" | "VK4" | null {
    const match = disposition.match(/(\d)/);

    if (!match) {
        return null;
    }

    const rooms = parseInt(match[1], 10);

    if (rooms <= 1) {
        return "VK1";
    }

    if (rooms === 2) {
        return "VK2";
    }

    if (rooms === 3) {
        return "VK3";
    }

    return "VK4";
}

function renderSoldComparables(analysis: FullAnalysis): string {
    const { comparables, target, filters } = analysis;
    const disp = filters.disposition ?? "all";
    const periodLabels = filters.periods.map((p) => p.label).join(", ");
    const count = comparables.listings.length;

    const title = `SOLD COMPARABLES \u2014 ${disp} ${filters.estateType}, ${filters.district.name}, ${periodLabels} (N=${count})`;
    const lines: string[] = [sectionHeader(title)];
    lines.push(`  ${pc.dim("Source: reas.cz (sold property register, linkedToTransfer=true)")}`);

    const headers = ["#", "Address", "m\u00B2", "Sold Price", "CZK/m\u00B2", "Listed\u2192Sold", "Discount"];
    const rows: string[][] = [];

    for (let i = 0; i < comparables.listings.length; i++) {
        const l = comparables.listings[i];
        rows.push([
            String(i + 1),
            truncAddr(l.formattedAddress),
            fmt(l.utilityArea),
            fmt(l.soldPrice),
            fmt(l.pricePerM2),
            l.daysOnMarket > 0 ? `${Math.round(l.daysOnMarket)} days` : "n/a",
            `${fmtDec(l.discount, 1)}%`,
        ]);
    }

    lines.push("");
    lines.push(
        formatTable(rows, headers, {
            alignRight: [0, 2, 3, 4],
            maxColWidth: 36,
        })
    );

    // Source links for each listing
    lines.push("");
    lines.push(`  ${pc.dim("Links:")}`);

    for (let i = 0; i < comparables.listings.length; i++) {
        const l = comparables.listings[i];

        if (l.link) {
            lines.push(`  ${pc.dim(`${String(i + 1).padStart(2)}. ${l.link}`)}`);
        }
    }

    const { pricePerM2 } = comparables;
    const targetPpm2 = target.area > 0 ? target.price / target.area : 0;
    const pctl = Math.round(comparables.targetPercentile);

    lines.push("");
    lines.push(labelValue("Median:", `${fmt(pricePerM2.median)} CZK/m\u00B2`));
    lines.push(labelValue("Mean:", `${fmt(pricePerM2.mean)} CZK/m\u00B2`));
    lines.push(labelValue("P25\u2013P75:", `${fmt(pricePerM2.p25)} \u2013 ${fmt(pricePerM2.p75)} CZK/m\u00B2`));
    lines.push(labelValue("Min/Max:", `${fmt(pricePerM2.min)} \u2013 ${fmt(pricePerM2.max)} CZK/m\u00B2`));
    lines.push("");
    lines.push(
        `    ${pc.bold(pc.yellow(`\u25BA YOUR PRICE: ${fmt(targetPpm2)} CZK/m\u00B2 \u2014 P${pctl} (above ${pctl}% of comparables)`))}`
    );

    return lines.join("\n");
}

function renderRentalListings(analysis: FullAnalysis): string {
    const { rentalListings, mfBenchmarks, target, filters } = analysis;
    const count = rentalListings.length;

    const title = `RENTAL LISTINGS \u2014 Flats, ${filters.district.name} (N=${count}, showing relevant)`;
    const lines: string[] = [sectionHeader(title)];
    lines.push(`  ${pc.dim("Source: sreality.cz (active rental listings)")}`);
    lines.push(`  ${pc.dim("Benchmark: MF cenova mapa XLSX (mf.gov.cz)")}`);


    const headers = ["#", "Locality", "m\u00B2", "Disp", "Rent/mo", "CZK/m\u00B2"];
    const rows = rentalListings.map((l, i) => {
        const area = l.area ?? 0;
        const ppm2 = area > 0 ? Math.round(l.price / area) : 0;

        return [
            String(i + 1),
            truncAddr(l.locality),
            area > 0 ? fmt(area) : "n/a",
            l.disposition ?? "n/a",
            fmt(l.price),
            ppm2 > 0 ? fmt(ppm2) : "n/a",
        ];
    });

    lines.push("");
    lines.push(
        formatTable(rows, headers, {
            alignRight: [0, 2, 4, 5],
            maxColWidth: 36,
        })
    );

    const disp = filters.disposition ?? "all";
    const matchingRentals = rentalListings.filter(
        (l) => l.disposition && l.disposition.toLowerCase() === disp.toLowerCase()
    );

    let srealityAvg = 0;
    let srealityPpm2 = 0;

    if (matchingRentals.length > 0) {
        const totalRent = matchingRentals.reduce((s, l) => s + l.price, 0);
        srealityAvg = totalRent / matchingRentals.length;

        const withArea = matchingRentals.filter((l) => l.area && l.area > 0);

        if (withArea.length > 0) {
            const totalPpm2 = withArea.reduce((s, l) => s + l.price / (l.area ?? 1), 0);
            srealityPpm2 = totalPpm2 / withArea.length;
        }
    }

    const vk = dispositionToVK(target.disposition);
    const mfMatch = vk ? mfBenchmarks.find((b) => b.sizeCategory === vk) : null;
    const mfMonthly = mfMatch ? mfMatch.referencePrice * target.area : 0;
    const mfPpm2 = mfMatch ? mfMatch.referencePrice : 0;

    const rentPpm2 = target.area > 0 ? target.monthlyRent / target.area : 0;

    // Source links for each rental listing
    lines.push("");
    lines.push(`  ${pc.dim("Links:")}`);

    for (let i = 0; i < rentalListings.length; i++) {
        const l = rentalListings[i];

        if (l.link) {
            lines.push(`  ${pc.dim(`${String(i + 1).padStart(2)}. ${l.link}`)}`);
        }
    }

    lines.push("");
    lines.push(`    ${pc.dim(`Rental stats (${disp} ${filters.estateType}, ${filters.district.name}):`)}`);
    lines.push(labelValue("Sreality avg:", `${fmt(srealityAvg)} CZK/month (${fmt(srealityPpm2)} CZK/m\u00B2)`, 6));
    lines.push(labelValue("MF official:", `${fmt(mfMonthly)} CZK/month (${fmt(mfPpm2)} CZK/m\u00B2)`, 6));
    lines.push(labelValue("Your estimate:", `${fmt(target.monthlyRent)} CZK/month (${fmt(rentPpm2)} CZK/m\u00B2)`, 6));

    return lines.join("\n");
}

function renderPriceTrend(analysis: FullAnalysis): string {
    const { trends } = analysis;

    const title = "PRICE TREND";
    const lines: string[] = [sectionHeader(title)];
    lines.push(`  ${pc.dim("Source: reas.cz sold data, grouped by quarter")}`);

    const headers = ["Period", "Median CZK/m\u00B2", "Change", "N"];
    const rows = trends.periods.map((p) => [
        p.label,
        fmt(p.medianPerM2),
        p.change !== null ? pctColor(p.change) : pc.dim("n/a"),
        String(p.count),
    ]);

    lines.push("");
    lines.push(
        formatTable(rows, headers, {
            alignRight: [1, 3],
        })
    );

    const dirArrow =
        trends.direction === "rising"
            ? pc.green("\u2191")
            : trends.direction === "falling"
              ? pc.red("\u2193")
              : pc.dim("\u2192");
    const dirLabel = trends.direction.charAt(0).toUpperCase() + trends.direction.slice(1);

    lines.push("");

    if (trends.yoyChange !== null) {
        lines.push(`    ${pc.dim("YoY change:")} ${pctColor(trends.yoyChange)}  ${dirArrow} ${pc.bold(dirLabel)}`);
    } else {
        lines.push(`    ${pc.dim("Trend:")} ${dirArrow} ${pc.bold(dirLabel)}`);
    }

    return lines.join("\n");
}

function renderTimeOnMarket(analysis: FullAnalysis): string {
    const { timeOnMarket } = analysis;

    const title = "TIME ON MARKET";
    const lines: string[] = [sectionHeader(title)];
    lines.push(`  ${pc.dim("Source: reas.cz (firstVisibleAt → soldAt)")}`);

    lines.push("");
    lines.push(labelValue("Median days to sell:", `${Math.round(timeOnMarket.median)}`));
    lines.push(labelValue("Mean:", `${Math.round(timeOnMarket.mean)}`));
    lines.push(labelValue("Fastest:", `${Math.round(timeOnMarket.min)} days`));
    lines.push(labelValue("Slowest:", `${Math.round(timeOnMarket.max)} days`));

    return lines.join("\n");
}

function renderDiscountAnalysis(analysis: FullAnalysis): string {
    const { discount, target } = analysis;

    const title = "DISCOUNT ANALYSIS";
    const lines: string[] = [sectionHeader(title)];
    lines.push(`  ${pc.dim("Source: reas.cz (originalPrice → soldPrice)")}`);

    const noPct = discount.totalCount > 0 ? Math.round((discount.noDiscountCount / discount.totalCount) * 100) : 0;

    lines.push("");
    lines.push(labelValue("Avg discount:", `${fmtDec(discount.avgDiscount, 1)}%`));
    lines.push(labelValue("Median discount:", `${fmtDec(discount.medianDiscount, 1)}%`));
    lines.push(labelValue("Max discount:", `${fmtDec(discount.maxDiscount, 1)}%`));
    lines.push(labelValue("No discount:", `${discount.noDiscountCount} of ${discount.totalCount} (${noPct}%)`));

    if (discount.medianDiscount < 0) {
        const estimated = target.price * (1 + discount.medianDiscount / 100);
        lines.push("");
        lines.push(
            `    ${pc.dim("Negotiation potential:")} If ${fmtMil(target.price)} is listing price, expect ~${fmtMil(estimated)} final`
        );
    }

    return lines.join("\n");
}

function renderInvestmentYield(analysis: FullAnalysis): string {
    const { yield: yld, target, filters } = analysis;

    const title = "INVESTMENT YIELD";
    const lines: string[] = [sectionHeader(title)];

    const netMonthly = target.monthlyRent - target.monthlyCosts;

    lines.push("");
    lines.push(labelValue("Monthly rent:", `${fmt(target.monthlyRent)} CZK`));
    lines.push(labelValue("Monthly costs:", `${pc.red(`-${fmt(target.monthlyCosts)}`)} CZK`));
    lines.push(labelValue("Net monthly income:", `${fmt(netMonthly)} CZK`));

    lines.push("");
    lines.push(labelValue("Gross yield:", `${fmtDec(yld.grossYield, 2)}%`));
    lines.push(labelValue("Net yield:", `${fmtDec(yld.netYield, 2)}%`));
    lines.push(labelValue("Payback period:", yld.paybackYears < 1000 ? `${fmtDec(yld.paybackYears, 1)} years` : "n/a"));

    lines.push("");
    lines.push(`    ${pc.dim("Comparison:")}`);

    for (const bm of yld.benchmarks) {
        lines.push(labelValue(`${bm.name}:`, `~${fmtDec(bm.yield, 1)}%`, 6));
    }

    lines.push(
        labelValue(`${filters.district.name} avg:`, `~${fmtDec(yld.atMarketPrice.netYield, 1)}% (at market price)`, 6)
    );

    lines.push("");
    lines.push(
        `    ${pc.bold(
            pc.cyan(
                `\u25BA AT MARKET PRICE (~${fmtMil(yld.atMarketPrice.price)}): Net yield = ${fmtDec(yld.atMarketPrice.netYield, 2)}%, payback = ${fmtDec(yld.atMarketPrice.paybackYears, 1)} years`
            )
        )}`
    );

    return lines.join("\n");
}

function renderVerdict(analysis: FullAnalysis): string {
    const { comparables, target } = analysis;

    const title = "VERDICT";
    const lines: string[] = [sectionHeader(title)];

    const marketEstimate = comparables.pricePerM2.median * target.area;
    const premium = marketEstimate > 0 ? ((target.price - marketEstimate) / marketEstimate) * 100 : 0;

    lines.push("");
    lines.push(labelValue("Market value estimate:", `~${fmt(marketEstimate)} CZK`));
    lines.push(labelValue("Asked price:", `${fmt(target.price)} CZK`));
    lines.push(labelValue("Premium:", `${pctStr(premium)} ${premium > 0 ? "above" : "below"} market`));
    lines.push("");

    if (premium > 15) {
        lines.push(
            `    ${pc.red(pc.bold("\u26A0 Significantly overpriced."))} The asked price is ${fmtDec(premium, 0)}% above comparable market values.`
        );
        lines.push(`    ${pc.dim("Recommendation: Negotiate hard or consider alternatives.")}`);
    } else if (premium > 5) {
        lines.push(
            `    ${pc.yellow(pc.bold("\u26A0 Slightly above market."))} Premium of ${fmtDec(premium, 0)}% may be justified by condition or features.`
        );
        lines.push(`    ${pc.dim("Recommendation: Room for negotiation, target around market median.")}`);
    } else if (premium > -5) {
        lines.push(
            `    ${pc.green(pc.bold("\u2713 Near market value."))} The price aligns with comparable sold properties.`
        );
        lines.push(`    ${pc.dim("Recommendation: Fair price. Check property condition carefully.")}`);
    } else {
        lines.push(
            `    ${pc.green(pc.bold("\u2713 Below market value."))} Potential bargain at ${fmtDec(Math.abs(premium), 0)}% under comparables.`
        );
        lines.push(`    ${pc.dim("Recommendation: Investigate why it's priced low. Act quickly if solid.")}`);
    }

    return lines.join("\n");
}

export function renderReport(analysis: FullAnalysis): string {
    const sections = [
        renderSoldComparables(analysis),
        renderRentalListings(analysis),
        renderPriceTrend(analysis),
        renderTimeOnMarket(analysis),
        renderDiscountAnalysis(analysis),
        renderInvestmentYield(analysis),
        renderVerdict(analysis),
    ];

    return sections.join("\n") + "\n";
}
