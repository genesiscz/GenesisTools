import { expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { setupTaskIntegrationHome, withTaskSession } from "./task-integration-env";

const env = setupTaskIntegrationHome();

test("clean --session removes ONE session, leaves others (B5)", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const A = `clean-a-${suffix}`;
    const B = `clean-b-${suffix}`;

    await withTaskSession(env, B, async () => {
        env.task(["run", "--session", A, "--no-tty", "--", "bash", "-c", "echo a"]);
        env.task(["run", "--session", B, "--no-tty", "--", "bash", "-c", "echo b"]);

        const cleanResult = env.task(["clean", "--session", A]);
        expect(cleanResult.code).toBe(0);

        const list = env.task(["sessions", "--json"]);
        const names = (SafeJSON.parse(list.stdout, { strict: true }) as Array<{ name: string }>).map((s) => s.name);
        expect(names).not.toContain(A);
        expect(names).toContain(B);
    });
});
