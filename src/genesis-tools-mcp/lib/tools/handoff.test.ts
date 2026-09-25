import { describe, expect, test } from "bun:test";
import type { PostHandoffResponse } from "@app/handoff/executor";
import type { PlannedLink } from "@genesiscz/utils/browser-router/links";
import { settleRunLinks } from "./handoff";

const INFO = "Show paste.runLink.markdown to the user so they can open the handoff in a new cmux surface.";

function response(url: string): Pick<PostHandoffResponse, "paste" | "info"> {
    return {
        paste: { _agent: "go", id: "h_x", title: "t", tasks: "0/1", runLink: { url, markdown: `[Run](${url})` } },
        info: ["first", INFO],
    };
}

function planned(url: string, saved: boolean): PlannedLink {
    const link = { url, markdown: `[Run](${url})` };
    return { link, save: async () => (saved ? link : null) };
}

describe("handoff_post run link", () => {
    test("a link whose token was written stays", async () => {
        const url = "https://genesis.tools/t/abcdefgh1234";
        const settled = await settleRunLinks(response(url), [planned(url, true)]);

        expect(settled.paste.runLink?.url).toBe(url);
        expect(settled.info).toContain(INFO);
    });

    test("a link whose token could not be written is removed with its info line, so no dead link shows", async () => {
        const url = "https://genesis.tools/t/abcdefgh1234";
        const settled = await settleRunLinks(response(url), [planned(url, false)]);

        expect(settled.paste.runLink).toBeUndefined();
        expect(settled.info).toEqual(["first"]);
    });
});
