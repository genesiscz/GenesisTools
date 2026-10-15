import { describe, expect, test } from "bun:test";
import {
    findInTranscript,
    pressesToOldest,
    searchCount,
    TRANSCRIPT_BANNER,
    type TranscriptIO,
} from "./transcript-find";

const PROMPT = "some reply\n────\n❯ \n────\n  ⏵⏵ auto mode on";
const BANNER = `some reply\n────\n  ${TRANSCRIPT_BANNER} · ctrl+o to toggle · ? for shortcuts      verbose`;

/** A fake Claude Code screen: ctrl+o opens the transcript, `/` the search bar, Enter shows `hit`. */
function fakeClaude({ opens = true, hit }: { opens?: boolean; hit: string }) {
    const typed: string[] = [];
    let screen = PROMPT;
    let query = "";
    let current = 0;

    const io: TranscriptIO = {
        screen: async () => screen,
        key: async (name) => {
            typed.push(`key:${name}`);

            if (name === "ctrl+o") {
                screen = screen === PROMPT ? (opens ? BANNER : PROMPT) : PROMPT;
            }

            if (name === "enter" && screen.endsWith(`/${query}`)) {
                screen = `${BANNER.split("\n  ")[0]}\n  ${hit}`;
                current = Number(hit.match(/(\d+)\/\d+$/)?.[1] ?? 0);
            }
        },
        text: async (value) => {
            typed.push(value);

            if (value === "/" && screen === BANNER) {
                screen = `${BANNER.split("\n  ")[0]}\n  /`;
            } else if (screen.endsWith("/")) {
                query = value;
                screen = `${screen}${value}`;
            } else if (value === "n") {
                const total = Number(hit.match(/\/(\d+)$/)?.[1] ?? 0);
                current = (current % total) + 1;
            }
        },
        sleep: async () => {},
    };

    return { io, typed, current: () => current };
}

describe("transcript find", () => {
    test("reads the match counter and the no-match marker from the bottom line", () => {
        expect(searchCount("x\n  /DECISION 2                    no matches  ")).toBe("none");
        expect(searchCount("x\n  ctrl+o to toggle · n/N to navigate     3/4  ")).toEqual({ current: 3, total: 4 });
        expect(searchCount(BANNER)).toBeNull();
    });

    test("n wraps from the newest match to the first", () => {
        expect(pressesToOldest({ current: 4, total: 4 })).toBe(1);
        expect(pressesToOldest({ current: 2, total: 4 })).toBe(3);
        expect(pressesToOldest({ current: 1, total: 4 })).toBe(0);
    });

    test("lands on the oldest match", async () => {
        const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate   4/4" });
        const outcome = await findInTranscript(claude.io, { query: "DECISION 7", oldest: true, timeoutMs: 0 });

        expect(outcome).toEqual({ found: true, current: 1, total: 4 });
        expect(claude.current()).toBe(1);
        expect(claude.typed).toEqual(["key:ctrl+o", "/", "DECISION 7", "key:enter", "n"]);
    });

    test("types nothing after ctrl+o when the transcript view does not open", async () => {
        const claude = fakeClaude({ opens: false, hit: "1/1" });
        const outcome = await findInTranscript(claude.io, { query: "DECISION 7", oldest: true, timeoutMs: 0 });

        expect(outcome).toEqual({ found: false, reason: "no-transcript" });
        expect(claude.typed).toEqual(["key:ctrl+o"]);
    });

    test("a miss closes the transcript view it opened", async () => {
        const claude = fakeClaude({ hit: `${TRANSCRIPT_BANNER} · ctrl+o to toggle      verbose` });
        const outcome = await findInTranscript(claude.io, { query: "nothing", oldest: true, timeoutMs: 0 });

        expect(outcome).toEqual({ found: false, reason: "no-match" });
        expect(claude.typed.at(-1)).toBe("key:ctrl+o");
    });
});
