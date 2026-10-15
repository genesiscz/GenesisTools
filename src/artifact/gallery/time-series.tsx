// Kit gallery: TimeSeries. Serve with `tools artifact serve src/artifact/gallery/time-series.tsx`.
// Every number below is invented by a seeded generator; nothing comes from a real session.
import { Callout, Hero, Page, Section, TimeSeries, type TsMarker, type TsSeries, type TsSpan } from "@artifact/kit";

const MINUTE = 60_000;
const DAYS = 10;
const START = Date.UTC(2026, 9, 3, 6, 0, 0);

/** Small seeded generator so the page looks the same on every load. */
function rng(seed: number): () => number {
    let a = seed;

    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Demo {
    series: TsSeries[];
    markers: TsMarker[];
    spans: TsSpan[];
}

function buildDemo(): Demo {
    const rand = rng(42);
    const context: Array<[number, number | null]> = [];
    const cost: Array<[number, number | null]> = [];
    const hit: Array<[number, number | null]> = [];
    const reads: Array<[number, number | null]> = [];
    const writes: Array<[number, number | null]> = [];
    const usage: Array<[number, number | null]> = [];
    const markers: TsMarker[] = [];
    let ctx = 22_000;
    let total = 0;
    let used = 3;
    let idle = false;
    let compactions = 0;
    let sinceCompact = 0;

    for (let m = 0; m < DAYS * 24 * 60; m += 1) {
        const t = START + m * MINUTE;
        const hourOfDay = (new Date(t).getUTCHours() + 2) % 24;
        const night = hourOfDay >= 1 && hourOfDay < 6;

        if (night) {
            if (!idle) {
                context.push([t, null]);
                hit.push([t, null]);
                idle = true;
            }

            continue;
        }

        if (idle) {
            idle = false;
            markers.push({
                t,
                label: "Morning wake",
                kind: "wake",
                detail: "Session resumed after the **night pause**.",
            });
        }

        if (rand() < 0.25) {
            continue;
        }

        sinceCompact += 1;
        ctx += 200 + rand() * 600;

        // About 40 compactions over ten days: a sharp drop back to a small summary.
        if (ctx > 140_000 + rand() * 50_000 && sinceCompact > 90) {
            compactions += 1;
            markers.push({
                t,
                label: `Compaction ${compactions}`,
                kind: "compaction",
                detail: `Context fell from **${Math.round(ctx / 1000)}k** to about 24k tokens.`,
            });
            ctx = 20_000 + rand() * 8_000;
            sinceCompact = 0;
        }

        const write = sinceCompact === 0 ? ctx : 400 + rand() * 1500;
        const read = Math.max(0, ctx - write);
        total += (read * 0.3 + write * 3.75 + 400 * 15) / 1_000_000;
        context.push([t, Math.round(ctx)]);
        reads.push([t, Math.round(read)]);
        writes.push([t, Math.round(write)]);
        cost.push([t, Number(total.toFixed(4))]);
        hit.push([t, Number(((read / (read + write)) * 100).toFixed(1))]);

        if (m % 37 === 0) {
            used = Math.min(100, used + rand() * 4);
        }

        // The usage bar resets once, halfway through.
        if (m === Math.floor((DAYS / 2) * 24 * 60) + 4) {
            used = 1;
            markers.push({ t, label: "Usage bar reset", kind: "wake", detail: "The weekly window rolled over." });
        }

        usage.push([t, Math.round(used * 10) / 10]);

        if (rand() < 0.005) {
            markers.push({ t, label: "User prompt", kind: "prompt", detail: "A new instruction from the user." });
        }
    }

    const spans: TsSpan[] = [];
    const lanes = ["Subagents", "Workers", "Reviews", "Background"];

    for (let i = 0; i < 150; i += 1) {
        const lane = lanes[i % lanes.length];
        let start = START + rand() * (DAYS * 24 * 60 - 200) * MINUTE;
        const hourOfDay = (new Date(start).getUTCHours() + 2) % 24;

        if (hourOfDay >= 1 && hourOfDay < 6) {
            start += 6 * 60 * MINUTE;
        }

        const length = (lane === "Background" ? 60 + rand() * 180 : 2 + rand() * 50) * MINUTE;
        spans.push({
            id: `span-${i}`,
            start,
            end: start + length,
            label: `${lane === "Subagents" ? "explore" : lane === "Workers" ? "worker" : lane === "Reviews" ? "review" : "watch"} ${i + 1}`,
            lane,
            kind: lane === "Background" ? "watch" : lane === "Reviews" ? "review" : "agent",
            detail: `Invented span **${i + 1}** in the ${lane.toLowerCase()} lane.`,
        });
    }

    return {
        series: [
            { id: "context", label: "Context size", unit: "tokens", points: context, kind: "line", tone: "info" },
            { id: "cost", label: "Cumulative cost", unit: "usd", points: cost, kind: "area", tone: "warn" },
            { id: "hit", label: "Cache hit", unit: "%", points: hit, kind: "line", tone: "ok", hidden: true },
            {
                id: "reads",
                label: "Cache reads",
                unit: "tokens",
                points: reads,
                kind: "area",
                stack: "cache",
                group: "cache",
                hidden: true,
            },
            {
                id: "writes",
                label: "Cache writes",
                unit: "tokens",
                points: writes,
                kind: "area",
                stack: "cache",
                group: "cache",
                hidden: true,
            },
            { id: "usage", label: "Usage bar", unit: "%", points: usage, kind: "step", tone: "err", dashed: true },
        ],
        markers,
        spans,
    };
}

const DEMO = buildDemo();
const POINTS = DEMO.series.reduce((n, s) => n + s.points.length, 0);

export default function TimeSeriesGallery() {
    return (
        <Page>
            <Hero
                kicker="Kit gallery"
                title="TimeSeries"
                subtitle={`Canvas chart for dense time data: ${POINTS.toLocaleString("en-US")} invented points, ${DEMO.markers.length} markers and ${DEMO.spans.length} spans over ${DAYS} days.`}
            />
            <Section title="Session over ten days">
                <TimeSeries
                    id="gallery-session"
                    title="Context and cost"
                    syncId="gallery"
                    series={DEMO.series}
                    markers={DEMO.markers}
                    spans={DEMO.spans}
                    units={{
                        tokens: { label: "tokens" },
                        usd: { label: "USD" },
                        "%": { label: "%" },
                    }}
                />
            </Section>
            <Section title="Synced second chart">
                <TimeSeries
                    id="gallery-usage"
                    title="Usage bar (synced viewport and crosshair)"
                    syncId="gallery"
                    height={140}
                    brush={false}
                    series={DEMO.series.filter((s) => s.id === "usage").map((s) => ({ ...s, dashed: false }))}
                />
            </Section>
            <Callout tone="info" title="Try it">
                Scroll over the plot to zoom around the cursor, drag to pan, Shift-drag to select a range, drag the
                window in the overview strip, or press + - and the arrow keys after focusing the chart. Alt-click a
                series chip to show only that series. Click a marker count to list its markers.
            </Callout>
        </Page>
    );
}
