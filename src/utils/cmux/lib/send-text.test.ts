import { expect, test } from "bun:test";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { keptBin } from "@genesiscz/utils/test/kept-executable";

// Regression test: 2026-09-07 restore screenshot — cmux send turns shell escapes into Enter keys.
test("literal terminal transport preserves backslashes and the final Enter", async () => {
    // Kept, never deleted with the run's temp root (the syspolicyd trap in .claude/rules/tests.md).
    const dir = keptBin({ cmux: "#!/bin/sh\nprintf '%s\\n' \"$@\"\n" });
    const modulePath = join(import.meta.dir, "cli.ts");
    const payload = "printf '%s\\n' 'a\\tb\\rc'\n";
    const source = `
        import { sendSurfaceText } from ${SafeJSON.stringify(modulePath)};
        const result = await sendSurfaceText({ surfaceRef: "surface:42", text: ${SafeJSON.stringify(payload)} });
        process.stdout.write(result.stdout);
    `;
    const proc = Bun.spawn([process.execPath, "-e", source], {
        env: { ...env.getProcessEnv(), PATH: `${dir}:${env.getProcessEnv().PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    const [command, method, params] = stdout.trimEnd().split("\n");
    expect(command).toBe("rpc");
    expect(method).toBe("surface.send_text");
    expect(SafeJSON.parse(params)).toEqual({ surface_id: "surface:42", text: payload });
});
