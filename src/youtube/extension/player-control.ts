/**
 * Player control for the first-party watch page.
 *
 * The panel used to drive the player with the IFrame Player API message
 * (`{event:"command", func:"seekTo"}`). That protocol only works when you post
 * it to an *embedded* player's contentWindow — which is right for the dashboard,
 * where the video really is in an iframe. On youtube.com itself nothing listens
 * for it, so every timestamp pill and chapter row silently did nothing.
 *
 * A content script shares the page's DOM (only the JS world is isolated), so
 * the `<video>` element and its properties are directly reachable.
 */

export function findPlayerVideo(): HTMLVideoElement | null {
    return (
        document.querySelector<HTMLVideoElement>("#movie_player video") ??
        document.querySelector<HTMLVideoElement>("video")
    );
}

/**
 * Where a seek to `seconds` lands on a video of `duration`. Split out of
 * `seekPlayerTo` so the clamping rules are pinned without a DOM, the same way
 * `player-chapters` exports `tickPositionPct`.
 *
 * @returns The target clamped into `[0, duration]`, uncapped when `duration` is
 * non-finite (live stream, or a video that hasn't loaded its metadata), or null
 * when `seconds` itself is non-finite — assigning that to `currentTime` throws.
 */
export function seekTargetFor(seconds: number, duration: number): number | null {
    if (!Number.isFinite(seconds)) {
        return null;
    }

    const target = Math.max(0, seconds);

    // Live streams report Infinity and a not-yet-loaded video reports NaN — in both
    // cases there is no end to clamp against, so only a finite duration caps the seek.
    return Number.isFinite(duration) ? Math.min(target, duration) : target;
}

/** Returns false when the player isn't on the page yet, so callers can log it. */
export function seekPlayerTo(seconds: number): boolean {
    const video = findPlayerVideo();

    if (!video) {
        return false;
    }

    const target = seekTargetFor(seconds, video.duration);

    if (target === null) {
        return false;
    }

    video.currentTime = target;

    return true;
}

export function pausePlayer(): boolean {
    const video = findPlayerVideo();

    if (!video) {
        return false;
    }

    video.pause();
    return true;
}
