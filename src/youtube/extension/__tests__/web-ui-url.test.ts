import { describe, expect, it } from "bun:test";
import { YOUTUBE_WEB_UI_PORT, youtubeChannelWebUrl, youtubeWebUiBaseUrl } from "@ext/shared/web-ui-url";

describe("youtubeWebUiBaseUrl", () => {
    it("maps localhost API to the YouTube web UI port", () => {
        expect(youtubeWebUiBaseUrl("http://localhost:9876")).toBe(`http://localhost:${YOUTUBE_WEB_UI_PORT}`);
        expect(youtubeWebUiBaseUrl("http://127.0.0.1:9876/")).toBe(`http://127.0.0.1:${YOUTUBE_WEB_UI_PORT}`);
    });

    it("keeps remote API origin + path prefix", () => {
        expect(youtubeWebUiBaseUrl("https://vps.example.com/yt")).toBe("https://vps.example.com/yt");
    });

    it("builds a channel deep-link for the web UI", () => {
        expect(youtubeChannelWebUrl("http://localhost:9876", "@opat04")).toBe(
            `http://localhost:${YOUTUBE_WEB_UI_PORT}/channels/%40opat04`
        );
    });
});
