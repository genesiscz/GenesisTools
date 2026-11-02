import { SafeJSON } from "@genesiscz/utils/json";
import { alertLabel } from "./alerts";
import type { CorridorAlert, CorridorJam, LatLon, RouteAlternative } from "./types";

export const EXPORT_FORMATS = ["geojson", "gpx", "kml", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
    return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export interface ExportInput {
    from: { label: string } & LatLon;
    to: { label: string } & LatLon;
    route: RouteAlternative;
    alerts: CorridorAlert[];
    jams: CorridorJam[];
    generatedAt: number;
    /**
     * Why the reports may be incomplete (capped, failed or unasked tiles, reports Waze hides). GeoJSON, GPX and KML
     * carry them in their own metadata; CSV has no place for them, so its caller reads them from the result.
     */
    warnings?: string[];
}

function xml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

function csvCell(value: string | number | undefined): string {
    const text = value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function km(metres: number): string {
    return (metres / 1000).toFixed(1);
}

function alertName(alert: CorridorAlert): string {
    return `km ${km(alert.alongM)} ${alertLabel(alert)}${alert.street ? ` · ${alert.street}` : ""}`;
}

export function toGeoJson(input: ExportInput): string {
    const features = [
        {
            type: "Feature",
            properties: {
                kind: "route",
                name: input.route.name,
                source: input.route.source,
                distanceM: input.route.distanceM,
                durationSec: input.route.durationSec,
                from: input.from.label,
                to: input.to.label,
            },
            geometry: { type: "LineString", coordinates: input.route.coords.map((p) => [p.lon, p.lat]) },
        },
        ...input.alerts.map((alert) => ({
            type: "Feature",
            properties: {
                kind: "alert",
                id: alert.id,
                category: alert.category,
                type: alert.type,
                subtype: alert.subtype,
                label: alertLabel(alert),
                street: alert.street,
                kmFromStart: Number(km(alert.alongM)),
                offsetM: Math.round(alert.offsetM),
                side: alert.side,
                publishedAt: new Date(alert.publishedAt).toISOString(),
                thumbsUp: alert.thumbsUp,
            },
            geometry: { type: "Point", coordinates: [alert.lon, alert.lat] },
        })),
        ...input.jams.map((jam) => ({
            type: "Feature",
            properties: {
                kind: "jam",
                id: jam.id,
                level: jam.level,
                street: jam.street,
                lengthM: jam.lengthM,
                speedKmh: jam.speedKmh,
                kmFromStart: Number(km(jam.alongM)),
            },
            geometry: { type: "LineString", coordinates: jam.line.map((p) => [p.lon, p.lat]) },
        })),
    ];
    const warnings = input.warnings ?? [];
    return SafeJSON.stringify(
        {
            type: "FeatureCollection",
            generatedAt: new Date(input.generatedAt).toISOString(),
            ...(warnings.length > 0 ? { warnings } : {}),
            features,
        },
        null,
        2
    );
}

/** The warnings as one line of text for a GPX `<desc>` or a KML `<description>`, escaped; empty when there are none. */
function warningsText(input: ExportInput): string {
    return xml((input.warnings ?? []).join(" "));
}

export function toGpx(input: ExportInput): string {
    const waypoints = input.alerts
        .map(
            (alert) =>
                `  <wpt lat="${alert.lat}" lon="${alert.lon}">\n    <time>${new Date(alert.publishedAt).toISOString()}</time>\n    <name>${xml(alertName(alert))}</name>\n    <type>${xml(alert.category)}</type>\n  </wpt>`
        )
        .join("\n");
    const track = input.route.coords.map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}"/>`).join("\n");
    const desc = warningsText(input);
    // GPX 1.1 orders metadata as name, desc, ..., time.
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GenesisTools waze" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(`${input.from.label} → ${input.to.label}`)}</name>${desc ? `<desc>${desc}</desc>` : ""}<time>${new Date(input.generatedAt).toISOString()}</time></metadata>
${waypoints}
  <trk>
    <name>${xml(input.route.name)}</name>
    <trkseg>
${track}
    </trkseg>
  </trk>
</gpx>
`;
}

export function toKml(input: ExportInput): string {
    const placemarks = input.alerts
        .map(
            (alert) =>
                `    <Placemark><name>${xml(alertName(alert))}</name><description>${xml(`${alert.type} ${alert.subtype}`.trim())}</description><Point><coordinates>${alert.lon},${alert.lat},0</coordinates></Point></Placemark>`
        )
        .join("\n");
    const jams = input.jams
        .map(
            (jam) =>
                `    <Placemark><name>${xml(`km ${km(jam.alongM)} jam level ${jam.level}${jam.street ? ` · ${jam.street}` : ""}`)}</name><LineString><coordinates>${jam.line.map((p) => `${p.lon},${p.lat},0`).join(" ")}</coordinates></LineString></Placemark>`
        )
        .join("\n");
    const line = input.route.coords.map((p) => `${p.lon},${p.lat},0`).join(" ");
    const description = warningsText(input);
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(`${input.from.label} → ${input.to.label}`)}</name>${description ? `\n    <description>${description}</description>` : ""}
    <Placemark><name>${xml(input.route.name)}</name><LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString></Placemark>
${placemarks}
${jams}
  </Document>
</kml>
`;
}

export function toCsv(input: ExportInput): string {
    const header = [
        "kind",
        "km",
        "category",
        "type",
        "subtype",
        "label",
        "street",
        "lat",
        "lon",
        "offset_m",
        "side",
        "published_at",
        "thumbs_up",
    ];
    const rows = [
        ...input.alerts.map((alert) => [
            "alert",
            km(alert.alongM),
            alert.category,
            alert.type,
            alert.subtype,
            alertLabel(alert),
            alert.street,
            alert.lat,
            alert.lon,
            Math.round(alert.offsetM),
            alert.side,
            new Date(alert.publishedAt).toISOString(),
            alert.thumbsUp,
        ]),
        ...input.jams.map((jam) => [
            "jam",
            km(jam.alongM),
            "jam",
            "JAM",
            `level ${jam.level}`,
            `${jam.speedKmh} km/h over ${jam.lengthM} m`,
            jam.street,
            jam.line[0]?.lat,
            jam.line[0]?.lon,
            Math.round(jam.offsetM),
            jam.side,
            new Date(jam.updatedAt).toISOString(),
            "",
        ]),
    ];
    return [header, ...rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\n")
        .concat("\n");
}

export function exportTrip(format: ExportFormat, input: ExportInput): string {
    const writers: Record<ExportFormat, (value: ExportInput) => string> = {
        geojson: toGeoJson,
        gpx: toGpx,
        kml: toKml,
        csv: toCsv,
    };
    return writers[format](input);
}
