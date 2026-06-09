import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";
import { fetchAuthToken, resolveSession } from "../lib/auth";
import { ChartClient } from "../lib/chart-client";
import { getLayoutStudies } from "../lib/charts-storage";
import { formatIndicatorHeader, formatSignalLine, formatStudyRow } from "../lib/format";
import { fetchStandardList, resolveAlias } from "../lib/indicator-aliases";
import { notifySignal } from "../lib/notify";
import { isAuthToGet, parseScriptSpec, translateIndicator } from "../lib/pine-facade";
import { SignalDetector } from "../lib/signals";
import { buildStudyValues, buildStudyValuesFromLayout, parseInputFlags, type StudyValues } from "../lib/study";
import { normalizeTicker } from "../lib/symbols";
import type { StudyMeta, StudyPoint } from "../lib/types";

const MAX_CHART_STUDIES = 5;

export interface IndicatorOpts {
    tf: string;
    bars: string;
    input: string[];
    fromChart?: string;
    once?: boolean;
    signalsOnly?: boolean;
    json?: boolean;
    notify?: boolean;
    exec?: string;
    cookie?: string;
}

interface AttachedStudy {
    meta: StudyMeta;
    label: string;
    detector: SignalDetector;
}

function SafeJSONLine(obj: object): string {
    return SafeJSON.stringify(obj, { strict: true }) ?? "";
}

async function resolveMeta(spec: string, cookie: string | undefined): Promise<StudyMeta> {
    const parsed = parseScriptSpec(spec);
    if (parsed) {
        return translateIndicator({ pineId: parsed.pineId, cookie });
    }

    const list = await fetchStandardList();
    const hit = resolveAlias(spec, list);
    if (!hit) {
        throw new Error(
            `Unknown indicator "${spec}". Try a STD;/PUB; id, a script URL, or 'tools tradingview indicators ${spec}' to search.`
        );
    }

    return translateIndicator({ pineId: hit.scriptIdPart, version: hit.version, cookie });
}

function assertSpecChoice(spec: string | undefined, fromChart: string | undefined): void {
    if (spec && fromChart) {
        throw new Error("Provide either an indicator spec or --from-chart, not both.");
    }

    if (!spec && !fromChart) {
        throw new Error("Provide an indicator spec or --from-chart <layoutId>.");
    }
}

function applyCliOverrides(values: StudyValues, meta: StudyMeta, cliOverrides: Record<string, string>): StudyValues {
    for (const [key, raw] of Object.entries(cliOverrides)) {
        const input = meta.inputs.find(
            (candidate) => candidate.name.toLowerCase() === key || candidate.id.toLowerCase() === key
        );
        if (input) {
            values[input.id] = buildStudyValues(meta, { [key]: raw })[input.id];
        }
    }

    return values;
}

export async function runIndicator(
    spec: string | undefined,
    symbol: string | undefined,
    opts: IndicatorOpts
): Promise<void> {
    try {
        await runIndicatorInner(spec, symbol, opts);
    } catch (err) {
        out.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

async function runIndicatorInner(
    spec: string | undefined,
    symbol: string | undefined,
    opts: IndicatorOpts
): Promise<void> {
    if (!symbol) {
        out.error("Symbol is required, e.g. NASDAQ:AAPL or BYBIT:BTCUSDT.P");
        process.exit(1);
    }

    assertSpecChoice(spec, opts.fromChart);

    const ticker = normalizeTicker(symbol);
    const session = await resolveSession({ cookie: opts.cookie });
    const cookie = session?.cookie;
    const cliOverrides = parseInputFlags(opts.input);
    const pendingStudies: Array<{ meta: StudyMeta; label: string; values: StudyValues }> = [];
    let heading = "";

    if (opts.fromChart) {
        if (!session) {
            out.error("--from-chart requires a TradingView session cookie.");
            process.exit(1);
        }

        let layoutStudies = (await getLayoutStudies(session, opts.fromChart)).filter((study) => study.pineId);
        if (layoutStudies.length === 0) {
            out.error(`Layout ${opts.fromChart} has no Pine/script studies to attach.`);
            process.exit(1);
        }

        if (layoutStudies.length > MAX_CHART_STUDIES) {
            out.warn(`Layout has ${layoutStudies.length} studies; attaching the first ${MAX_CHART_STUDIES}.`);
            layoutStudies = layoutStudies.slice(0, MAX_CHART_STUDIES);
        }

        for (const layoutStudy of layoutStudies) {
            const meta = await translateIndicator({
                pineId: layoutStudy.pineId!,
                version: layoutStudy.pineVersion ?? "last",
                cookie: session.cookie,
            });
            if (meta.pineId.startsWith("PUB;")) {
                const allowed = await isAuthToGet({
                    pineId: meta.pineId,
                    version: meta.pineVersion,
                    cookie: session.cookie,
                });
                if (!allowed) {
                    out.error(`Your account cannot access ${meta.pineId} (${layoutStudy.name}).`);
                    process.exit(1);
                }
            }

            const values = applyCliOverrides(buildStudyValuesFromLayout(meta, layoutStudy.inputs), meta, cliOverrides);
            pendingStudies.push({ meta, label: layoutStudy.name, values });
        }

        heading = `${opts.fromChart} (${pendingStudies.length} studies) on ${ticker}`;
    } else {
        const meta = await resolveMeta(spec!, cookie);
        if (meta.pineId.startsWith("PUB;")) {
            const allowed = await isAuthToGet({ pineId: meta.pineId, version: meta.pineVersion, cookie });
            if (!allowed) {
                out.error(`Your account cannot access ${meta.pineId} (${meta.shortDescription || meta.description}).`);
                process.exit(1);
            }
        }

        pendingStudies.push({
            meta,
            label: meta.shortDescription || meta.description,
            values: buildStudyValues(meta, cliOverrides),
        });
        heading = `${meta.description} on ${ticker}`;
    }

    let authToken = "unauthorized_user_token";
    let host = "data.tradingview.com";
    if (session) {
        authToken = await fetchAuthToken(session.cookie);
        host = "prodata.tradingview.com";
    } else if (pendingStudies.some((entry) => entry.meta.pineId.startsWith("PUB;"))) {
        out.warn("No session configured — community scripts usually need one. Trying as guest.");
    }

    const client = new ChartClient({
        authToken,
        host,
        reconnect: !opts.once,
        onAuthTokenRefresh: session ? () => fetchAuthToken(session.cookie) : undefined,
    });
    client.setSymbol({ symbol: ticker, timeframe: opts.tf, barCount: Number(opts.bars) });

    const studyById = new Map<string, AttachedStudy>();
    for (const entry of pendingStudies) {
        const studyId = client.addStudy(entry.values);
        studyById.set(studyId, {
            meta: entry.meta,
            label: entry.label,
            detector: new SignalDetector(entry.meta.plots),
        });
    }

    out.printErr(pc.dim(`${heading} (${opts.tf}, ${opts.bars} bars) via ${host} — Ctrl-C to stop\n`));

    const snapshots = new Map<string, StudyPoint[]>();
    const liveMode = new Set<string>();
    let completedStudies = 0;

    const emitPoint = (label: string, studyMeta: StudyMeta, point: StudyPoint): void => {
        if (opts.json) {
            out.print(`${SafeJSONLine({ type: "point", symbol: ticker, study: label, ...point })}\n`);
            return;
        }

        if (!opts.signalsOnly) {
            out.printlnErr(pc.cyan(`[${label}] `) + formatStudyRow(point, studyMeta.plots));
        }
    };

    client.on("studyData", ({ studyId, points }) => {
        const ctx = studyById.get(studyId);
        if (!ctx) {
            return;
        }

        for (const point of points) {
            if (liveMode.has(studyId)) {
                emitPoint(ctx.label, ctx.meta, point);
            } else {
                const bucket = snapshots.get(studyId) ?? [];
                bucket.push(point);
                snapshots.set(studyId, bucket);
            }
        }

        for (const event of ctx.detector.ingest(points)) {
            if (opts.json) {
                out.print(`${SafeJSONLine({ type: "signal", symbol: ticker, study: ctx.label, ...event })}\n`);
            } else {
                out.printlnErr(pc.cyan(`[${ctx.label}] `) + formatSignalLine(event, ticker));
            }

            if (event.kind === "live") {
                notifySignal(event, ticker, { say: opts.notify, exec: opts.exec });
            }
        }
    });

    client.on("studyCompleted", (studyId) => {
        const ctx = studyById.get(studyId);
        if (!ctx || liveMode.has(studyId)) {
            return;
        }

        const snapshot = snapshots.get(studyId) ?? [];
        snapshot.sort((a, b) => a.barIndex - b.barIndex);
        const tail = snapshot.slice(-Number(opts.bars));
        if (!opts.signalsOnly && !opts.json && tail.length > 0) {
            out.printlnErr(formatIndicatorHeader(ctx.meta.plots));
        }

        for (const point of tail) {
            emitPoint(ctx.label, ctx.meta, point);
        }

        ctx.detector.markLive();
        liveMode.add(studyId);
        completedStudies += 1;

        if (completedStudies >= studyById.size) {
            if (opts.once) {
                client.dispose();
                process.exit(0);
            }

            out.printErr(pc.dim("\n— live —\n"));
        }
    });

    client.on("studyError", ({ reason }) => {
        out.error(`Study error: ${reason}`);
        client.dispose();
        process.exit(1);
    });
    client.on("symbolError", ({ symbol: sym, errmsg }) => {
        out.error(
            `✗ ${sym}: ${errmsg === "no_such_symbol" ? "no such symbol (check the EXCHANGE:TICKER spelling)" : errmsg}`
        );
        client.dispose();
        process.exit(1);
    });
    client.on("reconnecting", ({ attempt, delayMs }) =>
        out.printErr(pc.dim(`reconnecting (attempt ${attempt}) in ${Math.round(delayMs / 1000)}s…\n`))
    );
    client.on("error", (err) => logger.error({ err }, "tradingview: chart socket error"));

    process.on("SIGINT", () => {
        client.dispose();
        process.exit(0);
    });

    client.connect();
    await new Promise(() => {});
}
