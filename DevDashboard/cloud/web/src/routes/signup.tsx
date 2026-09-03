import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AuthCard } from "@/components/auth/AuthCard";

const signupSearchSchema = z.object({
    plan: z.enum(["free", "pro", "team"]).optional(),
});

export const Route = createFileRoute("/signup")({
    validateSearch: signupSearchSchema,
    component: SignupPage,
});

function SignupPage() {
    const { plan } = Route.useSearch();

    return <AuthCard mode="signup" plan={plan} />;
}
