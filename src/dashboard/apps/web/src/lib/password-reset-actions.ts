import { SafeJSON } from "@dashboard/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AuthError } from "./auth-actions";
import { workos } from "./auth-server";

const forgotPasswordSchema = z.object({
    email: z.string().email("Please enter a valid email address"),
});

const resetPasswordSchema = z.object({
    token: z.string().min(1, "Reset token is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

function extractWorkOSMessage(error: unknown): string {
    if (
        error &&
        typeof error === "object" &&
        "rawData" in error &&
        error.rawData &&
        typeof error.rawData === "object"
    ) {
        const raw = error.rawData as { message?: string; error?: string };
        return raw.message ?? raw.error ?? "An unexpected error occurred";
    }

    if (error && typeof error === "object" && "message" in error) {
        return (error as { message: string }).message;
    }

    return "An unexpected error occurred";
}

// Always returns success — prevents email enumeration on unknown addresses.
// Errors are logged server-side only.
export const forgotPasswordFn = createServerFn({ method: "POST" })
    .inputValidator((data: unknown) => {
        const parsed = forgotPasswordSchema.safeParse(data);

        if (!parsed.success) {
            return {
                code: "validation_error" as const,
                message: parsed.error.issues[0]?.message ?? "Validation failed",
            };
        }

        return parsed.data;
    })
    .handler(async ({ data }) => {
        if ("code" in data) {
            return data as AuthError;
        }

        try {
            await workos.userManagement.createPasswordReset({ email: data.email });
        } catch (error) {
            // Log but do not surface — prevents user enumeration.
            console.error("[forgotPasswordFn] WorkOS error:", SafeJSON.stringify(error));
        }

        return { success: true as const };
    });

export const resetPasswordFn = createServerFn({ method: "POST" })
    .inputValidator((data: unknown) => {
        const parsed = resetPasswordSchema.safeParse(data);

        if (!parsed.success) {
            return {
                code: "validation_error" as const,
                message: parsed.error.issues[0]?.message ?? "Validation failed",
            };
        }

        return parsed.data;
    })
    .handler(async ({ data }) => {
        if ("code" in data) {
            return data as AuthError;
        }

        try {
            await workos.userManagement.resetPassword({
                token: data.token,
                newPassword: data.newPassword,
            });
            return { success: true as const };
        } catch (error) {
            console.error("[resetPasswordFn] WorkOS error:", SafeJSON.stringify(error));
            return {
                code: "workos_error" as const,
                message: extractWorkOSMessage(error),
            };
        }
    });
