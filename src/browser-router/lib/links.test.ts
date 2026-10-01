import { describe, expect, test } from "bun:test";
import { applyPresets, presets } from "@genesiscz/utils/browser-router/presets";
import { defaultRouterConfig, type RouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { collectLinks, convertMarkdown, wrapLink } from "./links";

const LINK_HOST = "links.example.test";

function configWith(chosen: RouterConfig["presets"]): RouterConfig & { linkHost: string } {
    const base = { ...defaultRouterConfig(), linkHost: LINK_HOST, presets: chosen };
    return { ...base, routes: applyPresets([], presets({ config: base, check: () => true })) };
}

const plain = configWith({});

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
        const converted = convertMarkdown(markdown, plain);

        expect(converted).toContain("[shop](https://www.rohlik.cz/p/1)");
        expect(converted).toContain(`[add](${wrapLink(local, LINK_HOST)})`);
        expect(converted).toContain(`<${wrapLink(local, LINK_HOST)}>`);
        expect(converted).toContain(`\n${local}\n`);
    });

    test("rewrites genesis-md links to the https URL that routes back to them", () => {
        const config = configWith({ "genesis-md": {} });
        const markdown = ["[note](genesis-md://open?path=/tmp/a.md)", "see genesis-md://panel/chat"].join("\n");
        const converted = convertMarkdown(markdown, config);

        expect(converted).toContain("[note](https://links.example.test/md/open?path=/tmp/a.md)");
        expect(converted).toContain("https://links.example.test/md/panel/chat");
        expect(route("https://links.example.test/md/open?path=/tmp/a.md", config).url).toBe(
            "genesis-md://open?path=/tmp/a.md"
        );
        expect(route("https://links.example.test/md/panel/chat", config).url).toBe("genesis-md://panel/chat");
    });

    test("leaves a non-http scheme other than genesis-md as written", () => {
        const markdown = "[edit](cursor://file/tmp/a.ts:3) and [mail](mailto:alice@example.com)";
        expect(convertMarkdown(markdown, plain)).toBe(markdown);
    });

    test("does not wrap a link that is already a router link", () => {
        const href = "https://links.example.test/md/open?path=%2Ftmp%2Fa.md";
        expect(convertMarkdown(`[open](${href})`, plain)).toBe(`[open](${href})`);
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
