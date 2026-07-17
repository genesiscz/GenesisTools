import { logger } from "@app/logger/client";
import { activeChapterIndex } from "@app/utils/ui/components/youtube/chapters";

export interface ChapterTick {
    title: string;
    startSec: number;
}

export interface MountChapterTicksOpts {
    chapters: ChapterTick[];
    duration: number;
    /** YouTube's `.ytp-progress-bar` element (page DOM). */
    container: HTMLElement;
    /** Invoked with the chapter's startSec when a tick is clicked. */
    onSeek?: (sec: number) => void;
}

export interface ChapterTicksHandle {
    unmount(): void;
    /** Highlights the tick of the chapter containing playback second `t`. */
    setCurrentTime(t: number): void;
}

const STYLE_ID = "gt-chapter-styles";

// Accent = the panel's --primary token (38 92% 58% in side-panel.css) as hex.
const ACCENT_HEX = "#f6ae31";

const CHAPTER_STYLES = `
.gt-chapter-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 60;
}
.gt-chapter-tick {
    position: absolute;
    top: -4px;
    bottom: 0;
    width: 8px;
    margin-left: -4px;
    border: 0;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-radius: 1px;
    padding: 0;
    font: inherit;
    background: rgba(255, 255, 255, 0.85);
    background-clip: padding-box;
    pointer-events: auto;
    cursor: pointer;
    transition: background 150ms, top 150ms;
}
.gt-chapter-tick--active {
    top: -6px;
    background: ${ACCENT_HEX};
    background-clip: padding-box;
}
.gt-chapter-tick:focus-visible {
    outline: 2px solid ${ACCENT_HEX};
    outline-offset: 2px;
}
.gt-chapter-tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 15, 15, 0.95);
    padding: 4px 8px;
    border-radius: 6px;
    font: 500 12px/1.3 system-ui, sans-serif;
    color: #fff;
    white-space: nowrap;
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    opacity: 0;
    transition: opacity 150ms;
}
.gt-chapter-tick:hover .gt-chapter-tooltip {
    opacity: 1;
}
`;

/**
 * Percentage position of a tick on the progress bar, or null when the tick
 * must be dropped (invalid duration, startSec < 0 or > duration).
 */
export function tickPositionPct(startSec: number, duration: number): number | null {
    if (!Number.isFinite(startSec) || !Number.isFinite(duration) || duration <= 0) {
        return null;
    }

    if (startSec < 0 || startSec > duration) {
        return null;
    }

    return (startSec / duration) * 100;
}

function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CHAPTER_STYLES;
    document.head.appendChild(style);
}

function formatMmSs(seconds: number): string {
    const safe = Math.max(0, Math.floor(seconds));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function mountChapterTicks(opts: MountChapterTicksOpts): ChapterTicksHandle {
    const { chapters, duration, container, onSeek } = opts;
    ensureStyles();

    const overlay = document.createElement("div");
    overlay.className = "gt-chapter-overlay";
    const sorted = [...chapters].sort((a, b) => a.startSec - b.startSec);
    const mounted: Array<{ el: HTMLElement; startSec: number }> = [];

    for (const chapter of sorted) {
        const pct = tickPositionPct(chapter.startSec, duration);

        if (pct === null) {
            logger.debug({ startSec: chapter.startSec, duration }, "player-chapters: dropping tick outside duration");
            continue;
        }

        const tick = document.createElement(onSeek ? "button" : "div");
        tick.className = "gt-chapter-tick";
        tick.style.left = `${pct}%`;

        if (onSeek) {
            (tick as HTMLButtonElement).type = "button";
            tick.setAttribute("aria-label", `${formatMmSs(chapter.startSec)} · ${chapter.title}`);
        }

        const tooltip = document.createElement("div");
        tooltip.className = "gt-chapter-tooltip";
        tooltip.textContent = `${formatMmSs(chapter.startSec)} · ${chapter.title}`;
        tick.appendChild(tooltip);

        if (onSeek) {
            tick.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                onSeek(chapter.startSec);
            });
        }

        overlay.appendChild(tick);
        mounted.push({ el: tick, startSec: chapter.startSec });
    }

    container.appendChild(overlay);
    const startSecs = mounted.map((tick) => tick.startSec);

    return {
        unmount(): void {
            overlay.remove();
        },
        setCurrentTime(t: number): void {
            const active = activeChapterIndex(startSecs, t);

            for (let index = 0; index < mounted.length; index++) {
                mounted[index].el.classList.toggle("gt-chapter-tick--active", index === active);
            }
        },
    };
}
