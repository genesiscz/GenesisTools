import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAttachments, isAllowedAttachmentUrl, parseAttachments } from "./attachments";

const AMS_HTML =
    '<p><img src="https://eu-api.asm.skype.com/v1/objects/0-weu-d1-0123456789abcdef01234567/views/imgo" itemtype="http://schema.skype.com/AMSImage" itemscope="png" width="784" height="250" alt="image" id="x_0-weu-d1-0123456789abcdef01234567" itemid="0-weu-d1-0123456789abcdef01234567" /></p>';

describe("parseAttachments", () => {
    test("reads AMS object id from an img tag regardless of attribute order", () => {
        const got = parseAttachments({}, AMS_HTML);
        expect(got).toHaveLength(1);
        expect(got[0]?.itemId).toBe("0-weu-d1-0123456789abcdef01234567");
        expect(got[0]?.url).toContain("/objects/0-weu-d1-0123456789abcdef01234567/views/imgo");
        expect(got[0]?.mimeHint).toBe("png");
    });
});

describe("isAllowedAttachmentUrl", () => {
    test("allows Teams and Skype HTTPS hosts", () => {
        expect(isAllowedAttachmentUrl("https://eu-api.asm.skype.com/v1/objects/x/views/imgo")).toBe(true);
        expect(isAllowedAttachmentUrl("https://contoso.sharepoint.com/sites/a/file.docx")).toBe(true);
    });

    test("rejects loopback, private, and non-HTTPS URLs", () => {
        expect(isAllowedAttachmentUrl("http://127.0.0.1/secret")).toBe(false);
        expect(isAllowedAttachmentUrl("https://127.0.0.1/secret")).toBe(false);
        expect(isAllowedAttachmentUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
        expect(isAllowedAttachmentUrl("https://example.test/shot.png")).toBe(false);
    });
});

describe("downloadAttachments", () => {
    test("does not fetch when localPath already exists", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ms-teams-dl-"));
        const dest = join(dir, "already.png");
        writeFileSync(dest, "png");
        const result = await downloadAttachments({
            attachments: [
                {
                    name: "already.png",
                    mimeHint: "png",
                    url: "https://example.test/already.png",
                    itemId: null,
                    localPath: dest,
                },
            ],
            outDir: dir,
            fetchImpl: (async () => {
                throw new Error("should not fetch");
            }) as unknown as typeof fetch,
        });
        expect(result.failed).toBe(0);
        expect(result.attachments[0]?.localPath).toBe(dest);
    });

    test("does not fetch a loopback URL", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ms-teams-dl-"));
        const result = await downloadAttachments({
            attachments: [
                {
                    name: "x.png",
                    mimeHint: "png",
                    url: "https://127.0.0.1/x.png",
                    itemId: null,
                    localPath: null,
                },
            ],
            outDir: dir,
            fetchImpl: (async () => {
                throw new Error("should not fetch");
            }) as unknown as typeof fetch,
        });
        expect(result.failed).toBe(1);
        expect(result.attachments[0]?.localPath).toBeNull();
    });

    test("rejects an oversized Content-Length before writing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ms-teams-dl-"));
        const result = await downloadAttachments({
            attachments: [
                {
                    name: "big.png",
                    mimeHint: "png",
                    url: "https://eu-api.asm.skype.com/v1/objects/x/views/imgo",
                    itemId: null,
                    localPath: null,
                },
            ],
            outDir: dir,
            fetchImpl: (async () =>
                new Response("nope", {
                    status: 200,
                    headers: { "content-length": String(51 * 1024 * 1024) },
                })) as unknown as typeof fetch,
        });
        expect(result.failed).toBe(1);
        expect(result.attachments[0]?.localPath).toBeNull();
    });
});
