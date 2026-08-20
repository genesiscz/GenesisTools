import { describe, expect, test } from "bun:test";
import { htmlToText } from "./html-to-text";

describe("htmlToText", () => {
    test("strips tags and keeps emoji alt text", () => {
        const html =
            '<p>cau, kouknu na to dneska <span title="grin"><img alt="😄" itemtype="http://schema.skype.com/Emoji" /></span></p>';
        expect(htmlToText(html).text).toContain("cau, kouknu na to dneska");
        expect(htmlToText(html).text).toContain("😄");
    });

    test("extracts a skype reply itemid and drops the quote body", () => {
        const html =
            '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1780916204854"><p>parent</p></blockquote><p>child reply</p>';
        const got = htmlToText(html);
        expect(got.replyToId).toBe("1780916204854");
        expect(got.text).toBe("child reply");
        expect(got.text.includes("parent")).toBe(false);
    });
});
