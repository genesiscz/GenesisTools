import { type Harness, RESUME_ARGV } from "./Generated/harness-facts";

/**
 * The command that resumes a session in a terminal, as `resumeArgv` in src/utils/agent-sessions/resume-argv.ts
 * builds it for an account (a plugin file cannot import that module, so the drivers' recipes are generated into
 * `Generated/harness-facts.ts` by `scripts/gen-harness-plugin.ts`). resume-argv.test.ts holds the two equal.
 */
export function resumeArgv(harness: Harness, sessionId: string, account?: string | null): string[] {
    const recipe = RESUME_ARGV[harness];
    const words = account ? recipe.account : recipe.plain;
    return words.map((word) => (word === "{session}" ? sessionId : word === "{account}" ? (account ?? "") : word));
}
