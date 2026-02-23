import { AlertTriangle, Ban, Edit2, Eye, ListChecks, Phone, Scale, Send, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { Decision, Task, TaskBlocker } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface HandoffPreviewProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    task: Task;
    recipient: string;
    contextNotes: string;
    decisions: Decision[];
    blockers: TaskBlocker[];
    nextSteps: string[];
    gotchas: string;
    contact: string;
    onConfirm: () => void;
    onEdit: () => void;
    isSubmitting?: boolean;
}

/**
 * Terminal-style preview badge
 */
function PreviewBadge({ label, value, color }: { label: string; value: string | number; color: string }) {
    return (
        <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono", color)}>
            <span className="opacity-70">{label}:</span>
            <span className="font-semibold">{value}</span>
        </div>
    );
}

/**
 * Section preview card
 */
function SectionPreview({
    icon: Icon,
    title,
    content,
    color,
    isEmpty,
}: {
    icon: typeof Terminal;
    title: string;
    content: React.ReactNode;
    color: string;
    isEmpty?: boolean;
}) {
    if (isEmpty) {
        return (
            <div className={cn("p-4 rounded-lg border border-dashed opacity-50", color)}>
                <div className="flex items-center gap-2 mb-2">
                    <Icon className="h-4 w-4" />
                    <span className="font-mono text-sm font-semibold">{title}</span>
                </div>
                <p className="text-xs text-muted-foreground italic">No content</p>
            </div>
        );
    }

    return (
        <div className={cn("p-4 rounded-lg border", color)}>
            <div className="flex items-center gap-2 mb-2">
                <Icon className="h-4 w-4" />
                <span className="font-mono text-sm font-semibold">{title}</span>
            </div>
            {content}
        </div>
    );
}

/**
 * HandoffPreview - Preview modal before sending handoff
 *
 * Shows a summary of the compiled handoff document with:
 * - Recipient information
 * - All sections preview
 * - Edit and Confirm buttons
 */
export function HandoffPreview({
    open,
    onOpenChange,
    task,
    recipient,
    contextNotes,
    decisions,
    blockers,
    nextSteps,
    gotchas,
    contact,
    onConfirm,
    onEdit,
    isSubmitting,
}: HandoffPreviewProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col bg-[#0a0a14]/95 border-cyan-500/30">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-cyan-400 font-mono">
                        <Eye className="h-5 w-5" />
                        Handoff Preview
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        Review the handoff document before sending to{" "}
                        <span className="text-emerald-400 font-semibold">{recipient}</span>
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto py-4 space-y-4">
                    {/* Header info */}
                    <div className="p-4 rounded-lg bg-black/30 border border-cyan-500/20">
                        <h3 className="text-lg font-bold text-cyan-400 font-mono mb-3">{task.title}</h3>
                        <div className="flex flex-wrap gap-2">
                            <PreviewBadge
                                label="From"
                                value="You"
                                color="bg-purple-500/10 text-purple-400 border border-purple-500/20"
                            />
                            <PreviewBadge
                                label="To"
                                value={recipient}
                                color="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            />
                            <PreviewBadge
                                label="Decisions"
                                value={decisions.length}
                                color="bg-purple-500/10 text-purple-400 border border-purple-500/20"
                            />
                            <PreviewBadge
                                label="Blockers"
                                value={blockers.length}
                                color="bg-rose-500/10 text-rose-400 border border-rose-500/20"
                            />
                            <PreviewBadge
                                label="Next Steps"
                                value={nextSteps.length}
                                color="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            />
                        </div>
                    </div>

                    {/* Sections preview */}
                    <div className="space-y-3">
                        {/* Context Notes */}
                        <SectionPreview
                            icon={Terminal}
                            title="Context Notes"
                            color="border-cyan-500/20 bg-cyan-500/5"
                            isEmpty={!contextNotes.trim()}
                            content={
                                <p className="text-sm font-mono text-foreground/80 line-clamp-4 whitespace-pre-wrap">
                                    {contextNotes}
                                </p>
                            }
                        />

                        {/* Decisions */}
                        <SectionPreview
                            icon={Scale}
                            title={`Decisions (${decisions.length})`}
                            color="border-purple-500/20 bg-purple-500/5"
                            isEmpty={decisions.length === 0}
                            content={
                                <div className="space-y-2">
                                    {decisions.slice(0, 3).map((dec) => (
                                        <div
                                            key={dec.id}
                                            className="text-sm font-mono p-2 rounded bg-black/20 text-foreground/80"
                                        >
                                            <span className="text-purple-400">{dec.title}</span>
                                            <span className="text-muted-foreground"> ({dec.impactArea})</span>
                                        </div>
                                    ))}
                                    {decisions.length > 3 && (
                                        <p className="text-xs text-muted-foreground">
                                            +{decisions.length - 3} more decisions
                                        </p>
                                    )}
                                </div>
                            }
                        />

                        {/* Blockers */}
                        <SectionPreview
                            icon={Ban}
                            title={`Blockers (${blockers.length})`}
                            color="border-rose-500/20 bg-rose-500/5"
                            isEmpty={blockers.length === 0}
                            content={
                                <div className="space-y-2">
                                    {blockers.map((blocker) => (
                                        <div
                                            key={blocker.id}
                                            className="text-sm font-mono p-2 rounded bg-black/20 text-foreground/80"
                                        >
                                            <span className="text-rose-400">{blocker.reason}</span>
                                            {blocker.blockerOwner && (
                                                <span className="text-muted-foreground">
                                                    {" "}
                                                    (owner: {blocker.blockerOwner})
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            }
                        />

                        {/* Next Steps */}
                        <SectionPreview
                            icon={ListChecks}
                            title={`Next Steps (${nextSteps.length})`}
                            color="border-emerald-500/20 bg-emerald-500/5"
                            isEmpty={nextSteps.length === 0}
                            content={
                                <div className="space-y-1">
                                    {nextSteps.slice(0, 5).map((step, index) => (
                                        <div key={index} className="flex items-start gap-2 text-sm font-mono">
                                            <div className="h-4 w-4 rounded border border-emerald-500/50 flex-shrink-0 mt-0.5" />
                                            <span className="text-foreground/80">{step}</span>
                                        </div>
                                    ))}
                                    {nextSteps.length > 5 && (
                                        <p className="text-xs text-muted-foreground">
                                            +{nextSteps.length - 5} more steps
                                        </p>
                                    )}
                                </div>
                            }
                        />

                        {/* Gotchas */}
                        <SectionPreview
                            icon={AlertTriangle}
                            title="Gotchas"
                            color="border-amber-500/20 bg-amber-500/5"
                            isEmpty={!gotchas.trim()}
                            content={
                                <p className="text-sm font-mono text-foreground/80 line-clamp-3 whitespace-pre-wrap">
                                    {gotchas}
                                </p>
                            }
                        />

                        {/* Contact */}
                        <SectionPreview
                            icon={Phone}
                            title="Contact"
                            color="border-cyan-500/20 bg-cyan-500/5"
                            isEmpty={!contact.trim()}
                            content={
                                <p className="text-sm font-mono text-foreground/80 whitespace-pre-wrap">{contact}</p>
                            }
                        />
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                        variant="outline"
                        onClick={onEdit}
                        className="gap-2 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                    >
                        <Edit2 className="h-4 w-4" />
                        Edit
                    </Button>
                    <Button
                        onClick={onConfirm}
                        disabled={isSubmitting}
                        className="gap-2 bg-cyan-600 hover:bg-cyan-700 text-white"
                    >
                        <Send className="h-4 w-4" />
                        {isSubmitting ? "Sending..." : "Send Handoff"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
