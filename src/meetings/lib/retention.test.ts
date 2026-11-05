import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import * as removal from "@genesiscz/utils/rm";
import { Storage } from "@genesiscz/utils/storage/storage";
import { capturesToPrune, pruneCapturesDaily, trashWithRm } from "./retention";

const DAY_MS = 86_400_000;
const now = Date.parse("2026-11-03T12:00:00.000Z");
let stores = 0;

function meetingWithCaptures(store: MeetingStore, id: string, ageDays: number): void {
    const folder = store.folder(id);
    mkdirSync(join(folder, "frames"), { recursive: true });
    writeFileSync(join(folder, "frames", "f1.jpg"), "x");
    writeFileSync(join(folder, "ocr.jsonl"), "{}\n");
    writeFileSync(join(folder, "meeting.json"), "{}");
    const at = new Date(now - ageDays * DAY_MS);

    for (const path of [join(folder, "frames"), join(folder, "ocr.jsonl")]) {
        utimesSync(path, at, at);
    }
}

function fresh(): MeetingStore {
    stores += 1;
    return new MeetingStore(new Storage(`meetings-retention-${stores}`));
}

describe("capture retention", () => {
    test("only the frames and OCR of meetings past the days go, never the record or a running recording", () => {
        const store = fresh();
        meetingWithCaptures(store, "2026-09-01_10-00-old", 60);
        meetingWithCaptures(store, "2026-09-02_10-00-recording", 60);
        meetingWithCaptures(store, "2026-11-01_10-00-new", 2);

        const plans = capturesToPrune(store, { days: 30, now, skip: "2026-09-02_10-00-recording" });

        expect(plans.map((plan) => plan.meetingId)).toEqual(["2026-09-01_10-00-old"]);
        expect(plans[0]?.paths).toEqual([
            join(store.folder("2026-09-01_10-00-old"), "frames"),
            join(store.folder("2026-09-01_10-00-old"), "ocr.jsonl"),
        ]);
    });

    test("the daily pass runs once a day and hands the paths to the trash", () => {
        const store = fresh();
        meetingWithCaptures(store, "2026-09-01_10-00-old", 60);
        const trashed: string[][] = [];
        const trash = (paths: string[]) => {
            trashed.push(paths);
            return "batch-1";
        };

        expect(pruneCapturesDaily(store, { days: 30, now, trash })?.batch).toBe("batch-1");
        expect(pruneCapturesDaily(store, { days: 30, now: now + DAY_MS / 2, trash })).toBeUndefined();
        expect(pruneCapturesDaily(store, { days: 30, now: now + DAY_MS, trash })?.plans).toHaveLength(1);
        expect(trashed).toHaveLength(2);
    });
});

test("retention leaves approval-required tracked files untouched", () => {
    const move = spyOn(removal, "moveToTrash").mockImplementation(() => {
        throw new Error("must not move a tracked file");
    });

    try {
        expect(trashWithRm([import.meta.path])).toBeNull();
        expect(move).not.toHaveBeenCalled();
    } finally {
        move.mockRestore();
    }
});
