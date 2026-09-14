import { describe, expect, test } from "bun:test";
import {
    buildMentionWiql,
    commentNamesUser,
    findMentions,
    mentionsInComments,
    stripCommentHtml,
    TooManyCandidatesError,
    wiqlMentionTerm,
} from "@app/azure-devops/lib/mentions";
import type { Comment } from "@app/azure-devops/types";

const USER = "Nováková Tereza (XX)";

function mention(name: string): string {
    return `<a href="#" data-vss-mention="version:2.0,00000000-1111-2222-3333-444444444444">@${name}</a>`;
}

function comment(overrides: Partial<Comment> & { text: string }): Comment {
    return {
        id: 1,
        author: "Dvořák Pavel",
        date: "2026-09-10T09:00:00Z",
        ...overrides,
    };
}

describe("wiqlMentionTerm", () => {
    test("takes the first word and keeps its diacritics, because the index holds the name as written", () => {
        expect(wiqlMentionTerm(USER)).toBe("Nováková");
    });

    test("drops the bracketed suffix rather than searching for it", () => {
        expect(wiqlMentionTerm("Example Alice (QT)")).toBe("Example");
    });

    test("survives a name with no suffix and no second word", () => {
        expect(wiqlMentionTerm("Ada")).toBe("Ada");
    });
});

describe("buildMentionWiql", () => {
    test("filters on the history index and the changed date", () => {
        const wiql = buildMentionWiql({ term: "Nováková", from: "2026-09-07" });

        expect(wiql).toContain("[System.History] CONTAINS 'Nováková'");
        expect(wiql).toContain("[System.ChangedDate] >= '2026-09-07'");
        expect(wiql).not.toContain("<=");
    });

    test("scopes to the configured project, like every other query this tool builds", () => {
        const wiql = buildMentionWiql({ term: "Nováková", from: "2026-09-07" });

        expect(wiql).toContain("[System.TeamProject] = @project");
    });

    test("adds the upper bound only when one was asked for", () => {
        const wiql = buildMentionWiql({ term: "Nováková", from: "2026-09-07", to: "2026-09-14" });

        expect(wiql).toContain("[System.ChangedDate] <= '2026-09-14'");
    });

    test("escapes a quote in the name instead of breaking the statement", () => {
        expect(buildMentionWiql({ term: "O'Brien", from: "2026-09-07" })).toContain("CONTAINS 'O''Brien'");
    });

    test("escapes a quote in a bound too, the way every other builder in this tool does", () => {
        const wiql = buildMentionWiql({ term: "Example", from: "2026-09-07'", to: "2026-09-14'" });

        expect(wiql).toContain(">= '2026-09-07'''");
        expect(wiql).toContain("<= '2026-09-14'''");
    });
});

describe("stripCommentHtml", () => {
    test("returns the text a person reads", () => {
        const text = stripCommentHtml(`<div>${mention(USER)}&nbsp;please&nbsp;look</div>`);

        expect(text).toBe("@Nováková Tereza (XX) please look");
    });

    test("puts a space where a table cell ended, so two cells do not glue into one word", () => {
        // Without this the two halves of the name become `NovákováTereza` and the comment no
        // longer contains the name at all.
        expect(stripCommentHtml("<table><tr><td>Nováková</td><td>Tereza</td></tr></table>")).toBe("Nováková Tereza");
    });

    test("puts a space where an ATTRIBUTED void block tag stood", () => {
        // A closing tag carries no attributes, so `<td class=…>A</td>` was already fine. A void
        // block tag has no closing half, so this one fell through to the generic stripper.
        expect(stripCommentHtml(`Nováková<br class="lb">Tereza`)).toBe("Nováková Tereza");
        expect(stripCommentHtml(`Nováková<br data-x="1"/>Tereza`)).toBe("Nováková Tereza");
    });

    test("puts a space where an unclosed attributed cell stood, which HTML5 permits", () => {
        expect(stripCommentHtml(`<tr><td class="a">Nováková<td class="b">Tereza`)).toBe("Nováková Tereza");
    });

    test("still spaces an attributed cell that IS closed", () => {
        expect(stripCommentHtml(`<td class="name">Nováková</td><td class="name">Tereza</td>`)).toBe("Nováková Tereza");
    });

    test("does not treat a tag that merely starts with a block name as a block", () => {
        expect(stripCommentHtml("a<tableau>b")).toBe("ab");
        expect(stripCommentHtml("a<price>b")).toBe("ab");
    });

    test("keeps a word split by an ATTRIBUTED inline tag as one word", () => {
        expect(stripCommentHtml(`Nov<span class="x">á</span>ková Tereza`)).toBe("Nováková Tereza");
    });

    test("keeps a word split by an inline tag as one word", () => {
        expect(stripCommentHtml("<p>Nov<b>á</b>ková Tereza</p>")).toBe("Nováková Tereza");
    });

    test("decodes the entities that survive the tag strip", () => {
        expect(stripCommentHtml("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toBe('a & b <c> "d"');
    });
});

describe("commentNamesUser", () => {
    test("matches an ordinary mention anchor", () => {
        expect(commentNamesUser(`<div>${mention(USER)}&nbsp;please look</div>`, USER)).toBe(true);
    });

    test("matches a mention written inside a parenthesis", () => {
        // The regression: normalizing the comment as if it were a NAME deletes bracketed text, and
        // deleted this whole mention along with it.
        const text = `<div>big refactor (${mention(USER)}&nbsp;add anything you have)</div>`;

        expect(commentNamesUser(text, USER)).toBe(true);
    });

    test("matches the name written the other way round, without the mention markup", () => {
        expect(commentNamesUser("<div>thanks Tereza Nováková for the fix</div>", USER)).toBe(true);
    });

    test("matches a name whose halves are separated by an attributed line break", () => {
        expect(commentNamesUser(`<div>Nováková<br class="lb">Tereza</div>`, USER)).toBe(true);
    });

    test("matches a name whose halves sit in two table cells", () => {
        const text = "<table><tr><td>Nováková</td><td>Tereza</td></tr></table>";

        expect(commentNamesUser(text, USER)).toBe(true);
    });

    test("does not match a comment that mentions somebody else", () => {
        expect(commentNamesUser(`<div>${mention("Dvořák Pavel")} please look</div>`, USER)).toBe(false);
    });

    test("does not match on the given name alone", () => {
        expect(commentNamesUser(`<div>${mention("Tereza Svobodová")} please look</div>`, USER)).toBe(false);
    });

    test("does not match two different colleagues who each carry one half of the name", () => {
        // "Tereza" belongs to one person here and "Nováková" to another. Requiring only that both
        // words appear somewhere in the comment reported this as a mention of neither.
        const text = `<div>${mention("Svobodová Tereza")} and ${mention("Nováková Jana")} agreed</div>`;

        expect(commentNamesUser(text, USER)).toBe(false);
    });

    test("matches the reversed name through a comma", () => {
        expect(commentNamesUser("<div>assigned to Nováková, Tereza today</div>", USER)).toBe(true);
    });

    test("does not match a three-part name whose words are split across three different people", () => {
        // Each token belongs to somebody else. Requiring only that all three appear somewhere
        // reported this as a mention of a fourth person who is not in the comment at all.
        const threePart = "Nováková Tereza Marie";
        const text = `<div>${mention("Nováková Jana")}, ${mention("Svobodová Tereza")} and Marie Example</div>`;

        expect(commentNamesUser(text, threePart)).toBe(false);
    });

    test("matches a three-part name written surname-last", () => {
        const threePart = "Nováková Tereza Marie";

        expect(commentNamesUser("<div>ping Marie Tereza Nováková please</div>", threePart)).toBe(true);
    });

    test("matches regardless of diacritics in the comment", () => {
        expect(commentNamesUser("<div>@Novakova Tereza pls</div>", USER)).toBe(true);
    });
});

describe("mentionsInComments", () => {
    const from = new Date("2026-09-07T00:00:00Z");

    test("keeps a matching comment inside the window", () => {
        const hits = mentionsInComments({
            workItemId: 810001,
            comments: [comment({ id: 11, text: `<div>${mention(USER)} look</div>` })],
            userName: USER,
            from,
        });

        expect(hits).toEqual([
            {
                workItemId: 810001,
                commentId: 11,
                author: "Dvořák Pavel",
                date: "2026-09-10T09:00:00Z",
                text: "@Nováková Tereza (XX) look",
            },
        ]);
    });

    test("drops a matching comment written before the window", () => {
        const hits = mentionsInComments({
            workItemId: 810001,
            comments: [comment({ date: "2026-08-01T09:00:00Z", text: `<div>${mention(USER)} look</div>` })],
            userName: USER,
            from,
        });

        expect(hits).toEqual([]);
    });

    test("drops a matching comment written after an explicit upper bound", () => {
        const hits = mentionsInComments({
            workItemId: 810001,
            comments: [comment({ date: "2026-09-20T09:00:00Z", text: `<div>${mention(USER)} look</div>` })],
            userName: USER,
            from,
            to: new Date("2026-09-14T23:59:59Z"),
        });

        expect(hits).toEqual([]);
    });

    test("drops a comment in the window that names nobody relevant", () => {
        const hits = mentionsInComments({
            workItemId: 810001,
            comments: [comment({ text: "<div>deployed to test</div>" })],
            userName: USER,
            from,
        });

        expect(hits).toEqual([]);
    });
});

describe("findMentions", () => {
    const from = new Date("2026-09-07T00:00:00Z");

    function searcher(candidates: number[], comments: Record<number, Comment[]>) {
        const asked: number[][] = [];
        let wiqlSeen = "";

        return {
            asked,
            seenWiql: () => wiqlSeen,
            runWiql: async (wiql: string) => {
                wiqlSeen = wiql;

                return candidates;
            },
            fetchComments: async (ids: number[]) => {
                asked.push([...ids]);

                return new Map(ids.map((id) => [id, comments[id] ?? []]));
            },
        };
    }

    test("reports the index candidates next to the confirmed mentions", async () => {
        const search = searcher([810001, 810002, 810003], {
            810001: [comment({ id: 21, text: `<div>${mention(USER)} look</div>` })],
            810002: [comment({ id: 22, text: "<div>a field change, no mention</div>" })],
            810003: [comment({ id: 23, date: "2026-01-01T09:00:00Z", text: `<div>${mention(USER)} old</div>` })],
        });

        const result = await findMentions({ userName: USER, from, ...search });

        expect(result.candidateIds).toEqual([810001, 810002, 810003]);
        expect(result.mentions.map((hit) => hit.workItemId)).toEqual([810001]);
    });

    test("bounds the candidate query with a time, so a comment written on the --to day still counts", async () => {
        const search = searcher([810001], {});
        const to = new Date("2026-09-14T23:59:59.999Z");

        await findMentions({ userName: USER, from, to, ...search });

        // A bare '2026-09-14' means midnight to WIQL and would exclude the whole day.
        expect(search.seenWiql()).toContain("[System.ChangedDate] <= '2026-09-14T23:59:59.999Z'");
        expect(search.seenWiql()).not.toContain("<= '2026-09-14'");
    });

    test("refuses a candidate list past the ceiling instead of spending a request on each", async () => {
        const ids = Array.from({ length: 12 }, (_, index) => 820000 + index);
        const search = searcher(ids, {});

        await expect(findMentions({ userName: USER, from, maxCandidates: 10, ...search })).rejects.toBeInstanceOf(
            TooManyCandidatesError
        );
        expect(search.asked).toEqual([]);
    });

    test("names the real count and the ceiling, so the message carries its own fix", async () => {
        const ids = Array.from({ length: 12 }, (_, index) => 820000 + index);
        const search = searcher(ids, {});

        const error = await findMentions({ userName: USER, from, maxCandidates: 10, ...search }).catch((err) => err);

        expect(error).toBeInstanceOf(TooManyCandidatesError);
        expect(error.candidateCount).toBe(12);
        expect(error.maxCandidates).toBe(10);
        expect(error.message).toContain("--max-candidates 12");
    });

    test("reads every candidate when the list sits on the ceiling", async () => {
        const ids = Array.from({ length: 10 }, (_, index) => 820000 + index);
        const search = searcher(ids, {});

        const result = await findMentions({ userName: USER, from, maxCandidates: 10, ...search });

        expect(result.candidateIds).toHaveLength(10);
        expect(search.asked).toEqual([ids]);
    });

    test("returns the newest mention first", async () => {
        const search = searcher([810001, 810002], {
            810001: [comment({ id: 31, date: "2026-09-08T09:00:00Z", text: `<div>${mention(USER)} older</div>` })],
            810002: [comment({ id: 32, date: "2026-09-12T09:00:00Z", text: `<div>${mention(USER)} newer</div>` })],
        });

        const result = await findMentions({ userName: USER, from, ...search });

        expect(result.mentions.map((hit) => hit.commentId)).toEqual([32, 31]);
    });

    test("fetches comments once, for the candidate set", async () => {
        const search = searcher([810001, 810002], {});

        await findMentions({ userName: USER, from, ...search });

        expect(search.asked).toEqual([[810001, 810002]]);
    });

    test("does not fetch any comment when the index returned nothing", async () => {
        const search = searcher([], {});

        const result = await findMentions({ userName: USER, from, ...search });

        expect(search.asked).toEqual([]);
        expect(result.mentions).toEqual([]);
    });

    test("asks the index for the surname, not the whole display name", async () => {
        const search = searcher([], {});

        await findMentions({ userName: USER, from, ...search });

        expect(search.seenWiql()).toContain("CONTAINS 'Nováková'");
    });
});
