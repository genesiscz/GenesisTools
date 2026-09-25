const wrap = (outer: string, inner: string) => outer.replace("{}", encodeURIComponent(inner));

/**
 * One row per rule the link cleaner applies, with invented URLs. `clean.test.ts` checks `cleanUrl`
 * and `swift-parity.test.ts` routes the same rows through Router.swift.
 */
export const CLEAN_CASES: { name: string; input: string; output: string }[] = [
    {
        name: "outlook safelink",
        input: wrap("https://nam.safelinks.protection.outlook.com/x?url={}&data=05", "https://shop.example/item?id=1"),
        output: "https://shop.example/item?id=1",
    },
    {
        name: "google url?q=",
        input: wrap("https://www.google.com/url?q={}&sa=D", "https://docs.example/page"),
        output: "https://docs.example/page",
    },
    {
        name: "slack redirect",
        input: wrap("https://slack-redir.slack.com/link?url={}", "https://board.example/t/1"),
        output: "https://board.example/t/1",
    },
    {
        name: "teams redirect",
        input: wrap("https://statics.teams.microsoft.com/evergreen?url={}", "https://wiki.example/a"),
        output: "https://wiki.example/a",
    },
    {
        name: "utm parameters",
        input: "https://shop.example/a?utm_source=mail&utm_medium=x&id=2",
        output: "https://shop.example/a?id=2",
    },
    { name: "fbclid", input: "https://news.example/story?fbclid=IwAR0abc", output: "https://news.example/story" },
    { name: "gclid", input: "https://shop.example/p?gclid=Cj0K&size=m", output: "https://shop.example/p?size=m" },
    { name: "mc_eid", input: "https://letter.example/issue/4?mc_eid=12ab", output: "https://letter.example/issue/4" },
    { name: "a clean link stays", input: "https://example.com/a?id=2", output: "https://example.com/a?id=2" },
];
