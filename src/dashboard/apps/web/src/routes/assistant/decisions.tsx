import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { DashboardLayout } from "@/components/dashboard";
import { useDecisionLog, useTaskStore } from "@/lib/assistant/hooks";
import type { DecisionInput } from "@/lib/assistant/types";
import { DecisionLog } from "./-components/decisions";

export const Route = createFileRoute("/assistant/decisions")({
    component: DecisionsPage,
});

function DecisionsPage() {
    const { user, loading: authLoading } = useAuth();
    const userId = user?.id ?? null;

    const {
        decisions,
        loading,
        initialized,
        createDecision,
        updateDecision,
        deleteDecision,
        supersedeDecision,
        reverseDecision,
        getDecisionChain,
        getAllTags,
    } = useDecisionLog(userId);

    const { tasks } = useTaskStore(userId);

    // Handle creating a decision
    async function handleCreateDecision(input: DecisionInput) {
        await createDecision(input);
    }

    // Handle updating a decision
    async function handleUpdateDecision(id: string, updates: Partial<DecisionInput>) {
        await updateDecision(id, updates);
    }

    // Handle deleting a decision
    async function handleDeleteDecision(id: string) {
        await deleteDecision(id);
    }

    // Handle superseding a decision
    async function handleSupersedeDecision(oldId: string, newDecision: DecisionInput) {
        await supersedeDecision(oldId, newDecision);
    }

    // Handle reversing a decision
    async function handleReverseDecision(id: string, reason: string) {
        await reverseDecision(id, reason);
    }

    const existingTags = getAllTags();

    return (
        <DashboardLayout
            title="Decisions"
            description="Track and document important decisions to prevent re-debating settled topics"
        >
            <DecisionLog
                decisions={decisions}
                loading={loading || authLoading}
                initialized={initialized}
                tasks={tasks}
                existingTags={existingTags}
                onCreateDecision={handleCreateDecision}
                onUpdateDecision={handleUpdateDecision}
                onDeleteDecision={handleDeleteDecision}
                onSupersedeDecision={handleSupersedeDecision}
                onReverseDecision={handleReverseDecision}
                getDecisionChain={getDecisionChain}
            />
        </DashboardLayout>
    );
}
