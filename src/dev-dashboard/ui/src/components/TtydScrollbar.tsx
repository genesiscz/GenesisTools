import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ttydApi } from "@/lib/api";
import { scrollIframeTerminal } from "@/lib/iframe-keys";

interface Props {
    /** Active ttyd session id, or null when there's no terminal. */
    ttydId: string | null;
    /** The active terminal iframe — used for wheel scrolling in alt-screen apps. */
    iframeRef: RefObject<HTMLIFrameElement | null>;
}

// Throttle absolute (copy-mode) scroll-to calls while dragging so we don't flood tmux.
const DRAG_THROTTLE_MS = 110;
// Keep the optimistic thumb this long after release so it doesn't snap to a stale poll.
const DRAG_SETTLE_MS = 900;
// Relative (alt-screen) drag sensitivity: pixels of drag per scrolled line. Lower = faster.
const REL_PX_PER_LINE = 2.5;
// Fixed grip size for the relative scrubber (no real position to size against).
const REL_THUMB = 0.2;

/**
 * Hidden-behind-a-notch scrollback scrubber with two modes, because how you
 * scroll depends on what's running in the pane:
 *  - Normal buffer (shell): scroll lives in tmux history. Absolute mode — the
 *    thumb reflects the real position and a drag jumps anywhere via copy-mode.
 *  - Alternate screen (Claude Code, vim, less): the app owns scrolling and eats
 *    wheel events; tmux copy-mode would scroll the wrong buffer. Relative mode —
 *    a drag sends proportional wheel events to the app (same path as the keybar
 *    scroll buttons), and the grip springs back to centre.
 */
export function TtydScrollbar({ ttydId, iframeRef }: Props) {
    const [open, setOpen] = useState(false);
    const [dragFrac, setDragFrac] = useState<number | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);
    const draggingRef = useRef(false);
    const lastSentRef = useRef(0);
    const relLastYRef = useRef(0);
    const relAccumRef = useRef(0);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // Reset drag state and clear the settle timer when the active session changes
    // or the component unmounts — otherwise a pending setDragFrac fires on an
    // unmounted component or bleeds optimistic position across sessions.
    useEffect(() => {
        setDragFrac(null);
        draggingRef.current = false;

        if (settleTimer.current) {
            clearTimeout(settleTimer.current);
        }

        return () => {
            if (settleTimer.current) {
                clearTimeout(settleTimer.current);
            }
        };
    }, [ttydId]);

    const { data } = useQuery({
        queryKey: ["ttyd", "scroll-state", ttydId],
        queryFn: () => (ttydId ? ttydApi.scrollState(ttydId) : Promise.resolve({ state: null })),
        enabled: open && Boolean(ttydId),
        refetchInterval: 900,
    });

    const state = data?.state ?? null;
    const relative = state?.alternateOn ?? false;

    const total = state ? state.historySize + state.paneHeight : 0;
    const absThumbSize = state && total > 0 ? Math.min(1, Math.max(0.08, state.paneHeight / total)) : 1;
    const absStateTop = state && total > 0 ? (state.historySize - state.scrollPosition) / total : 1 - absThumbSize;

    const thumbSize = relative ? REL_THUMB : absThumbSize;
    const thumbTop = relative
        ? dragFrac !== null
            ? Math.min(Math.max(dragFrac - thumbSize / 2, 0), 1 - thumbSize)
            : (1 - thumbSize) / 2
        : dragFrac !== null
          ? dragFrac * (1 - thumbSize)
          : Math.min(absStateTop, 1 - thumbSize);

    const sendFraction = useCallback(
        (fraction: number) => {
            if (ttydId) {
                ttydApi.scrollTo(ttydId, fraction).catch((error) => {
                    // Transient backend/tmux hiccup — the next poll re-syncs the
                    // thumb. Logged for triage only.
                    console.debug("TtydScrollbar: scrollTo failed", { error, ttydId, fraction });
                });
            }
        },
        [ttydId]
    );

    const fractionFromPointer = useCallback((clientY: number): number => {
        const track = trackRef.current;
        if (!track) {
            return 1;
        }

        const rect = track.getBoundingClientRect();
        if (rect.height === 0) {
            return 1;
        }

        return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    }, []);

    const beginDrag = (e: React.PointerEvent) => {
        e.preventDefault();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);

        if (settleTimer.current) {
            clearTimeout(settleTimer.current);
        }

        setDragFrac(fractionFromPointer(e.clientY));
        relLastYRef.current = e.clientY;
        relAccumRef.current = 0;

        if (!relative) {
            lastSentRef.current = Date.now();
            sendFraction(fractionFromPointer(e.clientY));
        }
    };

    const moveDrag = (e: React.PointerEvent) => {
        if (!draggingRef.current) {
            return;
        }

        setDragFrac(fractionFromPointer(e.clientY));

        if (relative) {
            // Drag distance → wheel lines, sent to the app (+ = toward newer/live).
            relAccumRef.current += (e.clientY - relLastYRef.current) / REL_PX_PER_LINE;
            relLastYRef.current = e.clientY;
            const lines = Math.trunc(relAccumRef.current);

            if (lines !== 0) {
                relAccumRef.current -= lines;
                scrollIframeTerminal(iframeRef.current, lines);
            }

            return;
        }

        const now = Date.now();
        if (now - lastSentRef.current >= DRAG_THROTTLE_MS) {
            lastSentRef.current = now;
            sendFraction(fractionFromPointer(e.clientY));
        }
    };

    const endDrag = (e: React.PointerEvent) => {
        if (!draggingRef.current) {
            return;
        }

        draggingRef.current = false;

        if (relative) {
            // No real position to hold — spring the grip back to centre.
            setDragFrac(null);
            return;
        }

        sendFraction(fractionFromPointer(e.clientY));
        settleTimer.current = setTimeout(() => setDragFrac(null), DRAG_SETTLE_MS);
    };

    if (!ttydId) {
        return null;
    }

    if (!open) {
        return (
            <button
                type="button"
                className="dd-ttyd-scrollbar-notch"
                aria-label="Show scrollback scrollbar"
                onClick={() => setOpen(true)}
            >
                <ChevronLeft size={14} />
            </button>
        );
    }

    return (
        <div className="dd-ttyd-scrollbar">
            <button
                type="button"
                className="dd-ttyd-scrollbar-hide"
                aria-label="Hide scrollbar"
                onClick={() => setOpen(false)}
            >
                <ChevronRight size={12} />
            </button>
            <div
                ref={trackRef}
                className="dd-ttyd-scrollbar-track"
                role="scrollbar"
                aria-orientation="vertical"
                aria-label="Terminal scrollback"
                onPointerDown={beginDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <div
                    className={relative ? "dd-ttyd-scrollbar-thumb is-relative" : "dd-ttyd-scrollbar-thumb"}
                    style={{ top: `${thumbTop * 100}%`, height: `${thumbSize * 100}%` }}
                />
            </div>
        </div>
    );
}
