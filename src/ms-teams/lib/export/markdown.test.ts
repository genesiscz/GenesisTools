import { describe, expect, test } from "bun:test";
import { COMPLETENESS_NOTE, type ExportedMessage, type ThreadExport } from "../types";
import { renderMarkdown } from "./markdown";

const OBJECT_ID = "0-weu-d1-0123456789abcdef01234567";
const AMS = `https://eu-api.asm.skype.com/v1/objects/${OBJECT_ID}/views/imgo`;
const LOCAL = `/tmp/${OBJECT_ID}.png`;

const ME = { mri: "8:orgid:me", displayName: "alice@example.com", email: null };

function threadWith(message: Partial<ExportedMessage> & Pick<ExportedMessage, "text" | "html">): ThreadExport {
    return threadWithMessages([message]);
}

function threadWithMessages(
    messages: Array<Partial<ExportedMessage> & Pick<ExportedMessage, "text" | "html">>
): ThreadExport {
    const full = messages.map((message, index) => ({
        id: `m${index + 1}`,
        sequenceId: index + 1,
        time: "2026-08-13T18:04:41.000Z",
        from: ME,
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
    }));
    const first = full[0];
    const last = full[full.length - 1];

    return {
        conversation: {
            id: "19:chat@unq.gbl.spaces",
            type: "chat",
            title: "Ada Lovelace",
            topic: null,
            members: [],
            cachedFrom: first?.time ?? null,
            cachedTo: last?.time ?? null,
            messageCount: full.length,
            completenessNote: COMPLETENESS_NOTE,
        },
        messages: full,
    };
}

function speakerHeadings(md: string, who: string): string[] {
    return md.split("\n").filter((line) => /^#{1,6} /.test(line) && line.includes(` · ${who}`));
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
        expect(md.split(`<img src="${LOCAL}"`).length - 1).toBe(1);
        expect(md).toContain(`style="max-width: min(100%, 480px); height: auto;"`);
        expect(md.includes(`![${OBJECT_ID}.png](${LOCAL})`)).toBe(false);
        expect(md.includes("eu-api.asm.skype.com")).toBe(false);
        expect(md.includes("_(no text)_")).toBe(false);
    });

    test("caps a follow-up attachment image to a normal size instead of full width", () => {
        const md = renderMarkdown(
            threadWith({
                text: "",
                html: null,
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

        expect(md).toContain(
            `<img src="${LOCAL}" alt="${OBJECT_ID}.png" style="max-width: min(100%, 480px); height: auto;" />`
        );
        expect(md.includes(`![${OBJECT_ID}.png](${LOCAL})`)).toBe(false);
    });

    test("does not relist a remote inline image that has no localPath or itemId", () => {
        // A non-AMS image: the body carries it by URL alone, so the
        // attachment list would otherwise emit it a second time.
        const remote = "https://cdn.example.com/diagram.png";
        const md = renderMarkdown(
            threadWith({
                text: "",
                html: `<p><img src="${remote}" alt="diagram" /></p>`,
                attachments: [{ name: "diagram.png", mimeHint: "png", url: remote, itemId: null, localPath: null }],
            })
        );

        expect(md.split(remote).length - 1).toBe(1);
    });

    test("falls back to plain text when there is no html", () => {
        const md = renderMarkdown(threadWith({ text: "plain only", html: null }));
        expect(md).toContain("plain only");
    });

    // Regression test: consecutive same-speaker bursts were each given a ## time · name heading.
    test("omits the speaker heading on a follow-up from the same person within an hour", () => {
        const md = renderMarkdown(
            threadWithMessages([
                { text: "first ping", html: null, time: "2026-08-13T18:04:41.000Z" },
                { text: "second ping", html: null, time: "2026-08-13T18:09:41.000Z" },
            ])
        );

        expect(speakerHeadings(md, "alice@example.com (me)")).toHaveLength(1);
        expect(md).toContain("first ping");
        expect(md).toContain("second ping");
    });

    test("omits the speaker heading when the same-person gap is 59 minutes", () => {
        const md = renderMarkdown(
            threadWithMessages([
                { text: "before the hour", html: null, time: "2026-08-13T18:04:41.000Z" },
                { text: "still the same burst", html: null, time: "2026-08-13T19:03:41.000Z" },
            ])
        );

        expect(speakerHeadings(md, "alice@example.com (me)")).toHaveLength(1);
        expect(md).toContain("before the hour");
        expect(md).toContain("still the same burst");
    });

    test("keeps the speaker heading when the same-person gap is an hour", () => {
        const md = renderMarkdown(
            threadWithMessages([
                { text: "first hour", html: null, time: "2026-08-13T18:04:41.000Z" },
                { text: "next hour", html: null, time: "2026-08-13T19:04:41.000Z" },
            ])
        );

        expect(speakerHeadings(md, "alice@example.com (me)")).toHaveLength(2);
        expect(md).toContain("first hour");
        expect(md).toContain("next hour");
    });

    test("keeps the speaker heading after someone else spoke", () => {
        const ada = { mri: "8:orgid:ada", displayName: "Ada Lovelace", email: null };
        const md = renderMarkdown(
            threadWithMessages([
                { text: "mine first", html: null, time: "2026-08-13T18:04:41.000Z" },
                { text: "ada reply", html: null, time: "2026-08-13T18:05:41.000Z", from: ada, isFromMe: false },
                { text: "mine again", html: null, time: "2026-08-13T18:06:41.000Z" },
            ])
        );

        expect(speakerHeadings(md, "alice@example.com (me)")).toHaveLength(2);
        expect(speakerHeadings(md, "Ada Lovelace")).toHaveLength(1);
        expect(md).toContain("mine first");
        expect(md).toContain("ada reply");
        expect(md).toContain("mine again");
    });

    test("omits the speaker heading on another person's follow-up within an hour", () => {
        const ada = { mri: "8:orgid:ada", displayName: "Ada Lovelace", email: null };
        const md = renderMarkdown(
            threadWithMessages([
                { text: "ada first", html: null, time: "2026-08-13T18:04:41.000Z", from: ada, isFromMe: false },
                { text: "ada second", html: null, time: "2026-08-13T18:06:41.000Z", from: ada, isFromMe: false },
            ])
        );

        expect(speakerHeadings(md, "Ada Lovelace")).toHaveLength(1);
        expect(md).toContain("ada first");
        expect(md).toContain("ada second");
    });
});
