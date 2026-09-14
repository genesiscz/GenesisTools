import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import { type AxResult, runAx } from "./runner";

const CURSOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface SoftwareCursor {
    name: string;
    pid: number;
    windowId: number;
    x: number;
    y: number;
    snapshot: string;
    movedAt: string;
}

export interface MoveSoftwareCursorOptions {
    app: string;
    snapshot: string;
    coords: string;
    name?: string;
    dependencies?: CursorDependencies;
}

export interface ClickSoftwareCursorOptions {
    name?: string;
    snapshot?: string;
    button?: "left" | "right" | "middle";
    double?: boolean;
    dependencies?: CursorDependencies;
}

export interface CursorDependencies {
    runAx: typeof runAx;
    now: () => Date;
}

const DEFAULT_DEPENDENCIES: CursorDependencies = {
    runAx,
    now: () => new Date(),
};

function cursorDirectory(): string {
    return join(new Storage("control").getBaseDir(), "cursors");
}

function assertCursorName(name: string): void {
    if (!CURSOR_NAME_PATTERN.test(name)) {
        throw new Error("cursor name must use 1-64 ASCII letters, digits, underscores or hyphens");
    }
}

function parseCoordinates(coords: string): { x: number; y: number } {
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+)),(-?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(coords);
    if (!match) {
        throw new Error("cursor coordinates must be finite x,y numbers");
    }

    const x = Number(match[1]);
    const y = Number(match[2]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("cursor coordinates must be finite x,y numbers");
    }

    return { x, y };
}

export function cursorPath(name: string): string {
    assertCursorName(name);
    return join(cursorDirectory(), `${name}.json`);
}

function isSoftwareCursor(value: unknown): value is SoftwareCursor {
    if (!value || typeof value !== "object") {
        return false;
    }

    const cursor = value as Record<string, unknown>;
    return (
        typeof cursor.name === "string" &&
        CURSOR_NAME_PATTERN.test(cursor.name) &&
        typeof cursor.pid === "number" &&
        Number.isInteger(cursor.pid) &&
        cursor.pid > 0 &&
        typeof cursor.windowId === "number" &&
        Number.isInteger(cursor.windowId) &&
        cursor.windowId > 0 &&
        typeof cursor.x === "number" &&
        Number.isFinite(cursor.x) &&
        typeof cursor.y === "number" &&
        Number.isFinite(cursor.y) &&
        typeof cursor.snapshot === "string" &&
        cursor.snapshot.length > 0 &&
        typeof cursor.movedAt === "string" &&
        !Number.isNaN(Date.parse(cursor.movedAt))
    );
}

export function loadCursor(name = "default"): SoftwareCursor | null {
    const path = cursorPath(name);
    if (!existsSync(path)) {
        return null;
    }

    const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    if (!isSoftwareCursor(parsed) || parsed.name !== name) {
        throw new Error(`invalid software cursor state at ${path}`);
    }

    return parsed;
}

export function saveCursor(cursor: SoftwareCursor): void {
    const path = cursorPath(cursor.name);
    if (!isSoftwareCursor(cursor)) {
        throw new Error("invalid software cursor state");
    }

    atomicWriteFileSync(path, SafeJSON.stringify(cursor, null, 2));
    logger.debug({ cursor: cursor.name, pid: cursor.pid, windowId: cursor.windowId }, "saved software cursor");
}

export function moveSoftwareCursor(options: MoveSoftwareCursorOptions): AxResult {
    const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
    const name = options.name ?? "default";
    assertCursorName(name);
    const coords = parseCoordinates(options.coords);
    const result = dependencies.runAx(
        [
            "act",
            "--app",
            options.app,
            "--snapshot",
            options.snapshot,
            "--action",
            "move",
            "--coords",
            options.coords,
            "--background",
        ],
        30_000
    );
    if (!result.ok) {
        return result;
    }

    if (
        typeof result.pid !== "number" ||
        !Number.isInteger(result.pid) ||
        result.pid <= 0 ||
        typeof result.windowId !== "number" ||
        !Number.isInteger(result.windowId) ||
        result.windowId <= 0
    ) {
        return { ok: false, error: "native move returned invalid cursor metadata" };
    }

    let snapshotMetadata: { pid: number; windowId: number; launch: number };
    try {
        snapshotMetadata = decodeSnapshotMetadata(options.snapshot);
    } catch (error) {
        logger.debug({ error }, "native move succeeded with undecodable snapshot metadata");
        return { ok: false, error: "native move metadata does not match snapshot" };
    }

    if (snapshotMetadata.pid !== result.pid || snapshotMetadata.windowId !== result.windowId) {
        return { ok: false, error: "native move metadata does not match snapshot" };
    }

    saveCursor({
        name,
        pid: result.pid,
        windowId: result.windowId,
        x: coords.x,
        y: coords.y,
        snapshot: options.snapshot,
        movedAt: dependencies.now().toISOString(),
    });
    return result;
}

export function decodeSnapshotMetadata(snapshot: string): { pid: number; windowId: number; launch: number } {
    if (
        snapshot.length === 0 ||
        snapshot.length >= 8192 ||
        snapshot.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(snapshot)
    ) {
        throw new Error("invalid snapshot token");
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(Buffer.from(snapshot, "base64").toString("utf8"), { strict: true });
    } catch (error) {
        logger.debug({ error }, "could not decode software cursor snapshot metadata");
        throw new Error("invalid snapshot token");
    }

    if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid snapshot token");
    }

    const token = parsed as Record<string, unknown>;
    if (
        token.version !== 1 ||
        typeof token.pid !== "number" ||
        !Number.isInteger(token.pid) ||
        token.pid <= 0 ||
        typeof token.window !== "number" ||
        !Number.isInteger(token.window) ||
        token.window <= 0 ||
        typeof token.launch !== "number" ||
        !Number.isFinite(token.launch) ||
        token.launch <= 0
    ) {
        throw new Error("invalid snapshot token");
    }

    return { pid: token.pid, windowId: token.window, launch: token.launch };
}

export function clickSoftwareCursor(options: ClickSoftwareCursorOptions): AxResult {
    const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
    const name = options.name ?? "default";
    const cursor = loadCursor(name);
    if (!cursor) {
        return { ok: false, error: `software cursor ${name} does not exist; move it first` };
    }

    let savedMetadata: { pid: number; windowId: number; launch: number };
    try {
        savedMetadata = decodeSnapshotMetadata(cursor.snapshot);
    } catch (error) {
        logger.debug({ error, cursor: name }, "saved software cursor snapshot is invalid");
        return { ok: false, error: `saved snapshot token for cursor ${name} is invalid` };
    }

    if (savedMetadata.pid !== cursor.pid || savedMetadata.windowId !== cursor.windowId) {
        return { ok: false, error: `saved snapshot metadata does not match cursor ${name}` };
    }

    const snapshot = options.snapshot ?? cursor.snapshot;
    if (options.snapshot !== undefined) {
        let metadata: { pid: number; windowId: number; launch: number };
        try {
            metadata = decodeSnapshotMetadata(options.snapshot);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }

        if (metadata.pid !== cursor.pid) {
            return { ok: false, error: `snapshot belongs to a different app instance than cursor ${name}` };
        }

        if (metadata.windowId !== cursor.windowId) {
            return { ok: false, error: `snapshot belongs to a different window than cursor ${name}` };
        }

        if (metadata.launch !== savedMetadata.launch) {
            return { ok: false, error: `snapshot belongs to a different app launch than cursor ${name}` };
        }
    }

    const args = [
        "act",
        "--app",
        String(cursor.pid),
        "--snapshot",
        snapshot,
        "--action",
        "click",
        "--coords",
        `${cursor.x},${cursor.y}`,
        "--background",
    ];

    if (options.button !== undefined) {
        args.push("--button", options.button);
    }

    if (options.double) {
        args.push("--double");
    }

    return dependencies.runAx(args, 30_000);
}
