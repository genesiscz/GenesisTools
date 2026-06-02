import { createFileRoute } from "@tanstack/react-router";
import { AuthCard } from "@/components/auth/AuthCard";

export const Route = createFileRoute("/signin")({
    component: SigninPage,
});

function SigninPage() {
    return <AuthCard mode="signin" />;
}
