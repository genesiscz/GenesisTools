import {
    ArrowRightCircle,
    CheckCircle,
    Clock,
    Filter,
    List,
    Loader2,
    Plus,
    Scale,
    Search,
    XCircle,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Decision, DecisionImpactArea, DecisionInput, Task } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { DecisionCard } from "./DecisionCard";
import { DecisionForm } from "./DecisionForm";
import { DecisionTimeline } from "./DecisionTimeline";
import { SupersededChain } from "./SupersededChain";

interface DecisionLogProps {
    decisions: Decision[];
    loading?: boolean;
    initialized?: boolean;
    tasks?: Task[];
    existingTags?: string[];
    onCreateDecision: (input: DecisionInput) => Promise<void>;
    onUpdateDecision?: (id: string, updates: Partial<Decision>) => Promise<void>;
    onDeleteDecision?: (id: string) => Promise<void>;
    onSupersedeDecision?: (oldId: string, newDecision: DecisionInput) => Promise<void>;
    onReverseDecision?: (id: string, reason: string) => Promise<void>;
    getDecisionChain?: (id: string) => Decision[];
}

type TabValue = "all" | "active" | "superseded" | "reversed";
type ViewMode = "grid" | "timeline";

/**
 * Tab configuration
 */
const tabs: { value: TabValue; label: string; icon: typeof CheckCircle }[] = [
    { value: "active", label: "Active", icon: CheckCircle },
    { value: "superseded", label: "Superseded", icon: ArrowRightCircle },
    { value: "reversed", label: "Reversed", icon: XCircle },
    { value: "all", label: "All", icon: List },
];

/**
 * Impact area filter options
 */
const impactAreaOptions: { value: DecisionImpactArea | "all"; label: string; color: string }[] = [
    { value: "all", label: "All Areas", color: "text-foreground" },
    { value: "frontend", label: "Frontend", color: "text-purple-400" },
    { value: "backend", label: "Backend", color: "text-blue-400" },
    { value: "infrastructure", label: "Infrastructure", color: "text-orange-400" },
    { value: "process", label: "Process", color: "text-cyan-400" },
    { value: "architecture", label: "Architecture", color: "text-amber-400" },
    { value: "product", label: "Product", color: "text-emerald-400" },
];

/**
 * DecisionLog component - Main container for decision tracking
 */
export function DecisionLog({
    decisions,
    loading = false,
    initialized = true,
    tasks = [],
    existingTags = [],
    onCreateDecision,
    onUpdateDecision,
    onDeleteDecision,
    onSupersedeDecision,
    onReverseDecision,
    getDecisionChain,
}: DecisionLogProps) {
    const [activeTab, setActiveTab] = useState<TabValue>("active");
    const [viewMode, setViewMode] = useState<ViewMode>("grid");
    const [searchQuery, setSearchQuery] = useState("");
    const [impactAreaFilter, setImpactAreaFilter] = useState<DecisionImpactArea | "all">("all");

    // Form dialogs
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [editingDecision, setEditingDecision] = useState<Decision | null>(null);

    // Action dialogs
    const [supersedingDecision, setSupersedingDecision] = useState<Decision | null>(null);
    const [reversingDecision, setReversingDecision] = useState<Decision | null>(null);
    const [reversalReason, setReversalReason] = useState("");

    // Chain view dialog
    const [chainViewDecision, setChainViewDecision] = useState<Decision | null>(null);

    // Filter decisions
    const filteredDecisions = decisions.filter((decision) => {
        // Status filter
        if (activeTab !== "all" && decision.status !== activeTab) {
            return false;
        }

        // Impact area filter
        if (impactAreaFilter !== "all" && decision.impactArea !== impactAreaFilter) {
            return false;
        }

        // Search filter
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            const searchable = [
                decision.title,
                decision.reasoning,
                ...decision.tags,
                ...decision.alternativesConsidered,
            ]
                .join(" ")
                .toLowerCase();

            if (!searchable.includes(query)) {
                return false;
            }
        }

        return true;
    });

    // Sort by date (most recent first)
    const sortedDecisions = [...filteredDecisions].sort(
        (a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime()
    );

    // Counts
    const counts = {
        all: decisions.length,
        active: decisions.filter((d) => d.status === "active").length,
        superseded: decisions.filter((d) => d.status === "superseded").length,
        reversed: decisions.filter((d) => d.status === "reversed").length,
    };

    // Handlers
    async function handleCreateDecision(input: DecisionInput) {
        await onCreateDecision(input);
    }

    async function handleEditDecision(input: DecisionInput) {
        if (editingDecision && onUpdateDecision) {
            await onUpdateDecision(editingDecision.id, input);
            setEditingDecision(null);
        }
    }

    async function handleSupersedeDecision(input: DecisionInput) {
        if (supersedingDecision && onSupersedeDecision) {
            await onSupersedeDecision(supersedingDecision.id, input);
            setSupersedingDecision(null);
        }
    }

    async function handleReverseDecision() {
        if (reversingDecision && onReverseDecision && reversalReason.trim()) {
            await onReverseDecision(reversingDecision.id, reversalReason.trim());
            setReversingDecision(null);
            setReversalReason("");
        }
    }

    async function handleDeleteDecision(id: string) {
        if (onDeleteDecision) {
            await onDeleteDecision(id);
        }
    }

    function handleViewChain(decisionId: string) {
        const decision = decisions.find((d) => d.id === decisionId);
        if (decision) {
            setChainViewDecision(decision);
        }
    }

    // Get chain for chain view
    const chain =
        chainViewDecision && getDecisionChain
            ? getDecisionChain(chainViewDecision.id)
            : chainViewDecision
              ? [chainViewDecision]
              : [];

    // Loading state
    if (!initialized && loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
                    <span className="text-muted-foreground text-sm font-mono">Loading decisions...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Toolbar */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                {/* Tabs */}
                <div className="flex items-center gap-1 p-1 rounded-lg bg-white/5 border border-white/10">
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.value;

                        return (
                            <button
                                key={tab.value}
                                type="button"
                                onClick={() => setActiveTab(tab.value)}
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                    isActive
                                        ? "bg-purple-500/20 text-purple-300"
                                        : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                                )}
                            >
                                <Icon className="h-4 w-4" />
                                <span className="hidden sm:inline">{tab.label}</span>
                                <span
                                    className={cn(
                                        "text-xs px-1.5 rounded-full",
                                        isActive ? "bg-purple-500/30 text-purple-200" : "bg-white/10"
                                    )}
                                >
                                    {counts[tab.value]}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            value={searchQuery}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                            placeholder="Search decisions..."
                            className="pl-9 w-[200px] bg-background/50"
                        />
                    </div>

                    {/* Impact area filter */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="gap-2">
                                <Filter className="h-4 w-4" />
                                <span className="hidden sm:inline">
                                    {impactAreaOptions.find((o) => o.value === impactAreaFilter)?.label ?? "Filter"}
                                </span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuLabel>Impact Area</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {impactAreaOptions.map((option) => (
                                <DropdownMenuItem
                                    key={option.value}
                                    onClick={() => setImpactAreaFilter(option.value)}
                                    className={cn(impactAreaFilter === option.value && "bg-accent")}
                                >
                                    <span className={option.color}>{option.label}</span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* View mode toggle */}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setViewMode(viewMode === "grid" ? "timeline" : "grid")}
                        className="gap-2"
                    >
                        {viewMode === "grid" ? (
                            <>
                                <Clock className="h-4 w-4" />
                                <span className="hidden sm:inline">Timeline</span>
                            </>
                        ) : (
                            <>
                                <List className="h-4 w-4" />
                                <span className="hidden sm:inline">Grid</span>
                            </>
                        )}
                    </Button>

                    {/* Create button */}
                    <Button
                        onClick={() => setCreateDialogOpen(true)}
                        size="sm"
                        className="gap-2 bg-purple-600 hover:bg-purple-700"
                    >
                        <Plus className="h-4 w-4" />
                        <span className="hidden sm:inline">Add Decision</span>
                    </Button>
                </div>
            </div>

            {/* Content */}
            {sortedDecisions.length === 0 ? (
                <EmptyState
                    activeTab={activeTab}
                    hasSearch={!!searchQuery}
                    hasFilter={impactAreaFilter !== "all"}
                    onAddDecision={() => setCreateDialogOpen(true)}
                />
            ) : viewMode === "grid" ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr">
                    {sortedDecisions.map((decision, index) => (
                        <div
                            key={decision.id}
                            className="animate-fade-in-up h-full"
                            style={{ animationDelay: `${index * 50}ms` }}
                        >
                            <DecisionCard
                                decision={decision}
                                onSupersede={
                                    onSupersedeDecision
                                        ? (id) => {
                                              const d = decisions.find((dec) => dec.id === id);
                                              if (d) {
                                                  setSupersedingDecision(d);
                                              }
                                          }
                                        : undefined
                                }
                                onReverse={
                                    onReverseDecision
                                        ? (id) => {
                                              const d = decisions.find((dec) => dec.id === id);
                                              if (d) {
                                                  setReversingDecision(d);
                                              }
                                          }
                                        : undefined
                                }
                                onEdit={onUpdateDecision ? setEditingDecision : undefined}
                                onDelete={onDeleteDecision ? handleDeleteDecision : undefined}
                                onViewChain={getDecisionChain ? handleViewChain : undefined}
                                className="h-full"
                            />
                        </div>
                    ))}
                </div>
            ) : (
                <DecisionTimeline
                    decisions={sortedDecisions}
                    onSelectDecision={(decision) => setEditingDecision(decision)}
                />
            )}

            {/* Create dialog */}
            <DecisionForm
                open={createDialogOpen}
                onOpenChange={setCreateDialogOpen}
                onSubmit={handleCreateDecision}
                tasks={tasks}
                existingTags={existingTags}
            />

            {/* Edit dialog */}
            {editingDecision && (
                <DecisionForm
                    open={!!editingDecision}
                    onOpenChange={(open) => !open && setEditingDecision(null)}
                    onSubmit={handleEditDecision}
                    initialValues={{
                        title: editingDecision.title,
                        reasoning: editingDecision.reasoning,
                        alternativesConsidered: editingDecision.alternativesConsidered,
                        impactArea: editingDecision.impactArea,
                        decidedBy: editingDecision.decidedBy,
                        decidedAt: new Date(editingDecision.decidedAt),
                        relatedTaskIds: editingDecision.relatedTaskIds,
                        tags: editingDecision.tags,
                    }}
                    isEdit
                    tasks={tasks}
                    existingTags={existingTags}
                />
            )}

            {/* Supersede dialog */}
            {supersedingDecision && (
                <DecisionForm
                    open={!!supersedingDecision}
                    onOpenChange={(open) => !open && setSupersedingDecision(null)}
                    onSubmit={handleSupersedeDecision}
                    initialValues={{
                        impactArea: supersedingDecision.impactArea,
                        relatedTaskIds: supersedingDecision.relatedTaskIds,
                        tags: supersedingDecision.tags,
                    }}
                    tasks={tasks}
                    existingTags={existingTags}
                />
            )}

            {/* Reverse dialog */}
            <Dialog open={!!reversingDecision} onOpenChange={(open) => !open && setReversingDecision(null)}>
                <DialogContent className="sm:max-w-[450px] bg-card border-border/50">
                    <DialogHeader>
                        <DialogTitle className="text-xl flex items-center gap-2">
                            <XCircle className="h-5 w-5 text-rose-400" />
                            Reverse Decision
                        </DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20">
                            <p className="text-sm font-medium">{reversingDecision?.title}</p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="reversal-reason" className="text-sm font-medium">
                                Why is this decision being reversed? <span className="text-red-400">*</span>
                            </Label>
                            <Textarea
                                id="reversal-reason"
                                value={reversalReason}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                    setReversalReason(e.target.value)
                                }
                                placeholder="Explain why this decision no longer applies..."
                                className="bg-background/50 min-h-[100px] resize-none"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setReversingDecision(null);
                                setReversalReason("");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleReverseDecision}
                            disabled={!reversalReason.trim()}
                            className="bg-rose-600 hover:bg-rose-700"
                        >
                            Reverse Decision
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Chain view dialog */}
            <Dialog open={!!chainViewDecision} onOpenChange={(open) => !open && setChainViewDecision(null)}>
                <DialogContent className="sm:max-w-[500px] bg-card border-border/50 max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="text-xl">Decision Chain</DialogTitle>
                    </DialogHeader>

                    <SupersededChain
                        chain={chain}
                        onSelectDecision={(id) => {
                            const d = decisions.find((dec) => dec.id === id);
                            if (d) {
                                setChainViewDecision(null);
                                setEditingDecision(d);
                            }
                        }}
                    />

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setChainViewDecision(null)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/**
 * Empty state component
 */
function EmptyState({
    activeTab,
    hasSearch,
    hasFilter,
    onAddDecision,
}: {
    activeTab: TabValue;
    hasSearch: boolean;
    hasFilter: boolean;
    onAddDecision: () => void;
}) {
    const getMessage = () => {
        if (hasSearch || hasFilter) {
            return {
                title: "No matching decisions",
                description: "Try adjusting your search or filters.",
            };
        }

        switch (activeTab) {
            case "active":
                return {
                    title: "No active decisions",
                    description: "Record your first decision to prevent re-debating settled topics.",
                };
            case "superseded":
                return {
                    title: "No superseded decisions",
                    description: "Decisions that have been replaced by newer ones will appear here.",
                };
            case "reversed":
                return {
                    title: "No reversed decisions",
                    description: "Decisions that have been undone will appear here.",
                };
            default:
                return {
                    title: "No decisions yet",
                    description: "Start documenting your decisions to keep a record of why choices were made.",
                };
        }
    };

    const message = getMessage();

    return (
        <div className="flex flex-col items-center justify-center py-24 px-6">
            {/* Decorative element */}
            <div
                className={cn(
                    "relative w-32 h-32 mb-8",
                    "flex items-center justify-center",
                    "rounded-full",
                    "bg-gradient-to-br from-purple-500/10 to-purple-500/5",
                    "border border-purple-500/20",
                    "animate-pulse-glow"
                )}
            >
                <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple" />
                <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple-delayed" />
                <Scale className="h-12 w-12 text-purple-400/50" />
            </div>

            {/* Text */}
            <h2 className="text-xl font-semibold text-foreground/70 mb-2">{message.title}</h2>
            <p className="text-muted-foreground text-center max-w-md mb-8">{message.description}</p>

            {/* CTA Button */}
            {!hasSearch && !hasFilter && activeTab !== "superseded" && activeTab !== "reversed" && (
                <Button onClick={onAddDecision} size="lg" className="gap-3 bg-purple-600 hover:bg-purple-700">
                    <Plus className="h-5 w-5" />
                    Record your first decision
                </Button>
            )}
        </div>
    );
}
