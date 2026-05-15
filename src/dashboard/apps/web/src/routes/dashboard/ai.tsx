import { createFileRoute } from "@tanstack/react-router";
import { ComingSoonCard } from "@ui/custom";
import { Brain, Lightbulb, MessageSquare, Zap } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";

export const Route = createFileRoute("/dashboard/ai")({
    component: AIAssistantPage,
});

function AIAssistantPage() {
    return (
        <DashboardLayout
            title="AI Assistant"
            description="Your personal AI companion for tasks, research, and creativity"
        >
            <ComingSoonCard
                color="purple"
                icon={Brain}
                title="AI Assistant"
                description="Your personal AI companion powered by advanced language models. Get help with research, writing, coding, and creative tasks."
                features={[
                    { icon: MessageSquare, label: "Chat Interface" },
                    { icon: Lightbulb, label: "Smart Suggestions" },
                    { icon: Zap, label: "Quick Actions" },
                ]}
            />
        </DashboardLayout>
    );
}
