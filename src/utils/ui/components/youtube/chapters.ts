/**
 * Index of the chapter containing playback second `t`, using the shared rule
 * `startSec <= t < next.startSec` (last chapter is open-ended). `startSecs`
 * must be ascending. Returns null before the first chapter or when empty.
 */
export function activeChapterIndex(startSecs: number[], t: number): number | null {
    let active: number | null = null;

    for (let index = 0; index < startSecs.length; index++) {
        if (startSecs[index] <= t) {
            active = index;
        } else {
            break;
        }
    }

    return active;
}
