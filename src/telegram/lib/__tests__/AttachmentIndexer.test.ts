import { describe, expect, it, spyOn } from "bun:test";
import { AttachmentIndexer } from "../AttachmentIndexer";

describe("AttachmentIndexer", () => {
    it("indexes message attachments into store", () => {
        const indexer = new AttachmentIndexer();
        const fakeStore = {
            upsertAttachments: () => {},
        };
        const spy = spyOn(fakeStore, "upsertAttachments");

        indexer.indexSerializedMessage(
            fakeStore as unknown as Parameters<AttachmentIndexer["indexSerializedMessage"]>[0],
            "chat-1",
            {
                id: 10,
                senderId: "u1",
                text: "",
                mediaDescription: "a photo",
                isOutgoing: false,
                date: new Date().toISOString(),
                dateUnix: Math.floor(Date.now() / 1000),
                attachments: [
                    {
                        index: 0,
                        kind: "photo",
                        thumbCount: 1,
                    },
                ],
            }
        );

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith("chat-1", 10, [
            {
                index: 0,
                kind: "photo",
                thumbCount: 1,
            },
        ]);
    });
});
