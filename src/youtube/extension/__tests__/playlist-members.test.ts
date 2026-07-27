import { describe, expect, it } from "bun:test";
import { playlistVideoIdsFromHrefs, sameIds } from "@ext/playlist-members";

const LIST = "PLjRFDDC_0VxgKQcBmF-DRwkGItt8xl_2F";

describe("playlistVideoIdsFromHrefs", () => {
    it("reads members from modern lockup hrefs", () => {
        // The regression: detection queried ytd-playlist-video-renderer, but
        // YouTube now renders playlist rows as yt-lockup-view-model, so the
        // panel reported "0 videos detected" no matter how far you scrolled.
        const hrefs = [
            `/watch?v=tKzj-NaJoIc&list=${LIST}&index=1&pp=iAQB`,
            `/watch?v=uFWrYzUX_wc&list=${LIST}&index=2&pp=iAQB`,
            `/watch?v=EY8XjnATOU8&list=${LIST}&index=3&pp=iAQB`,
        ];

        expect(playlistVideoIdsFromHrefs(hrefs, LIST, 20)).toEqual(["tKzj-NaJoIc", "uFWrYzUX_wc", "EY8XjnATOU8"]);
    });

    it("ignores links belonging to a different playlist", () => {
        const hrefs = [`/watch?v=keep0000001&list=${LIST}&index=1`, "/watch?v=drop0000001&list=PLotherlist&index=1"];

        expect(playlistVideoIdsFromHrefs(hrefs, LIST, 20)).toEqual(["keep0000001"]);
    });

    it("skips the play-all link, which carries a list but no video", () => {
        const hrefs = [`/playlist?list=${LIST}`, `/watch?v=vid00000001&list=${LIST}`];

        expect(playlistVideoIdsFromHrefs(hrefs, LIST, 20)).toEqual(["vid00000001"]);
    });

    it("dedupes the thumbnail and title anchors of one row", () => {
        const hrefs = [`/watch?v=vid00000001&list=${LIST}&index=1`, `/watch?v=vid00000001&list=${LIST}&index=1`];

        expect(playlistVideoIdsFromHrefs(hrefs, LIST, 20)).toEqual(["vid00000001"]);
    });

    it("stops at the report cap", () => {
        const hrefs = Array.from({ length: 40 }, (_, i) => `/watch?v=vid${String(i).padStart(8, "0")}&list=${LIST}`);

        expect(playlistVideoIdsFromHrefs(hrefs, LIST, 20)).toHaveLength(20);
    });

    it("survives a malformed href instead of throwing", () => {
        const hrefs = ["::::not a url", `/watch?v=vid00000001&list=${LIST}`];

        expect(playlistVideoIdsFromHrefs(hrefs, LIST, 20)).toEqual(["vid00000001"]);
    });
});

describe("sameIds", () => {
    it("keeps the previous array identity when nothing changed", () => {
        expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    });

    it("detects appended and reordered members", () => {
        expect(sameIds(["a"], ["a", "b"])).toBe(false);
        expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
    });
});
