import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { DEFAULT_USER_SETTINGS } from "@app/youtube/lib/user-settings";
import type { YtUser } from "@app/youtube/lib/users.types";

type ConsoleUserDb = Pick<YoutubeDatabase, "getUserByEmail" | "createUser" | "grantCredits" | "transaction">;
type StoredUser = YtUser & { passwordHash: string; apiToken: string };

/**
 * The four `YoutubeDatabase` methods `withConsoleContext()` touches.
 *
 * CLI commands that enqueue run inside the console service context so their jobs
 * get a real owner, which drags user creation into every command test. These fakes
 * keep those tests on a plain object instead of a real database.
 */
export function consoleUserDbFake(): ConsoleUserDb {
    const users = new Map<string, StoredUser>();

    return {
        getUserByEmail: (email: string) => users.get(email) ?? null,
        createUser: (input: { email: string; passwordHash: string; apiToken: string }): YtUser => {
            const user: StoredUser = {
                id: users.size + 1,
                email: input.email,
                credits: 0,
                createdAt: "2026-04-01",
                outputLang: null,
                ttsVoice: null,
                settings: DEFAULT_USER_SETTINGS,
                passwordHash: input.passwordHash,
                apiToken: input.apiToken,
            };
            users.set(input.email, user);

            return user;
        },
        grantCredits: (userId: number, amount: number): number => {
            for (const user of users.values()) {
                if (user.id === userId) {
                    user.credits += amount;

                    return user.credits;
                }
            }

            return amount;
        },
        transaction: <T>(fn: () => T): T => fn(),
    };
}
