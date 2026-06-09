import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { encodeFrame, genSessionId, isHeartbeat, parseFrames } from "./protocol";
import type { StudyValues } from "./study";
import { toProSymbol } from "./symbols";
import type { Bar, StudyPoint } from "./types";
import { tvSocket } from "./ws";

interface ChartClientOpts {
    authToken?: string;
    host?: string;
    timezone?: string;
    reconnect?: boolean;
    onAuthTokenRefresh?: () => Promise<string>;
}

interface SymbolSpec {
    symbol: string;
    timeframe: string;
    barCount: number;
}

export interface ChartClient {
    on(event: "open", listener: () => void): this;
    on(event: "bars", listener: (bars: Bar[]) => void): this;
    on(event: "seriesCompleted", listener: () => void): this;
    on(event: "studyData", listener: (data: { studyId: string; points: StudyPoint[] }) => void): this;
    on(event: "studyCompleted", listener: (studyId: string) => void): this;
    on(event: "studyError", listener: (info: { studyId: string; reason: string }) => void): this;
    on(event: "symbolError", listener: (info: { symbol: string; errmsg: string }) => void): this;
    on(event: "reconnecting", listener: (info: { attempt: number; delayMs: number }) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
}

/** Raw numeric cell from TV: numbers, null, or the literal string "NaN". */
function toCell(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    return null;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter events
export class ChartClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private readonly sessionId = genSessionId("cs_");
    private readonly host: string;
    private readonly timezone: string;
    private readonly reconnect: boolean;
    private readonly onAuthTokenRefresh?: () => Promise<string>;
    private authTokenCurrent: string;
    private symbolSpec: SymbolSpec | null = null;
    private studyCounter = 0;
    private readonly studies = new Map<string, StudyValues>();
    private open = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(opts: ChartClientOpts = {}) {
        super();
        this.authTokenCurrent = opts.authToken ?? "unauthorized_user_token";
        this.host = opts.host ?? "data.tradingview.com";
        this.timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        this.reconnect = opts.reconnect ?? false;
        this.onAuthTokenRefresh = opts.onAuthTokenRefresh;
    }

    connect(): void {
        const url = `wss://${this.host}/socket.io/websocket?type=chart`;
        logger.debug({ url }, "tradingview: opening chart socket");
        this.ws = tvSocket(url);
        this.ws.addEventListener("open", () => this.onOpen());
        this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
        this.ws.addEventListener("error", () => this.emit("error", new Error("chart socket error")));
        this.ws.addEventListener("close", () => {
            this.open = false;
            this.emit("close");
            this.maybeReconnect();
        });
    }

    /** Must be called before connect(); one symbol/series per client (KISS for v1). */
    setSymbol(spec: SymbolSpec): void {
        this.symbolSpec = spec;
    }

    /** Attach a study; safe to call before or after connect(). Returns the study id. */
    addStudy(values: StudyValues): string {
        this.studyCounter += 1;
        const studyId = `st_${this.studyCounter}`;
        this.studies.set(studyId, values);
        if (this.open) {
            this.sendCreateStudy(studyId, values);
        }

        return studyId;
    }

    close(): void {
        this.ws?.close();
    }

    dispose(): void {
        this.disposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.ws?.close();
    }

    /** Test hook: trigger the close path without a socket. */
    simulateCloseForTest(): void {
        this.open = false;
        this.emit("close");
        this.maybeReconnect();
    }

    private onOpen(): void {
        if (!this.symbolSpec) {
            this.emit("error", new Error("setSymbol() must be called before connect()"));
            return;
        }

        this.reconnectAttempt = 0;
        this.open = true;
        this.send({ m: "set_auth_token", p: [this.authTokenCurrent] });
        this.send({ m: "chart_create_session", p: [this.sessionId, ""] });
        this.send({ m: "switch_timezone", p: [this.sessionId, this.timezone] });
        this.send({
            m: "resolve_symbol",
            p: [this.sessionId, "sds_sym_1", toProSymbol(this.symbolSpec.symbol)],
        });
        this.send({
            m: "create_series",
            p: [this.sessionId, "sds_1", "s1", "sds_sym_1", this.symbolSpec.timeframe, this.symbolSpec.barCount, ""],
        });
        for (const [studyId, values] of this.studies) {
            this.sendCreateStudy(studyId, values);
        }

        this.emit("open");
    }

    private sendCreateStudy(studyId: string, values: StudyValues): void {
        this.send({
            m: "create_study",
            p: [this.sessionId, studyId, "st1", "sds_1", "Script@tv-scripting-101!", values],
        });
    }

    private onMessage(raw: string): void {
        for (const frame of parseFrames(raw)) {
            if (isHeartbeat(frame)) {
                this.ws?.send(encodeFrame(frame));
                continue;
            }

            this.handleFrame(frame);
        }
    }

    /** Package-visible for tests: handle one unwrapped JSON frame. */
    handleFrame(frame: string): void {
        let msg: { m?: string; p?: unknown[] };
        try {
            msg = SafeJSON.parse(frame, { strict: true });
        } catch {
            return;
        }

        if (!msg.m || !Array.isArray(msg.p)) {
            return;
        }

        if (msg.m === "timescale_update" || msg.m === "du") {
            this.handleData(msg.p);
            return;
        }

        if (msg.m === "series_completed") {
            this.emit("seriesCompleted");
            return;
        }

        if (msg.m === "study_completed") {
            this.emit("studyCompleted", String(msg.p[1] ?? ""));
            return;
        }

        if (msg.m === "study_error") {
            const reason = msg.p
                .slice(2)
                .map((part) => (typeof part === "string" ? part : SafeJSON.stringify(part)))
                .join(" ");
            this.emit("studyError", { studyId: String(msg.p[1] ?? ""), reason });
            return;
        }

        if (msg.m === "symbol_error") {
            this.emit("symbolError", { symbol: String(msg.p[2] ?? ""), errmsg: String(msg.p[3] ?? "symbol error") });
            return;
        }

        if (msg.m === "critical_error" || msg.m === "protocol_error") {
            this.emit("error", new Error(`${msg.m}: ${SafeJSON.stringify(msg.p)}`));
        }
    }

    private handleData(p: unknown[]): void {
        const payload = p[1];
        if (!payload || typeof payload !== "object") {
            return;
        }

        for (const [key, node] of Object.entries(payload as Record<string, unknown>)) {
            if (!node || typeof node !== "object") {
                continue;
            }

            const seriesRows = (node as { s?: unknown[] }).s;
            if (key.startsWith("sds_") && Array.isArray(seriesRows)) {
                const bars = seriesRows.map((row) => this.toBar(row)).filter((b): b is Bar => b !== null);
                if (bars.length > 0) {
                    this.emit("bars", bars);
                }

                continue;
            }

            const studyRows = (node as { st?: unknown[] }).st;
            if (key.startsWith("st_") && Array.isArray(studyRows)) {
                const points = studyRows.map((row) => this.toStudyPoint(row)).filter((x): x is StudyPoint => x !== null);
                if (points.length > 0) {
                    this.emit("studyData", { studyId: key, points });
                }
            }
        }
    }

    private toBar(row: unknown): Bar | null {
        const r = row as { i?: number; v?: unknown[] } | null;
        if (!r?.v || r.v.length < 5) {
            return null;
        }

        const [time, open, high, low, close, volume] = r.v;
        if (typeof time !== "number") {
            return null;
        }

        return {
            time,
            open: toCell(open) ?? 0,
            high: toCell(high) ?? 0,
            low: toCell(low) ?? 0,
            close: toCell(close) ?? 0,
            volume: toCell(volume) ?? undefined,
        };
    }

    private toStudyPoint(row: unknown): StudyPoint | null {
        const r = row as { i?: number; v?: unknown[] } | null;
        if (!r?.v || r.v.length < 2 || typeof r.v[0] !== "number") {
            return null;
        }

        return { barIndex: r.i ?? -1, time: r.v[0], values: r.v.slice(1).map(toCell) };
    }

    private maybeReconnect(): void {
        if (!this.reconnect || this.disposed) {
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempt += 1;
        const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 30_000);
        this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
        this.reconnectTimer = setTimeout(() => {
            void this.refreshAndConnect();
        }, delayMs);
    }

    private async refreshAndConnect(): Promise<void> {
        if (this.disposed) {
            return;
        }

        if (this.onAuthTokenRefresh) {
            try {
                this.authTokenCurrent = await this.onAuthTokenRefresh();
            } catch (err) {
                logger.warn({ err }, "tradingview: auth token refresh failed; reusing previous token");
            }
        }

        this.connect();
    }

    private send(obj: object): void {
        this.ws?.send(encodeFrame(obj));
    }
}