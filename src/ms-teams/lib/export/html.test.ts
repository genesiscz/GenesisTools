import { describe, expect, test } from "bun:test";
import { COMPLETENESS_NOTE, type ThreadExport } from "../types";
import { renderHtml, rewriteLocalMediaHtml, sanitizeHtml } from "./html";

const OBJECT_ID = "0-weu-d1-0123456789abcdef01234567";
const AMS = `https://eu-api.asm.skype.com/v1/objects/${OBJECT_ID}/views/imgo`;
const LOCAL = `/tmp/${OBJECT_ID}.png`;

describe("sanitizeHtml", () => {
    test("drops iframe and entity-obfuscated javascript hrefs", () => {
        const dirty =
            '<p><a href="java&#x73;cript:alert(1)">x</a></p><iframe src="data:text/html,<script>alert(1)</script>"></iframe><p><a href="https://example.test/ok">ok</a></p>';
        const got = sanitizeHtml(dirty);
        expect(got.includes("iframe")).toBe(false);
        expect(got.toLowerCase().includes("javascript")).toBe(false);
        expect(got.includes("https://example.test/ok")).toBe(true);
    });
});

describe("rewriteLocalMediaHtml", () => {
    test("swaps the AMS src for a file URL", () => {
        const html = `<p><img src="${AMS}" itemid="${OBJECT_ID}" /></p>`;
        const got = rewriteLocalMediaHtml(html, [
            {
                name: "image",
                mimeHint: "png",
                url: AMS,
                itemId: OBJECT_ID,
                localPath: LOCAL,
            },
        ]);
        expect(got.includes("file://")).toBe(true);
        expect(got.includes(LOCAL)).toBe(true);
        expect(got.includes("eu-api.asm.skype.com")).toBe(false);
    });
});

describe("renderHtml", () => {
    test("does not emit a duplicate attachment img when the body already shows it", () => {
        const thread: ThreadExport = {
            conversation: {
                id: "19:chat@unq.gbl.spaces",
                type: "chat",
                title: "Ada Lovelace",
                topic: null,
                members: [],
                cachedFrom: null,
                cachedTo: null,
                messageCount: 1,
                completenessNote: COMPLETENESS_NOTE,
            },
            messages: [
                {
                    id: "m1",
                    sequenceId: 1,
                    time: "2026-08-06T10:21:00.000Z",
                    from: { mri: "8:orgid:me", displayName: "Me", email: null },
                    isFromMe: true,
                    messageType: "RichText/Html",
                    text: "",
                    html: `<p><img src="${AMS}" itemid="${OBJECT_ID}" alt="image" /></p>`,
                    replyToId: null,
                    replyTo: null,
                    reactions: [],
                    mentions: [],
                    links: [],
                    attachments: [
                        {
                            name: `${OBJECT_ID}.png`,
                            mimeHint: "png",
                            url: AMS,
                            itemId: OBJECT_ID,
                            localPath: LOCAL,
                        },
                    ],
                    call: null,
                    system: null,
                },
            ],
        };
        const html = renderHtml(thread);
        expect(html.includes("file://")).toBe(true);
        expect(html.includes("eu-api.asm.skype.com")).toBe(false);
        expect(html.split("<img").length - 1).toBe(1);
    });
});
