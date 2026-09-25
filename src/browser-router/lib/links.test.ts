import { describe, expect, test } from "bun:test";
import { defaultRouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { collectLinks, convertMarkdown, wrapLink } from "./links";

describe("convertMarkdown", () => {
    test("leaves ordinary web links and rewrites local ones", () => {
        const local = "http://127.0.0.1:8787/add/1472972?qty=1";
        const markdown = [
            `See [shop](https://www.rohlik.cz/p/1) and [add](${local}).`,
            "",
            "```",
            local,
            "```",
            "",
            `<${local}>`,
        ].join("\n");
        const converted = convertMarkdown(markdown);

        expect(converted).toContain("[shop](https://www.rohlik.cz/p/1)");
        expect(converted).toContain(`[add](${wrapLink(local)})`);
        expect(converted).toContain(`<${wrapLink(local)}>`);
        expect(converted).toContain(`\n${local}\n`);
    });

    test("rewrites genesis-md links to the https URL that routes back to them", () => {
        const config = defaultRouterConfig();
        const markdown = ["[note](genesis-md://open?path=/tmp/a.md)", "see genesis-md://panel/chat"].join("\n");
        const converted = convertMarkdown(markdown, undefined, config);

        expect(converted).toContain("[note](https://genesis.tools/open?path=/tmp/a.md)");
        expect(converted).toContain("https://genesis.tools/panel/chat");
        expect(route("https://genesis.tools/open?path=/tmp/a.md", config).url).toBe("genesis-md://open?path=/tmp/a.md");
        expect(route("https://genesis.tools/panel/chat", config).url).toBe("genesis-md://panel/chat");
    });

    test("leaves a non-http scheme other than genesis-md as written", () => {
        const markdown = "[edit](cursor://file/tmp/a.ts:3) and [mail](mailto:alice@example.com)";
        expect(convertMarkdown(markdown)).toBe(markdown);
    });

    test("does not wrap a link that is already a router link", () => {
        const href = "https://127.0.0.1:6666/open?path=%2Ftmp%2Fa.md";
        expect(convertMarkdown(`[open](${href})`)).toBe(`[open](${href})`);
    });
});

describe("collectLinks", () => {
    test("markdown links, autolinks and bare URLs, in order, once each, never from a code fence", () => {
        const note = [
            "Standup: [PR 1](https://git.example/pr/1) and <https://git.example/pr/2>.",
            "Board https://board.example/sprint?view=me. Again [PR 1](https://git.example/pr/1)",
            "```",
            "https://inside.example/fence",
            "```",
            "[mail](mailto:alice@example.com) [local](genesis-md://open)",
        ].join("\n");

        expect(collectLinks(note)).toEqual([
            "https://git.example/pr/1",
            "https://git.example/pr/2",
            "https://board.example/sprint?view=me",
        ]);
    });
});
