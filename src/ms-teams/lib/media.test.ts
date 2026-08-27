import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdown } from "./export/markdown";
import { materializeThreadMedia } from "./media";
import { COMPLETENESS_NOTE, type ExportedMessage, type ThreadExport } from "./types";

const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300000002000100e5ef27d20000000049454e44ae426082",
    "hex"
);

const OBJECT_ID = "0-weu-d1-0123456789abcdef01234567";

function threadWithImage(): ThreadExport {
    const message: ExportedMessage = {
        id: "m1",
        sequenceId: 1,
        time: "2026-08-06T10:21:00.000Z",
        from: { mri: "8:orgid:me", displayName: "Me", email: "me@example.test" },
        isFromMe: true,
        messageType: "RichText/Html",
        text: "image",
        html: `<p><img src="https://eu-api.asm.skype.com/v1/objects/${OBJECT_ID}/views/imgo" itemtype="http://schema.skype.com/AMSImage" itemid="${OBJECT_ID}" alt="image" /></p>`,
        replyToId: null,
        replyTo: null,
        reactions: [],
        mentions: [],
        links: [],
        attachments: [
            {
                name: "image",
                mimeHint: "png",
                url: `https://eu-api.asm.skype.com/v1/objects/${OBJECT_ID}/views/imgo`,
                itemId: OBJECT_ID,
                localPath: null,
            },
        ],
        call: null,
        system: null,
    };

    return {
        conversation: {
            id: "19:chat@unq.gbl.spaces",
            type: "chat",
            title: "Ada Lovelace",
            topic: null,
            members: [],
            cachedFrom: message.time,
            cachedTo: message.time,
            messageCount: 1,
            completenessNote: COMPLETENESS_NOTE,
        },
        messages: [message],
    };
}

describe("materializeThreadMedia", () => {
    test("extracts a PNG from a fake disk cache and embeds it in markdown", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "ms-teams-cache-"));
        const destDir = mkdtempSync(join(tmpdir(), "ms-teams-media-"));
        const header = Buffer.from(
            `1/0/_dk_https://microsoft.com https://eu-api.asm.skype.com/v1/objects/${OBJECT_ID}/views/imgpsh_fullsize?v=1`
        );
        writeFileSync(join(cacheDir, "full_0"), Buffer.concat([header, PNG]));
        const got = await materializeThreadMedia(threadWithImage(), { cacheDir, destDir });
        const attachment = got.messages[0]?.attachments[0];
        expect(attachment?.localPath).toBe(join(destDir, `${OBJECT_ID}.png`));
        expect(readFileSync(attachment?.localPath ?? "")).toEqual(PNG);
        expect(got.messages[0]?.text).toBe("");
        const md = renderMarkdown(got);
        expect(md).toContain(
            `<img src="${attachment?.localPath}" alt="${OBJECT_ID}.png" style="max-width: min(100%, 480px); height: auto;" />`
        );
        expect(md.includes(`![${OBJECT_ID}.png](${attachment?.localPath})`)).toBe(false);
        expect(md.includes("_(no text)_")).toBe(false);
        expect(md.includes("eu-api.asm.skype.com")).toBe(false);
    });

    test("reuses a file already in destDir without a cache hit", async () => {
        const destDir = mkdtempSync(join(tmpdir(), "ms-teams-media-"));
        const dest = join(destDir, `${OBJECT_ID}.png`);
        writeFileSync(dest, PNG);
        const got = await materializeThreadMedia(threadWithImage(), {
            cacheDir: join(destDir, "missing-cache"),
            destDir,
        });
        expect(got.messages[0]?.attachments[0]?.localPath).toBe(dest);
    });
});
