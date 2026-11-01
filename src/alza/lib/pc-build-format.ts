import { PC_ROLES, type PcRole } from "./pc-build";
import type { BuildReport } from "./pc-build-service";

function isRole(value: string): value is PcRole {
    return (PC_ROLES as readonly string[]).includes(value);
}

/** `BD750m7b1` or `BD750m7b1:psu`: a code with an optional role after the last colon. */
export function parsePcPart(value: string): { code: string; role?: PcRole } {
    const colon = value.lastIndexOf(":");
    const role = colon > 0 ? value.slice(colon + 1) : "";
    if (role && isRole(role)) {
        return { code: value.slice(0, colon), role };
    }

    return { code: value };
}

/** Adapted from lukabudik/alza-mcp-community (MIT) — src/tools/pc-builder.ts `formatBuildReport`. */
export function buildReportMarkdown(r: BuildReport, heading: string): string {
    const overall =
        r.overall === "no_conflicts_found"
            ? `no conflicts found among the listed parts. This is NOT a "compatible" verdict: the build lacks ${r.missingRoles.join(", ")}`
            : r.overall;
    const unpriced = r.totalIncomplete
        ? ` (without ${r.unpriced.length} unpriced part(s): ${r.unpriced.join(", ")})`
        : "";
    const total = `total ${r.total} ${r.currency}${unpriced}`;
    const budget = r.budget !== undefined ? ` of a ${r.budget} budget${r.withinBudget ? "" : " (OVER BUDGET)"}` : "";
    const lines = [`**${heading}**`, "", `Overall: **${overall}**, ${total}${budget}`, ""];
    for (const p of r.parts) {
        const stock = p.inStock === true ? "in stock" : p.inStock === false ? "not purchasable now" : "stock unknown";
        lines.push(
            `- ${p.role}${p.origin === "fixed" ? " (fixed)" : ""}: **${p.name}** \`${p.code}\` ${p.price ?? "?"} ${p.currency} · ${stock}`
        );
    }

    lines.push("", "Compatibility:");
    for (const v of r.verdicts) {
        if (v.verdict !== "not_applicable") {
            lines.push(`- ${v.verdict.toUpperCase()} ${v.title}: ${v.detail}`);
        }
    }

    const notApplicable = r.verdicts.filter((v) => v.verdict === "not_applicable").map((v) => v.rule);
    if (notApplicable.length > 0) {
        lines.push(`- not applicable: ${notApplicable.join(", ")}`);
    }

    if (r.powerEstimate) {
        const e = r.powerEstimate;
        lines.push(
            "",
            `Power: about ${e.totalW} W peak (CPU ${e.cpuW} + GPU ${e.gpuW} + platform ${e.platformW}); a PSU of ${e.recommendedPsuW} W or more.`
        );
    }

    if (r.notes.length > 0) {
        lines.push("", "Notes:", ...r.notes.map((n) => `- ${n}`));
    }

    const pages = r.categoryPages ? `, ${r.categoryPages} category page load(s)` : "";
    lines.push("", `${r.detailFetches} product read(s)${pages}. Prices and stock are live Alza values at read time.`);
    return lines.join("\n");
}
