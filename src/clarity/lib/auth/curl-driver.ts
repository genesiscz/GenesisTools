import { createInterface } from "node:readline";
import type { ClarityAuthDriver } from "@app/clarity/lib/auth/types";
import { parseAuthCurl } from "@app/clarity/lib/parse-auth-curl";
import * as clack from "@clack/prompts";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

/**
 * Read multiline cURL input from stdin.
 * Collects lines until: empty line entered, or a line without trailing backslash
 * (with a short debounce to handle fast paste).
 */
async function readMultilineCurl(): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines: string[] = [];
    let finishTimer: ReturnType<typeof setTimeout> | null = null;

    return new Promise((resolve) => {
        out.println(pc.gray("  (paste cURL, press Enter on blank line to finish)"));
        process.stdout.write(pc.cyan("  > "));

        function finish() {
            if (finishTimer) {
                clearTimeout(finishTimer);
            }

            rl.close();
            const result = lines
                .map((l) => l.replace(/\\\s*$/, ""))
                .join(" ")
                .trim();
            resolve(result);
        }

        rl.on("line", (line) => {
            if (finishTimer) {
                clearTimeout(finishTimer);
                finishTimer = null;
            }

            // Empty line after content = done
            if (lines.length > 0 && line.trim() === "") {
                finish();
                return;
            }

            lines.push(line);

            // Line ends with backslash = more input expected
            if (line.trim().endsWith("\\")) {
                process.stdout.write(pc.cyan("  > "));
                return;
            }

            // No backslash: debounce 200ms in case paste buffer has more lines
            finishTimer = setTimeout(finish, 200);
        });

        rl.on("close", () => {
            if (lines.length > 0) {
                finish();
            }
        });
    });
}

export const curlAuthDriver: ClarityAuthDriver = {
    id: "curl",
    label: "Paste a cURL command copied from the browser",
    async signIn() {
        clack.note(
            [
                "Paste a cURL command copied from Clarity. Your mappings are kept.",
                "",
                "Steps:",
                "  1. Open Clarity PPM in Chrome/Edge and go to Timesheets",
                "  2. Press F12 (or Ctrl+Shift+I / Cmd+Option+I on Mac) to open Developer Tools",
                "  3. Click the 'Network' tab, then reload the page (F5)",
                "  4. Find any request whose name contains '/ppm/rest/v1/' (filter by 'ppm')",
                "  5. Right-click it -> Copy -> Copy as cURL (bash)",
                "  6. Paste it below (multi-line is OK, press Enter twice when done)",
            ].join("\n"),
            "How to get the cURL command"
        );

        clack.log.step("Paste the cURL command:");
        const curlInput = await readMultilineCurl();

        if (!curlInput.trim()) {
            throw new Error("No cURL command provided.");
        }

        if (!curlInput.includes("curl") && !curlInput.includes("http")) {
            throw new Error("Doesn't look like a valid cURL command.");
        }

        return parseAuthCurl(curlInput);
    },
};
