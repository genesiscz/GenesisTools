import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isInteractive } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatCount, formatDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import * as p from "@genesiscz/utils/prompts/p";
import { listCodesignIdentities, readManifest, trustCodesignKeys } from "../../lib/permissions/app";
import { probeCodesignKey } from "../../lib/permissions/codesign-trust";

/** The signing certificates `security find-identity` lists; none when it cannot be read. */
async function signingIdentities(): Promise<{ hash: string; name: string }[]> {
    const result = await boundedCommand({
        command: ["security", "find-identity", "-v", "-p", "codesigning"],
        timeoutMs: 10_000,
    });

    return result.status === 0 ? listCodesignIdentities(result.stdout) : [];
}

/** A window a click opened stays readable until the user is done with it. */
async function waitForEnter(fromNotice: boolean): Promise<void> {
    if (!fromNotice) {
        return;
    }

    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    await prompt.question("\nPress Enter to finish.");
    prompt.close();
}

/**
 * `tools macos permissions codesign-trust`: what the trust is and why a build needs it, a confirmation, then
 * `security set-key-partition-list`, the keys it changed, and one test sign without the dialog. `fromNotice`: the
 * build's keychain notice opened it in a terminal, so it says so and waits for Enter at the end.
 */
export async function runCodesignTrust({ fromNotice }: { fromNotice: boolean }): Promise<void> {
    // security asks for the login password on the terminal: without one it waits out the deadline for nothing.
    if (!isInteractive()) {
        out.log.error("codesign-trust asks for the login keychain password and needs a terminal.");
        out.log.info(`Run it in a terminal: ${toolCommand("macos permissions codesign-trust")}`);
        process.exitCode = 1;
        return;
    }

    const signedWith = readManifest()?.signedWith;
    const identities = await signingIdentities();
    out.intro("GenesisTools: let codesign sign the app without the keychain dialog");
    out.note(
        [
            ...(fromNotice
                ? ["You clicked the notice:", '"GenesisTools build: codesign needs the keychain".', ""]
                : []),
            "Why it is needed",
            "Every build of GenesisTools.app (bun run app, or",
            `${toolCommand("macos permissions build")}) signs the app with your certificate,`,
            ...(signedWith ? [`"${signedWith}",`] : []),
            "so macOS keeps the app's privacy grants after a rebuild.",
            "The certificate's private key is in your login keychain. Until codesign",
            "is on the key's list of allowed tools, the keychain shows a password",
            "dialog during a build. A build with nobody at the screen waits 10 s for",
            "it and then fails.",
            "",
            "What it does",
            "security set-key-partition-list -S apple-tool:,apple:,codesign: \\",
            "    -s ~/Library/Keychains/login.keychain-db",
            "- It asks once for your macOS login password (the login keychain's).",
            "- It changes every signing key in the login keychain, not only the",
            "  app's key: the list of each key becomes Apple's tools, codesign",
            "  included. Another app that a key listed loses that entry.",
            "- It is safe to run again.",
            ...(identities.length > 0
                ? [
                      "",
                      "Signing certificates on this Mac",
                      ...identities.map((id) => `- ${id.name} (${id.hash.slice(0, 10)})`),
                  ]
                : []),
        ].join("\n"),
        "What this is"
    );

    const apply = await p.confirm({ message: "Apply the codesign trust now?", initialValue: true });

    if (!apply) {
        out.outro("Nothing changed. Click Always Allow in the next codesign dialog, or run this command later.");
        await waitForEnter(fromNotice);
        return;
    }

    out.log.step("Running security. Type your macOS login password when it asks for it.");
    const result = await trustCodesignKeys();
    const outputFile = join(genesisAppDir(), "codesign-trust-output.txt");

    if (result.output) {
        writeFileSync(outputFile, result.output);
    }

    if (!result.ok) {
        out.log.error(
            `${result.reason}: some keys may already have changed (security does not roll back), so check them in Keychain Access before you retry. Run ${toolCommand("macos permissions codesign-trust")} again, or click Always Allow in the next codesign dialog.`
        );
        process.exitCode = 1;
        await waitForEnter(fromNotice);
        return;
    }

    out.log.success(
        result.keys.length > 0
            ? `security changed ${formatCount(result.keys.length, "signing key")}: ${result.keys.join(", ")}.`
            : "security finished without an error."
    );

    if (result.output) {
        out.log.info(`Its full output (one block per key): ${outputFile}`);
    }

    if (result.markerError) {
        out.log.warn(`The keychain change stands, but ${result.markerError}, so the next build asks again.`);
    }

    const sign = identities.find((id) => id.name === signedWith)?.hash ?? signedWith;

    if (!sign) {
        out.outro(`Done. The next ${toolCommand("macos permissions build")} signs without the dialog.`);
        await waitForEnter(fromNotice);
        return;
    }

    out.log.step(`Test: codesign signs a small file with "${signedWith}".`);
    const probe = await probeCodesignKey({ sign });

    if (probe.ok && !probe.dialog) {
        out.log.success(`codesign signed it in ${formatDuration(probe.ms)}, without the keychain dialog.`);
        out.outro(`Done. The next ${toolCommand("macos permissions build")} signs without the dialog.`);
    } else if (probe.ok) {
        out.log.warn(
            "codesign signed it, but the keychain dialog was up. If you clicked Allow, the next build asks again."
        );
        out.outro("Click Always Allow in that dialog, or check the key's Access Control in Keychain Access.");
    } else {
        out.log.error(`The test sign failed: ${probe.detail || "no output"}`);
        process.exitCode = 1;
    }

    await waitForEnter(fromNotice);
}
