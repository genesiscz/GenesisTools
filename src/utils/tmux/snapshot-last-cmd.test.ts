import { describe, expect, test } from "bun:test";
import { isPlausibleLastShellCommand } from "@genesiscz/utils/tmux/snapshot";

describe("isPlausibleLastShellCommand", () => {
    test("accepts normal commands", () => {
        expect(isPlausibleLastShellCommand("bun run test")).toBe(true);
        expect(isPlausibleLastShellCommand("git status")).toBe(true);
        expect(isPlausibleLastShellCommand("./scripts/foo.sh --flag")).toBe(true);
    });

    test("rejects SGR mouse / CSI junk from ttyd scrollback", () => {
        expect(isPlausibleLastShellCommand("GenesisTools git:(master) 997;1n997;1n35;162;2M35;160;2M35;158;2M")).toBe(
            false
        );
        expect(isPlausibleLastShellCommand("35;162;2M35;160;2M")).toBe(false);
    });

    test("rejects wrapped oh-my-zsh prompt chrome", () => {
        expect(
            isPlausibleLastShellCommand(
                "GenesisTools\n➜  GenesisTools git:(master)\n➜  GenesisTools git:(master) 997;1n35;162;2M"
            )
        ).toBe(false);
        expect(isPlausibleLastShellCommand("GenesisTools ➜  GenesisTools git:(master)")).toBe(false);
        expect(isPlausibleLastShellCommand("GenesisTools")).toBe(false);
        expect(isPlausibleLastShellCommand("GenesisTools git:(master)")).toBe(false);
    });
});
