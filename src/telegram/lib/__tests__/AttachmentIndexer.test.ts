import { describe, expect, it } from "bun:test";
import type { Api } from "telegram";
import { AttachmentIndexer } from "../AttachmentIndexer";

function fakeMessage(overrides: Record<string, unknown>): Api.Message {
	return { id: 0, media: null, ...overrides } as unknown as Api.Message;
}

describe("AttachmentIndexer", () => {
	it("extracts photo attachment", () => {
		const msg = fakeMessage({
			id: 1,
			media: {
				className: "MessageMediaPhoto",
				photo: {
					className: "Photo",
					id: BigInt(12345),
					sizes: [{ className: "PhotoSize", type: "x", w: 800, h: 600, size: 50000 }],
					mimeType: "image/jpeg",
				},
			},
		});

		const attachments = AttachmentIndexer.extract("chat1", msg);
		expect(attachments.length).toBe(1);
		expect(attachments[0].kind).toBe("photo");
		expect(attachments[0].attachment_index).toBe(0);
	});

	it("extracts document attachment with filename", () => {
		const msg = fakeMessage({
			id: 2,
			media: {
				className: "MessageMediaDocument",
				document: {
					className: "Document",
					id: BigInt(67890),
					mimeType: "application/pdf",
					size: BigInt(1024),
					attributes: [
						{ className: "DocumentAttributeFilename", fileName: "report.pdf" },
					],
				},
			},
		});

		const attachments = AttachmentIndexer.extract("chat1", msg);
		expect(attachments.length).toBe(1);
		expect(attachments[0].kind).toBe("document");
		expect(attachments[0].file_name).toBe("report.pdf");
		expect(attachments[0].mime_type).toBe("application/pdf");
	});

	it("returns empty for text-only message", () => {
		const msg = fakeMessage({ id: 3, media: null });
		const attachments = AttachmentIndexer.extract("chat1", msg);
		expect(attachments.length).toBe(0);
	});

	it("classifies sticker correctly", () => {
		const msg = fakeMessage({
			id: 4,
			media: {
				className: "MessageMediaDocument",
				document: {
					className: "Document",
					id: BigInt(11111),
					mimeType: "image/webp",
					size: BigInt(5000),
					attributes: [{ className: "DocumentAttributeSticker" }],
				},
			},
		});

		const attachments = AttachmentIndexer.extract("chat1", msg);
		expect(attachments[0].kind).toBe("sticker");
	});

	it("classifies voice message correctly", () => {
		const msg = fakeMessage({
			id: 5,
			media: {
				className: "MessageMediaDocument",
				document: {
					className: "Document",
					id: BigInt(22222),
					mimeType: "audio/ogg",
					size: BigInt(8000),
					attributes: [{ className: "DocumentAttributeAudio", voice: true }],
				},
			},
		});

		const attachments = AttachmentIndexer.extract("chat1", msg);
		expect(attachments[0].kind).toBe("voice");
	});
});
