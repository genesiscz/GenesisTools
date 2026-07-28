import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { fetchHighlightMedia, fetchProfile, fetchStories } from "./api";
import { __testing as __clientTesting } from "./client";
import { InstagramError } from "./types";

const realFetch = globalThis.fetch;

beforeAll(() => {
    __clientTesting.useInstantLimiter();
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function mockJson(body: unknown, status = 200): void {
    globalThis.fetch = mock(
        async () => new Response(SafeJSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
}

describe("fetchStories", () => {
    test("refuses without a session instead of reporting an empty result", async () => {
        // The core contract. Instagram answers anonymous story requests with
        // HTTP 200 + {"reels":{}}, so "no stories" and "not authorised" are
        // indistinguishable on the wire — we must never guess the friendly one.
        const error = (await fetchStories("123", undefined).catch((err) => err)) as InstagramError;

        expect(error).toBeInstanceOf(InstagramError);
        expect(error.kind).toBe("session-required");
    });

    test("treats an empty reels map WITH a session as an expired cookie", async () => {
        mockJson({ reels: {}, status: "ok" });

        const error = (await fetchStories("123", "cookie").catch((err) => err)) as InstagramError;

        expect(error).toBeInstanceOf(InstagramError);
        expect(error.kind).toBe("session-invalid");
        expect(error.message).toContain("expired");
    });

    test("maps a populated reel into story items", async () => {
        mockJson({
            reels: {
                "123": {
                    id: 123,
                    user: { username: "someone" },
                    items: [
                        {
                            pk: "item1",
                            taken_at: 1_700_000_000,
                            expiring_at: 1_700_086_400,
                            image_versions2: {
                                candidates: [{ url: "https://cdn/img.jpg", width: 1080, height: 1920 }],
                            },
                        },
                        {
                            pk: "item2",
                            taken_at: 1_700_000_500,
                            image_versions2: {
                                candidates: [{ url: "https://cdn/poster.jpg", width: 1080, height: 1920 }],
                            },
                            video_versions: [{ url: "https://cdn/clip.mp4", width: 720, height: 1280 }],
                        },
                    ],
                },
            },
        });

        const reels = await fetchStories("123", "cookie");

        expect(reels).toHaveLength(1);
        expect(reels[0].ownerUsername).toBe("someone");
        expect(reels[0].items).toHaveLength(2);
        expect(reels[0].items[0].isVideo).toBe(false);
        expect(reels[0].items[0].mediaUrl).toBe("https://cdn/img.jpg");
        // Video items must prefer the video URL but keep the poster frame.
        expect(reels[0].items[1].isVideo).toBe(true);
        expect(reels[0].items[1].mediaUrl).toBe("https://cdn/clip.mp4");
        expect(reels[0].items[1].imageUrl).toBe("https://cdn/poster.jpg");
    });

    test("drops items that carry no media candidates rather than emitting empty urls", async () => {
        mockJson({ reels: { "123": { items: [{ pk: "broken", taken_at: 1 }] } } });

        const reels = await fetchStories("123", "cookie");

        expect(reels[0].items).toHaveLength(0);
    });
});

describe("fetchHighlightMedia", () => {
    test("prefixes bare ids with `highlight:`", async () => {
        let capturedUrl = "";
        globalThis.fetch = mock(async (url: string) => {
            capturedUrl = String(url);
            return new Response(SafeJSON.stringify({ reels: { "highlight:99": { items: [] } } }), { status: 200 });
        }) as unknown as typeof fetch;

        await fetchHighlightMedia(["99"], "cookie");

        expect(capturedUrl).toContain("highlight%3A99");
    });

    test("does not double-prefix an id that already carries one", async () => {
        let capturedUrl = "";
        globalThis.fetch = mock(async (url: string) => {
            capturedUrl = String(url);
            return new Response(SafeJSON.stringify({ reels: { "highlight:99": { items: [] } } }), { status: 200 });
        }) as unknown as typeof fetch;

        await fetchHighlightMedia(["highlight:99"], "cookie");

        expect(capturedUrl).toContain("highlight%3A99");
        expect(capturedUrl).not.toContain("highlight%3Ahighlight");
    });
});

describe("fetchProfile", () => {
    test("works anonymously and maps the fields we surface", async () => {
        mockJson({
            data: {
                user: {
                    id: "1159670881",
                    username: "someone",
                    full_name: "Some One",
                    biography: "bio",
                    is_private: false,
                    is_verified: false,
                    is_professional_account: true,
                    highlight_reel_count: 34,
                    edge_followed_by: { count: 406 },
                    edge_follow: { count: 1067 },
                    edge_owner_to_timeline_media: { count: 264 },
                    profile_pic_url: "https://cdn/pic.jpg",
                },
            },
        });

        const profile = await fetchProfile("someone");

        expect(profile.id).toBe("1159670881");
        expect(profile.followers).toBe(406);
        expect(profile.posts).toBe(264);
        expect(profile.highlightCount).toBe(34);
        expect(profile.isProfessional).toBe(true);
    });

    test("raises not-found when the payload carries no user", async () => {
        mockJson({ data: {} });

        const error = (await fetchProfile("nobody").catch((err) => err)) as InstagramError;

        expect(error.kind).toBe("not-found");
    });
});
