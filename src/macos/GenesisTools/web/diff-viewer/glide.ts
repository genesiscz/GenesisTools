import type { CodeViewItemScrollTarget, CodeViewLineScrollTarget, CodeViewScrollTarget } from "@pierre/diffs";

export type GlideTarget = CodeViewItemScrollTarget | CodeViewLineScrollTarget;

interface GlideViewer {
    getScrollTop(): number;
    getHeight(): number;
    scrollTo(target: CodeViewScrollTarget): void;
    render(immediate?: boolean): void;
}

export interface GlideDeps {
    viewer: GlideViewer;
    log: (message: string) => void;
    setTimeout: (callback: () => void, ms: number) => number;
    clearTimeout: (id: number) => void;
}

/** How long a glide may take before the view lands on its target at once. */
export const GLIDE_SETTLE_MS = 400;

/**
 * Scrolls to a file or a line with a short glide. A far target is first reached with an instant
 * scroll that measures where it is, then the view steps back a screen and a half and glides the
 * rest: the direction shows, and a jump across 300 files costs no more than a jump across one
 * (a glide over the whole distance would lay out every file on the way).
 */
export function createGlide(deps: GlideDeps): (target: GlideTarget) => void {
    const { viewer } = deps;
    // Only the latest glide may land. A drafts-list click glides to the file and then to the card's
    // line; the file's check, still pending, would put the view back on the file's top whenever the
    // line lies between the file's top and where that glide started.
    let settle = 0;

    return function glideTo(target: GlideTarget): void {
        deps.clearTimeout(settle);
        settle = 0;
        const start = viewer.getScrollTop();
        const viewport = viewer.getHeight();
        viewer.scrollTo({ ...target, behavior: "instant" });
        viewer.render(true);
        const destination = viewer.getScrollTop();
        const distance = destination - start;

        if (Math.abs(distance) < 1) {
            return;
        }

        const lead = Math.min(Math.abs(distance), viewport * 1.5);
        viewer.scrollTo({ type: "position", position: destination - Math.sign(distance) * lead, behavior: "instant" });
        viewer.render(true);
        const leadTop = viewer.getScrollTop();
        viewer.scrollTo({ ...target, behavior: "smooth" });
        // A window WebKit does not paint (a snapshot's, one behind other windows) runs few or no
        // animation frames, so the glide stalls on its way and the view stayed short of the line (an
        // Activity "Open in the diff" snapshot: lines 122-171 for a thread on 218; a log: 0→2986 stopped
        // at 2022). Still on the glide's path after its time: land at once. A view the user scrolled
        // elsewhere meanwhile is left alone.
        const low = Math.min(leadTop, destination) - 1;
        const high = Math.max(leadTop, destination) + 1;
        settle = deps.setTimeout(() => {
            settle = 0;
            const now = viewer.getScrollTop();

            if (Math.abs(now - destination) >= 1 && now >= low && now <= high) {
                deps.log(`glide stalled at ${Math.round(now)} of ${Math.round(destination)}: landed at once`);
                viewer.scrollTo({ ...target, behavior: "instant" });
                viewer.render(true);
            }
        }, GLIDE_SETTLE_MS);
    };
}
