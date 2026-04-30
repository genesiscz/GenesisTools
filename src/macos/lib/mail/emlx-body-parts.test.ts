import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEmlxBodyPartsFromFile } from "./emlx";

function writeEmlx(mime: string, byteCount = Buffer.byteLength(mime)): string {
    const dir = mkdtempSync(join(tmpdir(), "genesis-emlx-body-"));
    const filePath = join(dir, "123.emlx");
    writeFileSync(filePath, `${byteCount}\n${mime}`);
    return filePath;
}

function writeRaw(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "genesis-emlx-body-"));
    const filePath = join(dir, "123.emlx");
    writeFileSync(filePath, content);
    return filePath;
}

const tempDirs = new Set<string>();

function track(filePath: string): string {
    tempDirs.add(filePath.slice(0, filePath.lastIndexOf("/")));
    return filePath;
}

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe("parseEmlxBodyPartsFromFile", () => {
    it("preserves raw MIME, HTML links, Markdown links, and text", async () => {
        const mime = [
            "From: billing@example.com",
            "To: user@example.com",
            "Subject: Invoice",
            "MIME-Version: 1.0",
            'Content-Type: multipart/alternative; boundary="part"',
            "",
            "--part",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "View your tax invoice",
            "",
            "--part",
            'Content-Type: text/html; charset="utf-8"',
            "",
            '<html><body><p><a href="https://example.com/invoice">View your tax invoice</a></p></body></html>',
            "",
            "--part--",
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts).not.toBeNull();
        expect(parts?.raw).toContain("Content-Type: multipart/alternative");
        expect(parts?.html).toContain('href="https://example.com/invoice"');
        expect(parts?.markdown).toContain("[View your tax invoice](https://example.com/invoice)");
        expect(parts?.text).toContain("View your tax invoice");
    });

    it("removes style and script content from Markdown while preserving body links", async () => {
        const mime = [
            "From: billing@example.com",
            "To: user@example.com",
            "Subject: Styled HTML",
            "MIME-Version: 1.0",
            'Content-Type: text/html; charset="utf-8"',
            "",
            '<html><head><style>.secret { color: red; }</style><script>alert("nope")</script></head><body><table><tr><td><a href="https://example.com/invoice">View invoice</a></td></tr></table></body></html>',
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts?.html).toContain(".secret");
        expect(parts?.markdown).toContain("[View invoice](https://example.com/invoice)");
        expect(parts?.markdown).not.toContain(".secret");
        expect(parts?.markdown).not.toContain("alert");
        expect(parts?.markdown).not.toContain("<table");
        expect(parts?.markdown).not.toContain("<td");
        expect(parts?.text).toContain("View invoice");
    });

    it("returns text and Markdown from text/plain messages without HTML", async () => {
        const mime = [
            "From: notes@example.com",
            "To: user@example.com",
            "Subject: Plain",
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Line one",
            "Line two with https://example.com/plain",
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts?.html).toBe("");
        expect(parts?.text).toContain("Line one\nLine two");
        expect(parts?.markdown).toContain("Line one\nLine two");
        expect(parts?.raw).toContain('Content-Type: text/plain; charset="utf-8"');
    });

    it("falls back to the bytes after the first line when the emlx byte count is invalid", async () => {
        const mime = [
            "From: fallback@example.com",
            "Subject: Invalid Count",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Fallback body survives",
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime, Number.NaN));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts?.text).toContain("Fallback body survives");
        expect(parts?.raw).toContain("Invalid Count");
    });

    it("respects a short emlx byte count and ignores trailing plist-style data", async () => {
        const mime = [
            "From: count@example.com",
            "Subject: Counted",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Only MIME body",
            "",
        ].join("\r\n");
        const filePath = track(writeRaw(`${Buffer.byteLength(mime)}\n${mime}<plist>not part of MIME</plist>`));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts?.text).toContain("Only MIME body");
        expect(parts?.raw).not.toContain("not part of MIME");
    });

    it("returns null for files without an emlx first-line separator", async () => {
        const filePath = track(writeRaw("not an emlx file"));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts).toBeNull();
    });

    it("decodes quoted-printable UTF-8 text and HTML", async () => {
        const mime = [
            "From: utf@example.com",
            "To: user@example.com",
            "Subject: UTF",
            "MIME-Version: 1.0",
            'Content-Type: multipart/alternative; boundary="utf"',
            "",
            "--utf",
            'Content-Type: text/plain; charset="utf-8"',
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "Dobr=C3=BD den",
            "",
            "--utf",
            'Content-Type: text/html; charset="utf-8"',
            "Content-Transfer-Encoding: quoted-printable",
            "",
            '<p>Dobr=C3=BD <a href=3D"https://example.com/%C4%8Dau">=C4=8Dau</a></p>',
            "",
            "--utf--",
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts?.text).toContain("Dobrý den");
        expect(parts?.html).toContain("Dobrý");
        expect(parts?.markdown).toContain("[čau](https://example.com/%C4%8Dau)");
    });

    it("preserves image alt text and image URLs in Markdown", async () => {
        const mime = [
            "From: image@example.com",
            "To: user@example.com",
            "Subject: Image",
            "MIME-Version: 1.0",
            'Content-Type: text/html; charset="utf-8"',
            "",
            '<html><body><p>Logo:</p><img alt="Company logo" src="https://example.com/logo.png"></body></html>',
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts?.markdown).toContain("![Company logo](https://example.com/logo.png)");
        expect(parts?.text).toContain("Logo");
    });

    it("returns an empty text field but keeps raw MIME for attachment-only messages", async () => {
        const mime = [
            "From: attachment@example.com",
            "Subject: Attachment Only",
            "MIME-Version: 1.0",
            'Content-Type: application/pdf; name="invoice.pdf"',
            "Content-Transfer-Encoding: base64",
            "",
            "JVBERi0xLjQK",
            "",
        ].join("\r\n");
        const filePath = track(writeEmlx(mime));

        const parts = await parseEmlxBodyPartsFromFile(filePath);

        expect(parts).not.toBeNull();
        expect(parts?.text).toBe("");
        expect(parts?.html).toBe("");
        expect(parts?.markdown).toBe("");
        expect(parts?.raw).toContain("application/pdf");
    });
});
