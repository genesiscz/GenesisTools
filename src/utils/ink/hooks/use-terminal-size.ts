import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
    columns: number;
    rows: number;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

export function useTerminalSize({ clearOnResize = false } = {}): TerminalSize {
    const { stdout } = useStdout();

    // `||` not `??`: degenerate PTYs (script/CI) report 0×0, which must fall
    // back to the default size too — a 0-row clamp breaks Ink's repaint math.
    const [size, setSize] = useState<TerminalSize>(() => ({
        columns: stdout?.columns || DEFAULT_SIZE.columns,
        rows: stdout?.rows || DEFAULT_SIZE.rows,
    }));

    useEffect(() => {
        if (!stdout) {
            return;
        }

        const onResize = () => {
            // Clear BEFORE the size state propagates: Ink's own resize
            // listener has already repainted with mismatched erase counts
            // (re-wrapped lines), so blank the screen and home the cursor
            // now — the state update below triggers a clean full repaint
            // from the top. Intended for full-screen apps whose frame
            // starts at the top-left. (A deferred clear here used to run
            // AFTER the repaint, leaving stale frames behind.)
            if (clearOnResize) {
                stdout.write("\x1b[2J\x1b[H");
            }

            setSize({
                columns: stdout.columns || DEFAULT_SIZE.columns,
                rows: stdout.rows || DEFAULT_SIZE.rows,
            });
        };

        stdout.on("resize", onResize);
        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout, clearOnResize]);

    return size;
}
