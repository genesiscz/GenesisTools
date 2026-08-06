import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
    columns: number;
    rows: number;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

type Stdout = NonNullable<ReturnType<typeof useStdout>["stdout"]>;

export interface ResizeSubscriber {
    notify: (size: TerminalSize) => void;
    clearOnResize: boolean;
}

interface SizeStore {
    subscribers: Set<ResizeSubscriber>;
    onResize: () => void;
}

/**
 * One shared "resize" listener per stream, fanned out to every mounted hook.
 * Per-component listeners tripped Node's MaxListenersExceededWarning (default
 * cap 10) in screens that render one sized component per account — the warning
 * prints to stderr mid-render and corrupts the Ink frame.
 */
const stores = new WeakMap<Stdout, SizeStore>();

export function readTerminalSize(stdout: Stdout | undefined): TerminalSize {
    // `||` not `??`: degenerate PTYs (script/CI) report 0×0, which must fall
    // back to the default size too — a 0-row clamp breaks Ink's repaint math.
    return {
        columns: stdout?.columns || DEFAULT_SIZE.columns,
        rows: stdout?.rows || DEFAULT_SIZE.rows,
    };
}

/** Attach `subscriber` to the stream's shared resize listener; returns the detach. */
export function subscribeTerminalResize(stdout: Stdout, subscriber: ResizeSubscriber): () => void {
    let store = stores.get(stdout);
    if (!store) {
        const created: SizeStore = {
            subscribers: new Set(),
            onResize: () => {
                // Clear BEFORE the size state propagates: Ink's own resize
                // listener has already repainted with mismatched erase counts
                // (re-wrapped lines), so blank the screen and home the cursor
                // now — the notifications below trigger a clean full repaint
                // from the top. Intended for full-screen apps whose frame
                // starts at the top-left. (A deferred clear here used to run
                // AFTER the repaint, leaving stale frames behind.) One clear
                // for the whole stream, no matter how many subscribers asked.
                let shouldClear = false;
                for (const sub of created.subscribers) {
                    if (sub.clearOnResize) {
                        shouldClear = true;
                        break;
                    }
                }

                if (shouldClear) {
                    stdout.write("\x1b[2J\x1b[H");
                }

                const size = readTerminalSize(stdout);
                for (const sub of created.subscribers) {
                    sub.notify(size);
                }
            },
        };
        stores.set(stdout, created);
        stdout.on("resize", created.onResize);
        store = created;
    }

    const active = store;
    active.subscribers.add(subscriber);

    return () => {
        active.subscribers.delete(subscriber);
        if (active.subscribers.size === 0) {
            stdout.off("resize", active.onResize);
            stores.delete(stdout);
        }
    };
}

export function useTerminalSize({ clearOnResize = false } = {}): TerminalSize {
    const { stdout } = useStdout();
    const [size, setSize] = useState<TerminalSize>(() => readTerminalSize(stdout));

    useEffect(() => {
        if (!stdout) {
            return;
        }

        return subscribeTerminalResize(stdout, { notify: setSize, clearOnResize });
    }, [stdout, clearOnResize]);

    return size;
}
