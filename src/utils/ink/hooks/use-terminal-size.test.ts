import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readTerminalSize, subscribeTerminalResize, type TerminalSize } from "./use-terminal-size";

const CLEAR_SEQUENCE = "\x1b[2J\x1b[H";

interface FakeStdout extends EventEmitter {
    columns: number;
    rows: number;
    write: (chunk: string) => boolean;
    written: string[];
}

function makeStdout(columns = 100, rows = 40): FakeStdout {
    const emitter = new EventEmitter() as FakeStdout;
    emitter.columns = columns;
    emitter.rows = rows;
    emitter.written = [];
    emitter.write = (chunk: string) => {
        emitter.written.push(chunk);
        return true;
    };
    return emitter;
}

type StoreStdout = Parameters<typeof subscribeTerminalResize>[0];

function subscribe(stdout: FakeStdout, onSize: (size: TerminalSize) => void, clearOnResize = false): () => void {
    return subscribeTerminalResize(stdout as unknown as StoreStdout, { notify: onSize, clearOnResize });
}

describe("subscribeTerminalResize", () => {
    test("many subscribers share ONE resize listener on the stream", () => {
        const stdout = makeStdout();

        // The regression: 12 mounted components used to mean 12 listeners,
        // tripping MaxListenersExceededWarning (cap 10) — the warning printed
        // to stderr at startup and corrupted the Ink frame.
        const detach = Array.from({ length: 12 }, () => subscribe(stdout, () => {}));
        expect(stdout.listenerCount("resize")).toBe(1);

        for (const off of detach) {
            off();
        }

        expect(stdout.listenerCount("resize")).toBe(0);
    });

    test("resize fans out the new size to every subscriber", () => {
        const stdout = makeStdout(100, 40);
        const seen: TerminalSize[] = [];
        const offs = [subscribe(stdout, (s) => seen.push(s)), subscribe(stdout, (s) => seen.push(s))];

        stdout.columns = 80;
        stdout.rows = 24;
        stdout.emit("resize");

        expect(seen).toEqual([
            { columns: 80, rows: 24 },
            { columns: 80, rows: 24 },
        ]);

        for (const off of offs) {
            off();
        }
    });

    test("clearOnResize clears once even with many subscribers", () => {
        const stdout = makeStdout();
        const offs = [
            subscribe(stdout, () => {}),
            subscribe(stdout, () => {}, true),
            subscribe(stdout, () => {}, true),
        ];

        stdout.emit("resize");

        expect(stdout.written.filter((w) => w === CLEAR_SEQUENCE)).toHaveLength(1);

        for (const off of offs) {
            off();
        }
    });

    test("no clear written when no subscriber asked for it", () => {
        const stdout = makeStdout();
        const off = subscribe(stdout, () => {});

        stdout.emit("resize");

        expect(stdout.written).toHaveLength(0);
        off();
    });

    test("detaching one subscriber keeps the rest live", () => {
        const stdout = makeStdout();
        const seen: TerminalSize[] = [];
        const offFirst = subscribe(stdout, () => {});
        const offSecond = subscribe(stdout, (s) => seen.push(s));

        offFirst();
        stdout.emit("resize");

        expect(seen).toHaveLength(1);
        expect(stdout.listenerCount("resize")).toBe(1);
        offSecond();
    });

    test("re-subscribing after full teardown attaches a fresh listener", () => {
        const stdout = makeStdout();
        const offFirst = subscribe(stdout, () => {});
        offFirst();
        expect(stdout.listenerCount("resize")).toBe(0);

        const seen: TerminalSize[] = [];
        const offSecond = subscribe(stdout, (s) => seen.push(s));
        stdout.emit("resize");

        expect(seen).toHaveLength(1);
        offSecond();
    });
});

describe("readTerminalSize", () => {
    test("0×0 degenerate PTY falls back to 80×24", () => {
        const stdout = makeStdout(0, 0);
        expect(readTerminalSize(stdout as unknown as StoreStdout)).toEqual({ columns: 80, rows: 24 });
    });

    test("missing stream falls back to 80×24", () => {
        expect(readTerminalSize(undefined)).toEqual({ columns: 80, rows: 24 });
    });
});
