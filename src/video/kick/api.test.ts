import { describe, expect, it } from "bun:test";
import { parseKickTarget } from "./api";

const CLIP = "clip_01M7RY9637GFHTX1SEQE9EWJ88";

describe("parseKickTarget", () => {
    it("reads a clip from its page URL, its query form and its bare id", () => {
        expect(parseKickTarget(`https://kick.com/somechannel/clips/${CLIP}`)).toEqual({ kind: "clip", id: CLIP });
        expect(parseKickTarget(`https://kick.com/somechannel?clip=${CLIP}`)).toEqual({ kind: "clip", id: CLIP });
        expect(parseKickTarget(CLIP.toLowerCase())).toEqual({ kind: "clip", id: CLIP });
    });

    it("reads a clips page with the page's own sort and range", () => {
        expect(parseKickTarget("https://kick.com/SomeChannel/clips?sort=date&range=day")).toEqual({
            kind: "channel",
            channel: "somechannel",
            sort: "date",
            range: "day",
        });
    });

    it("reads a channel page and a bare slug, and ignores unknown filter values", () => {
        expect(parseKickTarget("kick.com/somechannel?sort=hot")).toEqual({ kind: "channel", channel: "somechannel" });
        expect(parseKickTarget("some_channel")).toEqual({ kind: "channel", channel: "some_channel" });
    });

    it("refuses another site and a kick.com path that names no channel", () => {
        expect(() => parseKickTarget("https://example.com/somechannel/clips")).toThrow("not a kick.com URL");
        expect(() => parseKickTarget("https://kick.com/categories/games")).toThrow("names no Kick channel");
    });
});
