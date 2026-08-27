import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { extractShellQuirks, renderShellQuirksMarkdown } from "./extract-shell-quirks";

function writeSession(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "zsh-extract-"));
    const path = join(dir, "sess-test.jsonl");
    writeFileSync(path, lines.join("\n"));
    return path;
}

function msg(obj: Record<string, unknown>): string {
    return SafeJSON.stringify(obj, { strict: true });
}

function bashPair(options: {
    toolUseId: string;
    command: string;
    result: string;
    sessionId?: string;
    isError?: boolean;
}): string[] {
    const sessionId = options.sessionId ?? "sess-test";
    return [
        msg({
            type: "assistant",
            uuid: `a-${options.toolUseId}`,
            sessionId,
            timestamp: "2026-08-04T00:00:00.000Z",
            userType: "external",
            message: {
                role: "assistant",
                id: `m-${options.toolUseId}`,
                model: "claude-test",
                content: [
                    {
                        type: "tool_use",
                        id: options.toolUseId,
                        name: "Bash",
                        input: { command: options.command },
                    },
                ],
            },
        }),
        msg({
            type: "user",
            uuid: `u-${options.toolUseId}`,
            sessionId,
            timestamp: "2026-08-04T00:00:01.000Z",
            userType: "external",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: options.toolUseId,
                        is_error: options.isError,
                        content: options.result,
                    },
                ],
            },
        }),
    ];
}

async function extractFrom(path: string, extra: { dedupe?: boolean } = {}) {
    const result = await extractShellQuirks({
        projectsDir: join(path, ".."),
        useRgPrefilter: false,
        includeRuleCodification: false,
        ...extra,
    });
    return { result, ours: result.findings.filter((f) => f.filePath === path) };
}

describe("extractShellQuirks", () => {
    test("pairs Bash tool_use with nomatch result and classifies equals-expansion", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_eq",
                command: "echo ===; ls /tmp/nosuch*",
                result: "(eval):1: == not found\n(eval):1: no matches found: /tmp/nosuch*",
            })
        );

        const { result, ours } = await extractFrom(path);
        expect(ours.length).toBeGreaterThanOrEqual(1);
        const f = ours[0]!;
        expect(f.toolUseId).toBe("toolu_eq");
        expect(f.command).toContain("echo ===");
        expect(f.locate.sed).toContain(path);
        expect(f.line).toBe(2);
        expect(f.toolUseLine).toBe(1);
        // equals-expansion wins when both === and nomatch present
        expect(f.kind).toBe("equals-expansion");
        expect(f.repeatCount).toBe(1);

        const md = renderShellQuirksMarkdown(result, {
            generatedAt: "2026-08-04T00:00:00.000Z",
            command: "test",
        });
        expect(md).toContain("equals-expansion");
        expect(md).toContain("Locate");
    });

    test("classifies unquoted URL with ?", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_url",
                command: "curl http://localhost:3042/api?limit=1",
                result: "(eval):1: no matches found: http://localhost:3042/api?limit=1",
            })
        );

        const { ours } = await extractFrom(path);
        expect(ours[0]?.kind).toBe("unquoted-url");
    });

    test("classifies unquoted [brackets] as the glob trigger", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_br",
                command: "ls /tmp/foo[1].txt",
                result: "(eval):1: no matches found: /tmp/foo[1].txt",
            })
        );

        const { ours } = await extractFrom(path);
        expect(ours[0]?.kind).toBe("unquoted-brackets");
    });

    test("multi-glob + 2>/dev/null: kind is multi-glob, both facets set", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_mg",
                command: "ls -d /tmp/mg-real* /tmp/mg-nosuch* 2>/dev/null",
                result: "(eval):1: no matches found: /tmp/mg-nosuch*",
            })
        );

        const { ours } = await extractFrom(path);
        const f = ours[0]!;
        expect(f.kind).toBe("multi-glob-kills-command");
        expect(f.facets.multiGlob).toBe(true);
        expect(f.facets.stderrSuppressed).toBe(true);
        expect(f.facets.forLoop).toBe(false);
    });

    test("for-loop glob abort", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_for",
                command: 'for f in /tmp/zzz-nosuch*; do echo "$f"; done',
                result: "(eval):1: no matches found: /tmp/zzz-nosuch*",
            })
        );

        const { ours } = await extractFrom(path);
        const f = ours[0]!;
        expect(f.kind).toBe("for-loop-abort");
        expect(f.facets.forLoop).toBe(true);
    });

    test("classifies bad pattern as its own kind", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_bad",
                command: "ls /tmp/foo[",
                result: "(eval):1: bad pattern: /tmp/foo[",
            })
        );

        const { ours } = await extractFrom(path);
        expect(ours[0]?.kind).toBe("bad-pattern");
    });

    test("dedupes identical command+error retries into one finding with repeatCount", async () => {
        const path = writeSession([
            ...bashPair({
                toolUseId: "toolu_r1",
                command: "ls /tmp/retry-nosuch*",
                result: "(eval):1: no matches found: /tmp/retry-nosuch*",
            }),
            ...bashPair({
                toolUseId: "toolu_r2",
                command: "ls /tmp/retry-nosuch*",
                result: "(eval):1: no matches found: /tmp/retry-nosuch*",
            }),
        ]);

        const { ours } = await extractFrom(path);
        expect(ours.length).toBe(1);
        expect(ours[0]!.repeatCount).toBe(2);

        const { ours: raw } = await extractFrom(path, { dedupe: false });
        expect(raw.length).toBe(2);
    });

    test("skips self-referential commands that search for the quirk text", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_self",
                command: "rg -n 'no matches found' /tmp/session.jsonl",
                result: '(eval):1: no matches found: foo*\n42:"content":"zsh:1: no matches found: bar*"',
            })
        );

        const { ours } = await extractFrom(path);
        expect(ours.length).toBe(0);
    });

    test("skips trigger-free commands whose output merely quotes an error", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_cat",
                command: "cat notes.md",
                result: "some doc\nzsh:1: no matches found: /tmp/quoted-example\nmore doc",
            })
        );

        const { ours } = await extractFrom(path);
        expect(ours.length).toBe(0);
    });

    test("skips unpaired non-error tool_results (Read/Grep quoting old incidents)", async () => {
        const path = writeSession([
            msg({
                type: "user",
                uuid: "u-orphan",
                sessionId: "sess-test",
                timestamp: "2026-08-04T00:00:01.000Z",
                userType: "external",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_orphan",
                            content: "zsh:1: no matches found: /tmp/orphan*",
                        },
                    ],
                },
            }),
        ]);

        const { ours } = await extractFrom(path);
        expect(ours.length).toBe(0);
    });

    test("render includes facets, repeats, and occurrence totals", async () => {
        const path = writeSession([
            ...bashPair({
                toolUseId: "toolu_m1",
                command: "ls -d /tmp/a* /tmp/b* 2>/dev/null",
                result: "(eval):1: no matches found: /tmp/b*",
            }),
            ...bashPair({
                toolUseId: "toolu_m2",
                command: "ls -d /tmp/a* /tmp/b* 2>/dev/null",
                result: "(eval):1: no matches found: /tmp/b*",
            }),
        ]);

        const { result } = await extractFrom(path);
        const md = renderShellQuirksMarkdown(result, {
            generatedAt: "2026-08-04T00:00:00.000Z",
            command: "test",
        });
        expect(md).toContain("(2 occurrences incl. repeats)");
        expect(md).toContain("×2");
        expect(md).toContain("stderr-suppressed");
        expect(md).toContain("## Facets");
    });

    /**
     * Every other test here passes `useRgPrefilter: false`, so the prefilter branch
     * was never entered. ripgrep only chooses which files to open, and a machine
     * without it (ubuntu-latest, for one) has to reach the same finding — so this
     * runs the DEFAULT path, which is the rg prefilter where rg exists and the
     * in-process scan where it does not.
     */
    test("the default prefilter finds the same incident with or without ripgrep", async () => {
        const path = writeSession(
            bashPair({
                toolUseId: "toolu_prefilter",
                command: "ls /tmp/nosuch*",
                result: "zsh:1: no matches found: /tmp/nosuch*",
            })
        );

        const result = await extractShellQuirks({
            projectsDir: join(path, ".."),
            includeRuleCodification: false,
        });

        expect(result.findings.filter((f) => f.filePath === path)).toHaveLength(1);
    });
});
