import { uniqueId } from "@/lib/unique-id";

/**
 * A key that makes a write safe to retry: the Mac answers a repeat with the first answer. Made once per user
 * action and passed in the mutation's variables, so a retry of the same action sends the same key.
 */
export function idempotencyKey(): string {
    return uniqueId("phone");
}
