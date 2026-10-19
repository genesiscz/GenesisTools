import { tldOf } from "@app/domains/lib/domain";
import { restrictionFor } from "@app/domains/lib/restrictions";
import type { CheckResult, DomainPrice, DomainStatus } from "@app/domains/lib/types";
import type { VibeHit } from "@app/domains/lib/vibe";
import { createBoxTable, type DotStatusKind, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

const STATUS_LOOK: Record<DomainStatus, { kind: DotStatusKind; label: string }> = {
    available: { kind: "ok", label: "free" },
    premium: { kind: "warn", label: "premium" },
    "for-sale": { kind: "warn", label: "for sale" },
    taken: { kind: "err", label: "taken" },
    reserved: { kind: "dim", label: "reserved" },
    unknown: { kind: "dim", label: "unknown" },
};

export function statusCell(status: DomainStatus): string {
    const look = STATUS_LOOK[status];
    return formatDotStatus(look.kind, look.label);
}

export function money(amount: number | undefined, currency = "USD"): string {
    if (amount === undefined) {
        return "—";
    }

    const symbol = currency === "USD" ? "$" : `${currency} `;
    return `${symbol}${amount >= 1000 ? Math.round(amount).toLocaleString("en-US") : amount.toFixed(2)}`;
}

export function priceCell(price: DomainPrice | undefined): string {
    if (!price) {
        return pc.dim("—");
    }

    const first = money(price.registration, price.currency);
    const renewal =
        price.renewal !== undefined && Math.abs(price.renewal - price.registration) > 0.01
            ? pc.dim(` / ${money(price.renewal, price.currency)}`)
            : "";
    const text = `${first}${renewal}`;
    return price.premium || price.registration >= 100 ? pc.yellow(text) : text;
}

export function infoCell(result: CheckResult): string {
    const parts: string[] = [];
    if (result.status === "for-sale" && result.detail) {
        parts.push(`parked at ${result.detail}`);
    } else if (result.registrar) {
        parts.push(result.registrar);
    }

    if (result.expiresAt) {
        parts.push(`exp ${result.expiresAt.slice(0, 10)}`);
    }

    if (!parts.length && result.detail && result.status !== "available") {
        parts.push(result.detail);
    }

    return pc.dim(truncateDisplay(parts.join(" · "), 46));
}

export function vibeCell(hits: VibeHit[] | undefined): string {
    if (!hits?.length) {
        return "";
    }

    const top = hits[0];
    return pc.red(`⚠ "${top.word}" (${top.languages.join(",")})`);
}

function detailCell(row: ResultRow): string {
    const registrable = row.result.status === "available" || row.result.status === "premium";
    const rule = restrictionFor(tldOf(row.result.domain));
    if (registrable && rule) {
        return pc.yellow(truncateDisplay(`⚠ ${rule.note}`, 46));
    }

    if (registrable && row.reason) {
        return pc.dim(truncateDisplay(row.reason, 46));
    }

    return infoCell(row.result);
}

export interface ResultRow {
    result: CheckResult;
    score?: number;
    reason?: string;
    vibe?: VibeHit[];
}

export function renderResultTable(rows: ResultRow[], { showScore = false } = {}): string {
    const headers = [
        ...(showScore ? ["SCORE"] : []),
        "DOMAIN",
        "STATUS",
        "PRICE 1Y / RENEW",
        "INFO",
        ...(rows.some((row) => row.vibe?.length) ? ["VIBE"] : []),
    ];
    const table = createBoxTable(headers);
    const withVibe = headers.includes("VIBE");
    for (const row of rows) {
        const cells = [
            ...(showScore ? [String(row.score ?? "")] : []),
            pc.white(row.result.domain) + (row.result.cached ? pc.dim(" ·c") : ""),
            statusCell(row.result.status),
            priceCell(row.result.price),
            detailCell(row),
            ...(withVibe ? [vibeCell(row.vibe)] : []),
        ];
        table.push(cells);
    }

    return table.toString();
}
