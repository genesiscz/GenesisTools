import { dirname } from "node:path";

export interface DirectoryChurn {
    directory: string;
    count: number;
    /** Fraction of all events, 0 to 1. */
    share: number;
}

export interface ChurnProfile {
    total: number;
    distinctDirectories: number;
    top: DirectoryChurn[];
}

export function compareText(a: string, b: string): number {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
}

/**
 * Counts file system events per parent directory. It keeps one counter per directory, never one record per
 * event, so a long sample of a busy volume costs memory in proportion to the directories it touched.
 */
export class DirectoryCounter {
    private readonly counts = new Map<string, number>();
    private events = 0;

    /** Count one event for the item at `eventPath`. The event belongs to the item's parent directory. */
    add(eventPath: string): void {
        const directory = dirname(eventPath);
        this.counts.set(directory, (this.counts.get(directory) ?? 0) + 1);
        this.events += 1;
    }

    get total(): number {
        return this.events;
    }

    /** The busiest `top` directories, most events first. Equal counts sort by path, so the order is stable. */
    snapshot(top: number): ChurnProfile {
        const ranked = [...this.counts.entries()].sort(
            ([dirA, countA], [dirB, countB]) => countB - countA || compareText(dirA, dirB)
        );

        return {
            total: this.events,
            distinctDirectories: this.counts.size,
            top: ranked.slice(0, Math.max(0, top)).map(([directory, count]) => ({
                directory,
                count,
                share: this.events === 0 ? 0 : count / this.events,
            })),
        };
    }
}
