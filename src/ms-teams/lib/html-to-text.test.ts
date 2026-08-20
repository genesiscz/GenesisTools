import { describe, expect, test } from "bun:test";
import { htmlToText } from "./html-to-text";

describe("htmlToText", () => {
    test("strips tags and keeps emoji alt text", () => {
        const html =
            '<p>hello, I will look at it today <span title="grin"><img alt="😄" itemtype="http://schema.skype.com/Emoji" /></span></p>';
        expect(htmlToText(html).text).toContain("hello, I will look at it today");
        expect(htmlToText(html).text).toContain("😄");
    });

    test("drops generic AMS image alt text", () => {
        const html =
            '<p><img src="https://eu-api.asm.skype.com/v1/objects/0-weu-d1-aa/views/imgo" itemtype="http://schema.skype.com/AMSImage" alt="image" /></p>';
        expect(htmlToText(html).text).toBe("");
    });

    test("extracts a skype reply itemid and drops the quote body", () => {
        const html =
            '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="m-parent"><p>parent</p></blockquote><p>child reply</p>';
        const got = htmlToText(html);
        expect(got.replyToId).toBe("m-parent");
        expect(got.text).toBe("child reply");
        expect(got.text.includes("parent")).toBe(false);
    });
});
