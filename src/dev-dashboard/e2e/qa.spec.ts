import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const marker = `playwright-qa-${Date.now()}`;

test("QA page renders markdown answers live over SSE with syntax highlighting", async ({ page }) => {
    await page.goto("/qa");

    const liveDot = page.locator('[title="Live stream connected"] span.animate-pulse');
    await expect(liveDot).toBeVisible();

    const answerMd = `# Render check ${marker}

Paragraph with **bold** and \`inline\` code.

\`\`\`tsx
import type { ReactNode } from "react";

export function HarnessPanel({ title, children }: { title: string; children: ReactNode }) {
  const enabled = true;

  return (
    <section className="panel" data-enabled={enabled}>
      <h2>{title}</h2>
      <div className="panel-body">{children}</div>
    </section>
  );
}
\`\`\`

Follow-up paragraph after the code fence.
`;

    const dir = mkdtempSync(join(tmpdir(), "dd-qa-"));
    const answerFile = join(dir, "answer.md");
    writeFileSync(answerFile, answerMd, "utf8");

    execFileSync(
        "tools",
        [
            "question",
            "answer",
            "--q",
            `Does Playwright see rendered markdown for ${marker}?`,
            "--a-file",
            answerFile,
            "--tag",
            "question",
            "--project",
            "GenesisTools",
        ],
        { cwd: process.cwd(), stdio: "pipe" }
    );

    const card = page.locator(".dd-panel", { hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });

    await expect(card.locator("strong", { hasText: "bold" })).toBeVisible();
    await expect(card.locator("pre code.language-tsx")).toBeVisible();
    await expect(card.locator("pre code .hljs-keyword").first()).toBeVisible();
    expect(await card.locator("pre code span[class*='hljs-']").count()).toBeGreaterThanOrEqual(5);

    const cardText = await card.innerText();
    expect(cardText).not.toContain("```tsx");
    expect(cardText).toContain("HarnessPanel");
});
