import { describe, expect, test } from "bun:test";
import { COMPLETENESS_NOTE, type ExportedMessage, type ThreadExport } from "../types";
import { renderMarkdown } from "./markdown";

const OBJECT_ID = "0-weu-d1-0123456789abcdef01234567";
const AMS = `https://eu-api.asm.skype.com/v1/objects/${OBJECT_ID}/views/imgo`;
const LOCAL = `/tmp/${OBJECT_ID}.png`;

function threadWith(message: Partial<ExportedMessage> & Pick<ExportedMessage, "text" | "html">): ThreadExport {
    const full: ExportedMessage = {
        id: "m1",
        sequenceId: 1,
        time: "2026-08-13T18:04:41.000Z",
        from: { mri: "8:orgid:me", displayName: "martin.foltyn@tekies.eu", email: null },
        isFromMe: true,
        messageType: "RichText/Html",
        replyToId: null,
        replyTo: null,
        reactions: [],
        mentions: [],
        links: [],
        attachments: [],
        call: null,
        system: null,
        ...message,
    };

    return {
        conversation: {
            id: "19:chat@unq.gbl.spaces",
            type: "chat",
            title: "Ada Lovelace",
            topic: null,
            members: [],
            cachedFrom: full.time,
            cachedTo: full.time,
            messageCount: 1,
            completenessNote: COMPLETENESS_NOTE,
        },
        messages: [full],
    };
}

describe("renderMarkdown", () => {
    test("renders Teams HTML structure instead of the flattened text field", () => {
        const flat =
            "A tady ještě summary\n\n\n Flow Summary \n Tým procházel Figmu.\n\n Architektura marketplace stránek \n Bannery a landing pages";
        const html = `<p>A tady ještě summary</p><h2>Flow Summary</h2><p>Tým procházel Figmu.</p><h3>Architektura marketplace stránek</h3><ul><li>Bannery a landing pages</li></ul>`;
        const md = renderMarkdown(threadWith({ text: flat, html }));
        expect(md).toContain("## Flow Summary");
        expect(md).toContain("### Architektura marketplace stránek");
        expect(md).toContain("- Bannery a landing pages");
        expect(md.includes(" Flow Summary ")).toBe(false);
    });

    test("does not emit a duplicate image when the HTML already inlined it", () => {
        const html = `<p><img src="${AMS}" itemtype="http://schema.skype.com/AMSImage" itemid="${OBJECT_ID}" alt="image" /></p>`;
        const md = renderMarkdown(
            threadWith({
                text: "",
                html,
                attachments: [
                    {
                        name: `${OBJECT_ID}.png`,
                        mimeHint: "png",
                        url: AMS,
                        itemId: OBJECT_ID,
                        localPath: LOCAL,
                    },
                ],
            })
        );
        expect(md.split(`![${OBJECT_ID}.png](${LOCAL})`).length - 1).toBe(1);
        expect(md.includes("eu-api.asm.skype.com")).toBe(false);
        expect(md.includes("_(no text)_")).toBe(false);
    });

    test("falls back to plain text when there is no html", () => {
        const md = renderMarkdown(threadWith({ text: "plain only", html: null }));
        expect(md).toContain("plain only");
    });
});
