import { describe, expect, test } from "bun:test";
import {
    type FileAccess,
    IMAGE_LIMIT_BYTES,
    joinMarkdown,
    type MediaRepoApi,
    MediaUploadPartialError,
    parseMediaArg,
    uploadMedia,
} from "@app/github/lib/media-upload";
import { SafeJSON } from "@genesiscz/utils/json";

const MB = 1024 * 1024;

function files(sizes: Record<string, number>): FileAccess {
    return {
        size: async (path) => sizes[path] ?? null,
        read: async (path) => new Uint8Array(Array.from({ length: Math.min(sizes[path] ?? 0, 4) }, (_, i) => i + 1)),
    };
}

interface Call {
    url: URL;
    init: RequestInit;
}

/** A fetch that records each call and answers from a queue; with no answer left it throws. */
function fakeFetch(answers: Response[], calls: Call[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: new URL(String(input)), init: init ?? {} });
        const answer = answers.shift();
        if (!answer) {
            throw new Error("an upload reached the network with no answer queued");
        }

        return answer;
    }) as typeof fetch;
}

function api(options: { canPush?: boolean; body?: string } = {}) {
    const written: string[] = [];
    const mediaApi: MediaRepoApi = {
        getRepo: async () => ({ id: 4242, canPush: options.canPush ?? true }),
        getBody: async () => options.body ?? "Existing body.",
        setBody: async ({ body }) => {
            written.push(body);
        },
    };
    return { mediaApi, written };
}

/** The error an upload run rejected with, which must carry the files already uploaded. */
async function partialError(run: Promise<unknown>): Promise<MediaUploadPartialError> {
    const caught = await run.then(
        () => null,
        (error: unknown) => error
    );
    if (!(caught instanceof MediaUploadPartialError)) {
        throw new Error(`expected a MediaUploadPartialError, got ${String(caught)}`);
    }

    return caught;
}

const ok = (id: string) =>
    new Response(SafeJSON.stringify({ url: `https://github.com/user-attachments/assets/${id}` }));

describe("parseMediaArg", () => {
    test("splits the alt text at the first #", () => {
        expect(parseMediaArg("shots/a.png#Login page #2")).toEqual({ path: "shots/a.png", alt: "Login page #2" });
        expect(parseMediaArg("shots/a.png")).toEqual({ path: "shots/a.png" });
        expect(parseMediaArg("shots/a.png#")).toEqual({ path: "shots/a.png" });
    });
});

describe("tools github media upload", () => {
    test("posts the raw bytes with the query and headers GitHub expects, and writes image and video markdown", async () => {
        const calls: Call[] = [];
        const { mediaApi } = api();
        const result = await uploadMedia(
            {
                repo: "shop/storefront",
                files: [{ path: "/s/login.png", alt: "Login page" }, { path: "/s/demo.mp4" }, { path: "/s/plain.png" }],
            },
            {
                api: mediaApi,
                token: () => "tok",
                files: files({ "/s/login.png": 100, "/s/demo.mp4": 20 * MB, "/s/plain.png": 5 }),
                fetch: fakeFetch([ok("a"), ok("b"), ok("c")], calls),
            }
        );

        expect(calls).toHaveLength(3);
        const first = calls[0];
        expect(first.url.origin + first.url.pathname).toBe("https://uploads.github.com/user-attachments/assets");
        expect(Object.fromEntries(first.url.searchParams)).toEqual({
            name: "login.png",
            content_type: "image/png",
            repository_id: "4242",
        });
        expect(first.init.method).toBe("POST");
        expect(first.init.headers).toEqual({
            "Content-Type": "application/octet-stream",
            Accept: "application/vnd.github+json",
            Authorization: "Bearer tok",
            "Content-Length": "4",
        });
        expect(Array.from(first.init.body as Uint8Array)).toEqual([1, 2, 3, 4]);
        expect(calls[1].url.searchParams.get("content_type")).toBe("video/mp4");

        expect(result.files.map((file) => file.markdown)).toEqual([
            "![Login page](https://github.com/user-attachments/assets/a)",
            "https://github.com/user-attachments/assets/b",
            "![plain](https://github.com/user-attachments/assets/c)",
        ]);
        expect(result.files[1]).toMatchObject({ kind: "video", bytes: 20 * MB, contentType: "video/mp4" });
    });

    test("maps 404, 422 and 429 to their sentences", async () => {
        const run = async (answer: Response, file = "/s/a.png", size = 10) => {
            const { mediaApi } = api();
            return uploadMedia(
                { repo: "shop/storefront", files: [{ path: file }] },
                { api: mediaApi, token: () => "t", files: files({ [file]: size }), fetch: fakeFetch([answer], []) }
            ).then(
                () => "uploaded",
                (error: Error) => error.message
            );
        };

        expect(await run(new Response("{}", { status: 404 }))).toContain("no write access to shop/storefront");
        expect(
            await run(new Response(SafeJSON.stringify({ message: "File type not supported" }), { status: 422 }))
        ).toBe("GitHub refused a.png: File type not supported.");
        expect(await run(new Response("{}", { status: 429, headers: { "Retry-After": "37" } }))).toBe(
            "GitHub rate limited the upload of a.png. Retry after 37 seconds."
        );
        expect(
            await run(
                new Response(SafeJSON.stringify({ message: "Size too big" }), { status: 422 }),
                "/s/v.mov",
                20 * MB
            )
        ).toContain("needs a paid plan");
    });

    test("refuses a 12 MB image before any request", async () => {
        const calls: Call[] = [];
        let repoReads = 0;
        const mediaApi: MediaRepoApi = {
            getRepo: async () => {
                repoReads++;
                return { id: 1, canPush: true };
            },
            getBody: async () => "",
            setBody: async () => {},
        };

        await expect(
            uploadMedia(
                { repo: "shop/storefront", files: [{ path: "/s/big.png" }] },
                {
                    api: mediaApi,
                    token: () => "t",
                    files: files({ "/s/big.png": 12 * MB }),
                    fetch: fakeFetch([], calls),
                }
            )
        ).rejects.toThrow(`big.png is 12.0 MB, over the ${IMAGE_LIMIT_BYTES / MB}.0 MB`);
        expect(calls).toHaveLength(0);
        expect(repoReads).toBe(0);
    });

    test("refuses a missing file and an upload without write access, and uploads nothing", async () => {
        const calls: Call[] = [];
        const { mediaApi } = api({ canPush: false });
        const deps = { api: mediaApi, token: () => "t", files: files({ "/s/a.png": 5 }), fetch: fakeFetch([], calls) };

        await expect(uploadMedia({ repo: "shop/storefront", files: [{ path: "/s/gone.png" }] }, deps)).rejects.toThrow(
            "does not exist"
        );
        await expect(uploadMedia({ repo: "shop/storefront", files: [{ path: "/s/a.png" }] }, deps)).rejects.toThrow(
            "No write access to shop/storefront"
        );
        expect(calls).toHaveLength(0);
    });

    test("a dry run reads the repo, reports a verdict per file and never posts", async () => {
        const { mediaApi, written } = api();
        const result = await uploadMedia(
            {
                repo: "shop/storefront",
                files: [{ path: "/s/a.png" }, { path: "/s/big.png" }],
                dryRun: true,
                append: false,
            },
            {
                api: mediaApi,
                token: () => {
                    throw new Error("a dry run asked for the token");
                },
                files: files({ "/s/a.png": 5, "/s/big.png": 12 * MB }),
                fetch: (() => {
                    throw new Error("a dry run reached the network");
                }) as unknown as typeof fetch,
            }
        );

        expect(result).toMatchObject({ dryRun: true, repoId: 4242, canPush: true });
        expect(result.files.map((file) => file.verdict)).toEqual([
            "would upload",
            expect.stringContaining("refused: big.png is 12.0 MB"),
        ]);
        expect(result.files.every((file) => file.url === null)).toBe(true);
        expect(written).toHaveLength(0);
    });

    test("--append writes the lines into the body after a blank line; without it the body is untouched", async () => {
        const deps = (written: { mediaApi: MediaRepoApi }) => ({
            api: written.mediaApi,
            token: () => "t",
            files: files({ "/s/a.png": 5, "/s/v.mp4": 5 }),
        });
        const input = { repo: "shop/storefront", files: [{ path: "/s/a.png" }, { path: "/s/v.mp4" }] };

        const appended = api({ body: "Fixes the bug.\n" });
        const result = await uploadMedia(
            { ...input, target: { kind: "pr", number: 7 }, append: true },
            { ...deps(appended), fetch: fakeFetch([ok("a"), ok("b")], []) }
        );
        expect(result.appended).toBe(true);
        expect(appended.written).toEqual([
            "Fixes the bug.\n\n![a](https://github.com/user-attachments/assets/a)\n\nhttps://github.com/user-attachments/assets/b",
        ]);

        const labelled = api();
        const plain = await uploadMedia(
            { ...input, target: { kind: "issue", number: 9 } },
            { ...deps(labelled), fetch: fakeFetch([ok("a"), ok("b")], []) }
        );
        expect(plain).toMatchObject({ appended: false, target: { kind: "issue", number: 9 } });
        expect(labelled.written).toHaveLength(0);
    });

    test("a failed second upload keeps the first file's URL on the error", async () => {
        const { mediaApi } = api();
        const partial = await partialError(
            uploadMedia(
                { repo: "shop/storefront", files: [{ path: "/s/a.png" }, { path: "/s/b.png" }] },
                {
                    api: mediaApi,
                    token: () => "t",
                    files: files({ "/s/a.png": 5, "/s/b.png": 5 }),
                    fetch: fakeFetch(
                        [ok("a"), new Response("{}", { status: 429, headers: { "Retry-After": "37" } })],
                        []
                    ),
                }
            )
        );

        expect(partial.message).toBe(
            "Uploaded 1 of 2 file(s), then the next one failed: GitHub rate limited the upload of b.png. Retry after 37 seconds."
        );
        expect(partial.uploaded.map((file) => file.markdown)).toEqual([
            "![a](https://github.com/user-attachments/assets/a)",
        ]);
    });

    test("a failed --append write after the uploads keeps every URL on the error", async () => {
        const mediaApi: MediaRepoApi = {
            getRepo: async () => ({ id: 1, canPush: true }),
            getBody: async () => "Body.",
            setBody: async () => {
                throw new Error("Validation Failed");
            },
        };
        const partial = await partialError(
            uploadMedia(
                {
                    repo: "shop/storefront",
                    files: [{ path: "/s/a.png" }, { path: "/s/v.mp4" }],
                    target: { kind: "pr", number: 7 },
                    append: true,
                },
                {
                    api: mediaApi,
                    token: () => "t",
                    files: files({ "/s/a.png": 5, "/s/v.mp4": 5 }),
                    fetch: fakeFetch([ok("a"), ok("b")], []),
                }
            )
        );

        expect(partial.message).toBe("Uploaded all 2 file(s), then writing the body failed: Validation Failed");
        expect(partial.uploaded.map((file) => file.url)).toEqual([
            "https://github.com/user-attachments/assets/a",
            "https://github.com/user-attachments/assets/b",
        ]);
    });

    test("--append on a PR that cannot be read fails before any upload", async () => {
        const calls: Call[] = [];
        const mediaApi: MediaRepoApi = {
            getRepo: async () => ({ id: 1, canPush: true }),
            getBody: async () => {
                throw new Error("Not Found");
            },
            setBody: async () => {},
        };

        await expect(
            uploadMedia(
                {
                    repo: "shop/storefront",
                    files: [{ path: "/s/a.png" }],
                    target: { kind: "pr", number: 99 },
                    append: true,
                },
                { api: mediaApi, token: () => "t", files: files({ "/s/a.png": 5 }), fetch: fakeFetch([], calls) }
            )
        ).rejects.toThrow("Not Found");
        expect(calls).toHaveLength(0);
    });
});

describe("joinMarkdown", () => {
    test("puts a blank line between files, so a video URL stands alone in its paragraph", () => {
        expect(
            joinMarkdown([
                { markdown: "![a](https://github.com/user-attachments/assets/a)" },
                { markdown: "https://github.com/user-attachments/assets/b" },
                { markdown: null },
            ])
        ).toBe("![a](https://github.com/user-attachments/assets/a)\n\nhttps://github.com/user-attachments/assets/b");
    });
});
