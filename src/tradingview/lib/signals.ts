import type { PinePlot, SignalEvent, StudyPoint } from "./types";

const SHAPE_TYPES = new Set(["shapes", "chars", "arrows"]);

export class SignalDetector {
    private readonly shapeIndexes: Array<{ valueIndex: number; plot: PinePlot }>;
    private readonly seen = new Set<string>();
    private live = false;

    constructor(plots: PinePlot[]) {
        this.shapeIndexes = plots
            .map((plot, valueIndex) => ({ valueIndex, plot }))
            .filter(({ plot }) => SHAPE_TYPES.has(plot.type));
    }

    /** Call when the initial snapshot is complete; subsequent marks are "live". */
    markLive(): void {
        this.live = true;
    }

    hasShapePlots(): boolean {
        return this.shapeIndexes.length > 0;
    }

    ingest(points: StudyPoint[]): SignalEvent[] {
        const events: SignalEvent[] = [];
        for (const point of points) {
            for (const { valueIndex, plot } of this.shapeIndexes) {
                const value = point.values[valueIndex];
                if (value === null || value === undefined) {
                    continue;
                }

                const key = `${plot.id}@${point.barIndex}`;
                if (this.seen.has(key)) {
                    continue;
                }

                this.seen.add(key);
                events.push({
                    time: point.time,
                    barIndex: point.barIndex,
                    plotId: plot.id,
                    plotTitle: plot.title,
                    value,
                    kind: this.live ? "live" : "history",
                });
            }
        }

        return events;
    }
}