import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { HostedSupervisor } from "./hosted";

const CHILD_LIBRARY = join(moduleDir(import.meta), "hosted-child.ts");

const started: HostedSupervisor[] = [];

afterEach(() => {
    for (const supervisor of started.splice(0)) {
        supervisor.stop();
    }
});

function handlerSource(version: number): string {
    return `export async function serve(request, peer) {
        return Response.json({ version: ${version}, pid: process.pid, peer, path: new URL(request.url).pathname });
    }\n`;
}

describe("HostedSupervisor", () => {
    test("serves the module in a child, keeps that child while the code is unchanged, and runs edited code on the next call", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const module = join(dir, "handler.ts");
        writeFileSync(module, handlerSource(1));
        const entry = join(dir, "entry.ts");
        writeFileSync(
            entry,
            `import { runHostedChild } from ${SafeJSON.stringify(CHILD_LIBRARY)};\nimport { serve } from "./handler.ts";\nawait runHostedChild(serve);\n`
        );
        const supervisor = new HostedSupervisor(
            "fixture",
            { entry, sourceRoot: dir },
            { socketDir: dir, checkMs: 100 }
        );
        started.push(supervisor);
        const call = async () => {
            const response = await supervisor.forward(
                new Request("http://127.0.0.1:8318/mcp/fixture", { method: "POST", body: "{}" }),
                { clientPort: 50_001, serverPort: 8318 }
            );
            return (await response.json()) as { version: number; pid: number; peer: unknown; path: string };
        };

        const first = await call();
        expect(first).toMatchObject({
            version: 1,
            peer: { clientPort: 50_001, serverPort: 8318 },
            path: "/mcp/fixture",
        });
        expect(first.pid).not.toBe(process.pid);
        const again = await call();
        expect(again.pid).toBe(first.pid);

        writeFileSync(module, handlerSource(2));
        const later = new Date(Date.now() + 2_000);
        utimesSync(module, later, later);
        const deadline = Date.now() + 10_000;
        let next = await call();

        while (next.version !== 2 && Date.now() < deadline) {
            await Bun.sleep(150);
            next = await call();
        }

        expect(next.version).toBe(2);
        expect(next.pid).not.toBe(first.pid);
    }, 20_000);
});
