import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { Octokit } from "octokit";
import { withGhFallback } from "./octokit";

/** A fake GitHub: the env token sees nothing of the repository, the gh login sees it. Counts the calls. */
function fakeGitHub() {
    const calls: string[] = [];
    const fetch = async (_url: string, init: { headers: Record<string, string> }) => {
        const auth = init.headers.authorization ?? "";
        calls.push(auth);
        const body = auth.includes("gh-token")
            ? { data: { repository: { nameWithOwner: "Org/App" } } }
            : {
                  data: { repository: null },
                  errors: [
                      { type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'Org/App'." },
                  ],
              };
        return new Response(SafeJSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const make = (token: string) =>
        new Octokit({ auth: token, request: { fetch }, retry: { enabled: false }, throttle: { enabled: false } });
    return { calls, make };
}

const QUERY = `{ repository(owner: "Org", name: "App") { nameWithOwner } }`;
const MUTATION = `mutation { addComment(input: {subjectId: "X", body: "hi"}) { clientMutationId } }`;
const COMMENTED_MUTATION = `# explanation\nmutation { addComment(input: {subjectId: "X", body: "hi"}) { clientMutationId } }`;
const FRAGMENT_THEN_MUTATION = `fragment Id on AddCommentPayload { clientMutationId }\nmutation { addComment(input: {subjectId: "X", body: "hi"}) { ...Id } }`;
const QUERY_THEN_MUTATION = `query Who { viewer { login } }\nmutation Post { addComment(input: {subjectId: "X", body: "hi"}) { clientMutationId } }`;

describe("withGhFallback", () => {
    test("a repository the env token cannot see is read once more with the gh login", async () => {
        const github = fakeGitHub();
        const octokit = withGhFallback(github.make("env-token"), "env-token", {
            ghToken: () => "gh-token",
            client: github.make,
        });
        const data = await octokit.graphql<{ repository: { nameWithOwner: string } }>(QUERY);
        expect(data.repository.nameWithOwner).toBe("Org/App");
        expect(github.calls).toEqual(["token env-token", "token gh-token"]);
    });

    test("the retry never loops back through the env token", async () => {
        const github = fakeGitHub();
        const octokit = withGhFallback(github.make("env-token"), "env-token", {
            ghToken: () => "gh-token",
            client: github.make,
        });
        await octokit.graphql(QUERY);
        expect(github.calls.length).toBe(2);
    });

    test("with no other gh login the env token's answer stands", async () => {
        const github = fakeGitHub();
        const octokit = withGhFallback(github.make("env-token"), "env-token", {
            ghToken: () => "env-token",
            client: github.make,
        });
        await expect(octokit.graphql(QUERY)).rejects.toThrow(/Could not resolve/);
        expect(github.calls).toEqual(["token env-token"]);
    });

    test("a mutation the env token cannot run is never retried with the gh login", async () => {
        const github = fakeGitHub();
        const octokit = withGhFallback(github.make("env-token"), "env-token", {
            ghToken: () => "gh-token",
            client: github.make,
        });
        await expect(octokit.graphql(MUTATION)).rejects.toThrow(/Could not resolve/);
        expect(github.calls).toEqual(["token env-token"]);
    });

    test("a mutation behind a leading comment is still never retried with the gh login", async () => {
        const github = fakeGitHub();
        const octokit = withGhFallback(github.make("env-token"), "env-token", {
            ghToken: () => "gh-token",
            client: github.make,
        });
        await expect(octokit.graphql(COMMENTED_MUTATION)).rejects.toThrow(/Could not resolve/);
        expect(github.calls).toEqual(["token env-token"]);
    });

    for (const [name, document] of [
        ["a mutation after a leading fragment", FRAGMENT_THEN_MUTATION],
        ["a mutation after a query in the same document", QUERY_THEN_MUTATION],
    ] as const) {
        test(`${name} is never retried with the gh login`, async () => {
            const github = fakeGitHub();
            const octokit = withGhFallback(github.make("env-token"), "env-token", {
                ghToken: () => "gh-token",
                client: github.make,
            });
            await expect(octokit.graphql(document)).rejects.toThrow(/Could not resolve/);
            expect(github.calls).toEqual(["token env-token"]);
        });
    }

    test("a fallback request that itself fails is not retried a second time", async () => {
        const calls: string[] = [];
        const fetch = async (_url: string, init: { headers: Record<string, string> }) => {
            const auth = init.headers.authorization ?? "";
            calls.push(auth);
            if (auth.includes("gh-token")) {
                return new Response("not found", { status: 404 });
            }

            return new Response(
                SafeJSON.stringify({
                    data: { repository: null },
                    errors: [
                        { type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'Org/App'." },
                    ],
                }),
                { status: 200, headers: { "content-type": "application/json" } }
            );
        };
        const make = (token: string) =>
            new Octokit({ auth: token, request: { fetch }, retry: { enabled: false }, throttle: { enabled: false } });
        const octokit = withGhFallback(make("env-token"), "env-token", {
            ghToken: () => "gh-token",
            client: make,
        });
        await expect(octokit.graphql(QUERY)).rejects.toThrow();
        expect(calls).toEqual(["token env-token", "token gh-token"]);
    });
});
