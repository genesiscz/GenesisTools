import pc from "picocolors";
import { parseProSymbol } from "./symbols";
import type { Alert, AlertFire, PinePlot, QuoteSnapshot, SignalEvent, StudyPoint } from "./types";

function fmtNum(n: number | undefined, digits = 2): string {
    if (n === undefined || Number.isNaN(n)) {
        return "—";
    }
    return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signColor(n: number | undefined): (s: string) => string {
    if (n === undefined || n === 0) {
        return pc.dim;
    }
    return n > 0 ? pc.green : pc.red;
}

export function formatQuoteTable(snapshots: QuoteSnapshot[]): string {
    return snapshots.map(formatQuoteLine).join("\n");
}

export function formatQuoteLine(snap: QuoteSnapshot): string {
    const v = snap.value;
    const label = v.short_name ?? parseProSymbol(snap.symbol);
    const price = fmtNum(typeof v.lp === "number" ? v.lp : undefined);
    const color = signColor(typeof v.ch === "number" ? v.ch : undefined);
    const ch = typeof v.ch === "number" ? `${v.ch > 0 ? "+" : ""}${fmtNum(v.ch)}` : "—";
    const chp = typeof v.chp === "number" ? `${v.chp > 0 ? "+" : ""}${fmtNum(v.chp)}%` : "—";
    const vol = typeof v.volume === "number" ? pc.dim(`vol ${fmtNum(v.volume, 0)}`) : "";
    return `${pc.bold(label.padEnd(12))} ${price.padStart(12)}  ${color(`${ch.padStart(10)} ${chp.padStart(8)}`)}  ${vol}`;
}

function conditionText(alert: Alert): string {
    const target = alert.condition?.series?.find((s) => s.type === "value")?.value;
    const type = alert.condition?.type ?? "?";
    return target === undefined ? type : `${type} ${fmtNum(target)}`;
}

export function formatAlertRow(alert: Alert): string {
    const sym = parseProSymbol(alert.symbol);
    const state = alert.active ? pc.green("●") : pc.dim("○");
    const id = pc.dim(String(alert.alert_id).padStart(12));
    return `${state} ${id}  ${pc.bold(sym.padEnd(20))} ${pc.cyan(conditionText(alert).padEnd(18))} ${pc.dim(alert.message)}`;
}

export function formatAlertFire(fire: AlertFire): string {
    const sym = parseProSymbol(fire.symbol);
    const time = new Date(fire.fire_time).toLocaleTimeString("en-US", { hour12: false });
    const head = pc.bgYellow(pc.black(" ALERT "));
    return `${head} ${pc.dim(time)}  ${pc.bold(pc.yellow(sym))}  ${fire.message}`;
}

function fmtTime(epochSeconds: number): string {
    const d = new Date(epochSeconds * 1000);
    return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtCell(value: number | null): string {
    if (value === null) {
        return "—";
    }

    return Math.abs(value) >= 1000 ? value.toFixed(1) : value.toFixed(2);
}

export function formatIndicatorHeader(plots: PinePlot[]): string {
    const cols = plots.map((p) => p.title.padStart(10)).join(" ");
    return pc.bold(`${"time".padEnd(16)} ${cols}`);
}

export function formatStudyRow(point: StudyPoint, plots: PinePlot[]): string {
    const cells = point.values
        .slice(0, plots.length)
        .map((v, i) => {
            const text = fmtCell(v).padStart(10);
            return plots[i].type === "line" ? text : v === null ? pc.dim(text) : pc.yellow(text);
        })
        .join(" ");
    return `${pc.dim(fmtTime(point.time))} ${cells}`;
}

export function formatSignalLine(event: SignalEvent, symbol: string): string {
    const arrow = /sell|down|short/i.test(event.plotTitle) ? pc.red("▼") : pc.green("▲");
    const tag = event.kind === "live" ? pc.bgYellow(pc.black(" SIGNAL ")) : pc.dim("[hist]");
    return `${tag} ${arrow} ${pc.bold(event.plotTitle)}  ${symbol}  ${fmtTime(event.time)} (bar ${event.barIndex})`;
}
