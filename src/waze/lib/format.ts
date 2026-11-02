import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import { alertLabel, formatAge } from "./alerts";
import type { CorridorResult } from "./corridor";
import type {
    CorridorAlert,
    CorridorJam,
    DepartureOption,
    FeedStats,
    RouteAlternative,
    WazeAlert,
    WazeJam,
} from "./types";

export function kmText(metres: number): string {
    return `${(metres / 1000).toFixed(1)} km`;
}

export function durationText(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min`;
    }

    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export function clockText(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
}

export function dateTimeText(epochMs: number): string {
    return new Date(epochMs).toLocaleString("cs-CZ", {
        day: "numeric",
        month: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function md(text: string | undefined): string {
    return (text ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function statsLine(stats: FeedStats & { tilesPlanned?: number }): string {
    const parts = [`${stats.requests} georss requests`, `${stats.tiles} tiles`];
    if (stats.capped > 0) {
        parts.push(`${stats.capped} still capped at 200 (may miss reports)`);
    }

    if (stats.failed > 0) {
        parts.push(`${stats.failed} failed (area missing)`);
    }

    if (stats.skipped > 0) {
        parts.push(`${stats.skipped} not asked, request budget spent (area missing)`);
    }

    return parts.join(", ");
}

/** One sentence per way the feed's coverage is incomplete; empty when every tile answered whole. */
export function coverageWarnings(stats: FeedStats): string[] {
    const warnings: string[] = [];
    if (stats.capped > 0) {
        warnings.push(`${stats.capped} georss tiles stayed at the 200-report cap: their area may miss reports.`);
    }

    if (stats.failed > 0) {
        warnings.push(`${stats.failed} georss tiles failed: their area is missing.`);
    }

    if (stats.skipped > 0) {
        warnings.push(`${stats.skipped} georss tiles were not asked (request budget spent): their area is missing.`);
    }

    return warnings;
}

export function categoryColor(alert: Pick<WazeAlert, "category">, text: string): string {
    const colors: Record<WazeAlert["category"], (value: string) => string> = {
        police: pc.blue,
        accident: pc.red,
        hazard: pc.yellow,
        jam: pc.magenta,
        closure: pc.red,
        camera: pc.cyan,
        other: pc.dim,
    };
    return colors[alert.category](text);
}

export function corridorAlertsMarkdown(alerts: CorridorAlert[], now: number): string {
    if (alerts.length === 0) {
        return "_No reports on the route corridor._";
    }

    const rows = alerts.map(
        (alert) =>
            `| ${(alert.alongM / 1000).toFixed(1)} | ${md(alertLabel(alert))} | ${md(alert.street)} | ${formatAge(alert.publishedAt, now)} | ${Math.round(alert.offsetM)} m ${alert.side} | ${alert.thumbsUp} |`
    );
    return ["| km | Report | Street | Age | Off route | 👍 |", "|---:|---|---|---|---|---:|", ...rows].join("\n");
}

export function corridorAlertsTable(alerts: CorridorAlert[], now: number): string {
    const table = createBoxTable(["KM", "REPORT", "STREET", "AGE", "OFF ROUTE", "👍"]);
    for (const alert of alerts) {
        table.push([
            pc.bold((alert.alongM / 1000).toFixed(1)),
            categoryColor(alert, truncateDisplay(alertLabel(alert), 34)),
            truncateDisplay(alert.street ?? "", 30),
            formatAge(alert.publishedAt, now),
            pc.dim(`${Math.round(alert.offsetM)} m ${alert.side}`),
            String(alert.thumbsUp),
        ]);
    }

    return table.toString();
}

export function corridorJamsMarkdown(jams: CorridorJam[]): string {
    if (jams.length === 0) {
        return "_No jams on the route corridor._";
    }

    const rows = jams.map(
        (jam) =>
            `| ${(jam.alongM / 1000).toFixed(1)} | ${jam.level} | ${md(jam.street)} | ${jam.lengthM} m | ${jam.speedKmh} km/h |`
    );
    return ["| km | Level | Street | Length | Speed |", "|---:|---:|---|---:|---:|", ...rows].join("\n");
}

export function corridorJamsTable(jams: CorridorJam[]): string {
    const table = createBoxTable(["KM", "LEVEL", "STREET", "LENGTH", "SPEED"]);
    for (const jam of jams) {
        table.push([
            pc.bold((jam.alongM / 1000).toFixed(1)),
            jam.level >= 4 ? pc.red(String(jam.level)) : String(jam.level),
            truncateDisplay(jam.street ?? jam.city ?? "", 34),
            `${jam.lengthM} m`,
            `${jam.speedKmh} km/h`,
        ]);
    }

    return table.toString();
}

export function routesMarkdown(routes: RouteAlternative[], startAt: number): string {
    const rows = routes.map(
        (route, index) =>
            `| ${index + 1} | ${md(route.name)} | ${kmText(route.distanceM)} | ${durationText(route.durationSec)} | ${clockText(startAt + route.durationSec * 1000)} | ${route.source}${route.withVignette ? "" : ", no vignette"}${route.isToll ? ", toll" : ""} | ${md(route.trafficLabel)} |`
    );
    return [
        "| # | Via | Distance | Time | Arrive | Source | Traffic |",
        "|---:|---|---:|---:|---:|---|---|",
        ...rows,
    ].join("\n");
}

export function routesTable(routes: RouteAlternative[], startAt: number): string {
    const table = createBoxTable(["#", "VIA", "DISTANCE", "TIME", "ARRIVE", "SOURCE", "TRAFFIC"]);
    routes.forEach((route, index) => {
        table.push([
            String(index + 1),
            pc.bold(truncateDisplay(route.name, 28)),
            kmText(route.distanceM),
            durationText(route.durationSec),
            clockText(startAt + route.durationSec * 1000),
            `${route.source}${route.withVignette ? "" : pc.dim(", no vignette")}`,
            pc.dim(route.trafficLabel ?? ""),
        ]);
    });
    return table.toString();
}

export function areaAlertsMarkdown(alerts: Array<WazeAlert & { distanceM: number }>, now: number): string {
    if (alerts.length === 0) {
        return "_No reports in the area._";
    }

    const rows = alerts.map(
        (alert) =>
            `| ${kmText(alert.distanceM)} | ${md(alertLabel(alert))} | ${md(alert.street)} | ${formatAge(alert.publishedAt, now)} | ${alert.thumbsUp} | ${alert.lat.toFixed(5)},${alert.lon.toFixed(5)} |`
    );
    return ["| Distance | Report | Street | Age | 👍 | Position |", "|---:|---|---|---|---:|---|", ...rows].join("\n");
}

export function areaAlertsTable(alerts: Array<WazeAlert & { distanceM: number }>, now: number): string {
    const table = createBoxTable(["DIST", "REPORT", "STREET", "AGE", "👍", "POSITION"]);
    for (const alert of alerts) {
        table.push([
            kmText(alert.distanceM),
            categoryColor(alert, truncateDisplay(alertLabel(alert), 34)),
            truncateDisplay(alert.street ?? "", 28),
            formatAge(alert.publishedAt, now),
            String(alert.thumbsUp),
            pc.dim(`${alert.lat.toFixed(5)},${alert.lon.toFixed(5)}`),
        ]);
    }

    return table.toString();
}

export function areaJamsMarkdown(jams: Array<WazeJam & { distanceM: number }>): string {
    if (jams.length === 0) {
        return "_No jams in the area._";
    }

    const rows = jams.map(
        (jam) =>
            `| ${kmText(jam.distanceM)} | ${jam.level} | ${md(jam.street)} | ${md(jam.city)} | ${jam.lengthM} m | ${jam.speedKmh} km/h |`
    );
    return ["| Distance | Level | Street | City | Length | Speed |", "|---:|---:|---|---|---:|---:|", ...rows].join(
        "\n"
    );
}

export function areaJamsTable(jams: Array<WazeJam & { distanceM: number }>): string {
    const table = createBoxTable(["DIST", "LEVEL", "STREET", "CITY", "LENGTH", "SPEED"]);
    for (const jam of jams) {
        table.push([
            kmText(jam.distanceM),
            jam.level >= 4 ? pc.red(String(jam.level)) : String(jam.level),
            truncateDisplay(jam.street ?? "", 30),
            truncateDisplay(jam.city ?? "", 16),
            `${jam.lengthM} m`,
            `${jam.speedKmh} km/h`,
        ]);
    }

    return table.toString();
}

export function departuresMarkdown(options: DepartureOption[], best: DepartureOption | undefined): string {
    if (options.length === 0) {
        return "_Waze returned no departure times._";
    }

    const rows = options.map(
        (option) =>
            `| ${dateTimeText(option.leaveAt)} | ${clockText(option.arriveAt)} | ${option.minutes} min |${option === best ? " ← best |" : " |"}`
    );
    return ["| Leave | Arrive | Drive |  |", "|---|---|---:|---|", ...rows].join("\n");
}

export function corridorSummary(result: CorridorResult): string {
    const police = result.alerts.filter((alert) => alert.category === "police").length;
    return `${result.alerts.length} reports (${police} police) and ${result.jams.length} jams on ${kmText(result.lengthM)} of route; ${statsLine(result.stats)}.`;
}
