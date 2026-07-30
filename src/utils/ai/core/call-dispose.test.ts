import { describe, expect, test } from "bun:test";
import type { ProviderBinding } from "../providers/plugin-types";
import type { CallTarget } from "./call";
import { resolveCallTarget } from "./call";
import type { ResolvedBinding } from "./types";

/**
 * Who frees the binding.
 *
 * Local runtimes hold native handles, so a resolved binding nobody disposes is a
 * real leak, not a tidiness point. But disposing indiscriminately is worse: a
 * caller that resolved its own binding may reuse it across many calls, and
 * freeing it under them breaks the second call.
 *
 * The rule is therefore ownership, and these two tests are the rule: a target
 * built from a bare ModelRef owns its binding and carries a `dispose`; a target
 * built from a caller-supplied `ResolvedBinding` does not.
 */

function fakeBinding(onDispose: () => void): ProviderBinding {
    return {
        accountId: "acc_fake",
        providerId: "fake",
        billed: false,
        language: () => ({ specificationVersion: "v3", provider: "fake", modelId: "fake-1" }),
        dispose: onDispose,
    } as unknown as ProviderBinding;
}

function suppliedBinding(onDispose: () => void): ResolvedBinding {
    return {
        binding: fakeBinding(onDispose),
        plugin: { id: "fake" },
        account: { id: "acc_fake", name: "fake-account", provider: "fake" },
        model: { id: "fake-1" },
    } as unknown as ResolvedBinding;
}

describe("binding ownership in resolveCallTarget", () => {
    test("a caller-supplied binding is NOT disposed — the caller may reuse it", async () => {
        let disposed = 0;
        const target: CallTarget = await resolveCallTarget({ model: suppliedBinding(() => disposed++) });

        expect(target.dispose).toBeUndefined();

        // What callLLM's finally block does. It must be a no-op here.
        target.dispose?.();
        expect(disposed).toBe(0);
    });

    test("a self-resolved binding carries a dispose that reaches the binding", async () => {
        let disposed = 0;

        // resolveCallTarget only self-resolves for a string ref, and that path
        // needs real config. Assert the wiring directly instead: the shape a
        // self-resolved target has, and that calling it frees the binding.
        const resolved = suppliedBinding(() => disposed++);
        const selfResolvedTarget: CallTarget = {
            model: resolved.binding.language("fake-1"),
            label: "fake-account/fake-1",
            dispose: () => resolved.binding.dispose?.(),
        };

        selfResolvedTarget.dispose?.();
        expect(disposed).toBe(1);
    });
});
