interface SegmentInput {
    from_date_unix: number;
    to_date_unix: number;
}

interface SyncRange {
    from: number;
    to: number;
}

export class SyncRangePlanner {
    static plan(segments: SegmentInput[], queryFrom: number, queryTo: number): SyncRange[] {
        if (queryFrom > queryTo) {
            throw new RangeError("queryFrom must be <= queryTo");
        }

        if (segments.length === 0) {
            return [{ from: queryFrom, to: queryTo }];
        }

        const sorted = [...segments].sort((a, b) => a.from_date_unix - b.from_date_unix);
        const merged: SyncRange[] = [];

        let current = { from: sorted[0].from_date_unix, to: sorted[0].to_date_unix };

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].from_date_unix <= current.to) {
                current.to = Math.max(current.to, sorted[i].to_date_unix);
            } else {
                merged.push(current);
                current = { from: sorted[i].from_date_unix, to: sorted[i].to_date_unix };
            }
        }

        merged.push(current);

        const gaps: SyncRange[] = [];
        const clipped = merged.filter((s) => s.to > queryFrom && s.from < queryTo);

        if (clipped.length === 0) {
            return [{ from: queryFrom, to: queryTo }];
        }

        if (clipped[0].from > queryFrom) {
            gaps.push({ from: queryFrom, to: clipped[0].from });
        }

        for (let i = 0; i < clipped.length - 1; i++) {
            if (clipped[i + 1].from > clipped[i].to) {
                gaps.push({ from: clipped[i].to, to: clipped[i + 1].from });
            }
        }

        if (clipped[clipped.length - 1].to < queryTo) {
            gaps.push({ from: clipped[clipped.length - 1].to, to: queryTo });
        }

        return gaps;
    }
}
