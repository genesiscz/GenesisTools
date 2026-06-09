/**
 * Live capture helper for TradingView study fixtures.
 *
 * Usage:
 *   bun scripts/capture-tv-study-frames.ts [--study rsi|mdx|both]
 *
 * Writes sanitized fixtures under src/tradingview/lib/__fixtures__/.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchAuthToken, resolveSession } from "@app/tradingview/lib/auth";
import { translateIndicator } from "@app/tradingview/lib/pine-facade";
import { encodeFrame, genSessionId, isHeartbeat, parseFrames } from "@app/tradingview/lib/protocol";
import type { StudyValues } from "@app/tradingview/lib/study";
import { buildStudyValues } from "@app/tradingview/lib/study";
import { toProSymbol } from "@app/tradingview/lib/symbols";
import { TV_ORIGIN, tvSocket } from "@app/tradingview/lib/ws";
import { SafeJSON } from "@app/utils/json";

const FIXTURES_DIR = join(import.meta.dir, "../src/tradingview/lib/__fixtures__");
const SYMBOL = "BYBIT:BTCUSDT.P";
const TIMEFRAME = "15";
const BAR_COUNT = 300;
const HOST = "prodata.tradingview.com";
const CAPTURE_MS = 12_000;

type Direction = "in" | "out";

interface FrameLine {
    dir: Direction;
    raw: string;
}

function sanitize(text: string): string {
    return text
        .replace(/sessionid=[^;\s"]+/g, "sessionid=REDACTED")
        .replace(/sessionid_sign=[^;\s"]+/g, "sessionid_sign=REDACTED")
        .replace(/device_t=[^;\s"]+/g, "device_t=REDACTED")
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "REDACTED")
        .replace(/"auth_token":"[^"]+"/g, '"auth_token":"REDACTED"')
        .replace(/"session_id":"[^"]+"/g, '"session_id":"REDACTED"');
}

async function fetchTranslateFixture(pineId: string, cookie: string): Promise<unknown> {
    const url = `https://pine-facade.tradingview.com/pine-facade/translate/${encodeURIComponent(pineId)}/last`;
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, cookie } });
    const body = await res.text();
    try {
        return SafeJSON.parse(body, { strict: true });
    } catch {
        return { httpStatus: res.status, body };
    }
}

interface MdxPageMeta {
    ilTemplate: string;
    pineId: string;
    pineVersion: string;
    scriptIdPart: string;
    plots: Array<{ id: string; type: string; title: string }>;
}

async function fetchMdxPageMeta(cookie: string): Promise<MdxPageMeta> {
    const url = "https://www.tradingview.com/script/AGFHDbJ2-MDX-Free-PA-Buy-Sell-Confimation/";
    const res = await fetch(url, { headers: { origin: TV_ORIGIN, cookie } });
    const html = await res.text();
    const marker =
        'plot_5\\",\\"type\\":\\"arrows\\"}},\\"_metainfoVersion\\":52,\\"description\\":\\"MDX Free (PA) Buy/Sell Confimation\\"';
    const idx = html.indexOf(marker);
    if (idx < 0) {
        throw new Error("MDX meta block not found on script page");
    }

    const chunk = html.slice(idx - 2000, idx + 25_000);
    const scriptIdPart = chunk.match(/scriptIdPart\\":\\"([^\\"]+)/)?.[1];
    const textMatch = chunk.match(/\\"text\\":\\"([A-Za-z0-9+/=]{20,}_[A-Za-z0-9+/=]{20,})/);
    const pineVersion = chunk.match(/\\"pine\\":\{\\"digest\\":\\"[^\\"]+\\",\\"version\\":\\"([^\\"]+)/)?.[1] ?? "2.0";
    if (!scriptIdPart || !textMatch) {
        throw new Error("Failed to parse MDX ilTemplate/scriptIdPart from script page");
    }

    const plotTypes = [...chunk.matchAll(/"id":"(plot_\d+)","type":"([^"]+)"/g)].map((m) => ({
        id: m[1],
        type: m[2],
    }));
    const plotTitles = [...chunk.matchAll(/"plot_(\d+)":\{[^}]*"title":"([^"]+)"/g)].map((m) => ({
        id: `plot_${m[1]}`,
        title: m[2],
    }));
    const titleById = new Map(plotTitles.map((p) => [p.id, p.title]));
    const plots = plotTypes
        .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)
        .map((p) => ({ ...p, title: titleById.get(p.id) ?? p.id }));

    return {
        ilTemplate: textMatch[1],
        pineId: "PUB;AGFHDbJ2",
        pineVersion,
        scriptIdPart,
        plots,
    };
}

function buildMdxValues(meta: MdxPageMeta): StudyValues {
    return {
        text: meta.ilTemplate,
        pineId: meta.pineId,
        pineVersion: meta.pineVersion,
    };
}

async function captureStudySession({
    authToken,
    studyValues,
    runtime,
    label,
}: {
    authToken: string;
    studyValues: StudyValues;
    runtime: string;
    label: string;
}): Promise<FrameLine[]> {
    const lines: FrameLine[] = [];
    const chartSession = genSessionId("cs_");
    const studyId = "st_1";

    return new Promise((resolve, reject) => {
        const ws = tvSocket(`wss://${HOST}/socket.io/websocket?type=chart`);
        let settled = false;

        const finish = (err?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            try {
                ws.close();
            } catch {
                // ignore
            }
            if (err) {
                reject(err);
            } else {
                resolve(lines);
            }
        };

        const recordOut = (payload: object) => {
            const raw = encodeFrame(payload);
            lines.push({ dir: "out", raw });
            ws.send(raw);
        };

        const timer = setTimeout(() => finish(), CAPTURE_MS);

        ws.addEventListener("open", () => {
            recordOut({ m: "set_auth_token", p: [authToken] });
            recordOut({ m: "chart_create_session", p: [chartSession, ""] });
            recordOut({ m: "switch_timezone", p: [chartSession, "Etc/UTC"] });
            recordOut({
                m: "resolve_symbol",
                p: [chartSession, "sds_sym_1", toProSymbol(SYMBOL, { currencyId: "XTVCUSDT" })],
            });
            recordOut({
                m: "create_series",
                p: [chartSession, "sds_1", "s1", "sds_sym_1", TIMEFRAME, BAR_COUNT, ""],
            });
            recordOut({
                m: "create_study",
                p: [chartSession, studyId, "st1", "sds_1", runtime, studyValues],
            });
        });

        ws.addEventListener("message", (event) => {
            const raw = String(event.data);
            lines.push({ dir: "in", raw });

            for (const frame of parseFrames(raw)) {
                if (isHeartbeat(frame)) {
                    const echo = encodeFrame(frame);
                    lines.push({ dir: "out", raw: echo });
                    ws.send(echo);
                    continue;
                }

                let msg: { m?: string; p?: unknown[] };
                try {
                    msg = SafeJSON.parse(frame, { strict: true });
                } catch {
                    continue;
                }

                if (msg.m === "study_completed" && msg.p?.[1] === studyId) {
                    console.log(`[${label}] study_completed`);
                    finish();
                    return;
                }

                if (msg.m === "study_error" && msg.p?.[1] === studyId) {
                    console.error(`[${label}] study_error`, msg.p?.slice(2));
                    finish(new Error(`study_error for ${label}`));
                    return;
                }

                if (msg.m === "series_completed" && !settled) {
                    // keep waiting for study
                }
            }
        });

        ws.addEventListener("error", () => finish(new Error(`${label}: socket error`)));
        ws.addEventListener("close", () => {
            if (!settled) {
                finish();
            }
        });
    });
}

function framesToTxt(lines: FrameLine[]): string {
    return lines.map((line) => `${line.dir}\t${sanitize(line.raw)}`).join("\n");
}

async function writeFixture(name: string, content: string): Promise<void> {
    await mkdir(FIXTURES_DIR, { recursive: true });
    const path = join(FIXTURES_DIR, name);
    await Bun.write(path, content);
    const size = await Bun.file(path).size;
    console.log(`wrote ${path} (${size} bytes)`);
}

async function main(): Promise<void> {
    const arg = process.argv[2] ?? "both";
    const session = await resolveSession();
    if (!session?.cookie) {
        throw new Error("No TradingView session in ~/.genesis-tools/tradingview/config.json");
    }

    const authToken = await fetchAuthToken(session.cookie);
    console.log("auth token fetched");

    if (arg === "translate" || arg === "both" || arg === "rsi") {
        const rsiTranslate = await fetchTranslateFixture("STD;RSI", session.cookie);
        await writeFixture("translate-std-rsi.json", `${sanitize(SafeJSON.stringify(rsiTranslate, null, 2))}\n`);
    }

    if (arg === "translate" || arg === "both" || arg === "mdx") {
        const mdxTranslate = await fetchTranslateFixture("PUB;AGFHDbJ2", session.cookie);
        await writeFixture("translate-pub-mdx.json", `${sanitize(SafeJSON.stringify(mdxTranslate, null, 2))}\n`);
    }

    if (arg === "frames" || arg === "both" || arg === "rsi") {
        const rsiMeta = await translateIndicator({ pineId: "STD;RSI", cookie: session.cookie });
        const rsiValues = buildStudyValues(rsiMeta, {});
        console.log("RSI create_study runtime: Script@tv-scripting-101!");
        console.log("RSI pineId:", rsiValues.pineId, "pineVersion:", rsiValues.pineVersion);
        const rsiLines = await captureStudySession({
            authToken,
            studyValues: rsiValues,
            runtime: "Script@tv-scripting-101!",
            label: "RSI",
        });
        await writeFixture("chart-frames-rsi.txt", `${framesToTxt(rsiLines)}\n`);
    }

    if (arg === "frames" || arg === "both" || arg === "mdx") {
        const mdxMeta = await fetchMdxPageMeta(session.cookie);
        const mdxValues = buildMdxValues(mdxMeta);
        console.log("MDX scriptIdPart (page):", mdxMeta.scriptIdPart);
        console.log("MDX create_study pineId:", mdxValues.pineId, "pineVersion:", mdxValues.pineVersion);
        console.log("MDX plots:", mdxMeta.plots.map((p) => `${p.id}:${p.type}:${p.title}`).join(", "));
        const mdxLines = await captureStudySession({
            authToken,
            studyValues: mdxValues,
            runtime: "Script@tv-scripting-101!",
            label: "MDX",
        });
        await writeFixture("chart-frames-mdx.txt", `${framesToTxt(mdxLines)}\n`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
