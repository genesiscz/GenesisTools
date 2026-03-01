import { AlertTriangle, CalendarClock, Check, ChevronRight, Scissors, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DeadlineRiskOption } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

/**
 * Resolution option configuration
 */
interface ResolutionOption {
    id: DeadlineRiskOption;
    title: string;
    description: string;
    icon: typeof CalendarClock;
    colorClass: string;
    bgClass: string;
    borderClass: string;
    glowColor: string;
}

const resolutionOptions: ResolutionOption[] = [
    {
        id: "extend",
        title: "Extend Deadline",
        description: "Request more time from stakeholders",
        icon: CalendarClock,
        colorClass: "text-blue-400",
        bgClass: "bg-blue-500/10",
        borderClass: "border-blue-500/30 hover:border-blue-500/60",
        glowColor: "rgba(59, 130, 246, 0.3)",
    },
    {
        id: "help",
        title: "Get Help",
        description: "Pair program or get assistance",
        icon: Users,
        colorClass: "text-purple-400",
        bgClass: "bg-purple-500/10",
        borderClass: "border-purple-500/30 hover:border-purple-500/60",
        glowColor: "rgba(168, 85, 247, 0.3)",
    },
    {
        id: "scope",
        title: "Cut Scope",
        description: "Reduce deliverables to hit deadline",
        icon: Scissors,
        colorClass: "text-amber-400",
        bgClass: "bg-amber-500/10",
        borderClass: "border-amber-500/30 hover:border-amber-500/60",
        glowColor: "rgba(245, 158, 11, 0.3)",
    },
    {
        id: "accept",
        title: "Accept Risk",
        description: "Acknowledge delay and continue",
        icon: AlertTriangle,
        colorClass: "text-red-400",
        bgClass: "bg-red-500/10",
        borderClass: "border-red-500/30 hover:border-red-500/60",
        glowColor: "rgba(239, 68, 68, 0.3)",
    },
];

interface EscalationOptionsProps {
    recommendedOption: DeadlineRiskOption;
    selectedOption: DeadlineRiskOption | null;
    onSelectOption: (option: DeadlineRiskOption) => void;
    onConfirm: (data: EscalationResolutionData) => void;
    className?: string;
}

export interface EscalationResolutionData {
    option: DeadlineRiskOption;
    newDeadline?: Date;
    helperName?: string;
    helperNotes?: string;
    scopeItems?: string[];
    acceptanceNote?: string;
}

/**
 * EscalationOptions - Resolution option cards for deadline risk
 *
 * Displays 4 options for handling a deadline at risk:
 * - Extend: Request deadline extension
 * - Help: Get assistance from team
 * - Scope: Cut features to hit deadline
 * - Accept: Acknowledge and continue
 */
export function EscalationOptions({
    recommendedOption,
    selectedOption,
    onSelectOption,
    onConfirm,
    className,
}: EscalationOptionsProps) {
    const [resolutionData, setResolutionData] = useState<Partial<EscalationResolutionData>>({});

    function handleConfirm() {
        if (!selectedOption) {
            return;
        }

        onConfirm({
            option: selectedOption,
            ...resolutionData,
        });
    }

    return (
        <div className={cn("space-y-4", className)}>
            {/* Option Cards */}
            <div className="grid grid-cols-2 gap-3">
                {resolutionOptions.map((option) => {
                    const Icon = option.icon;
                    const isSelected = selectedOption === option.id;
                    const isRecommended = recommendedOption === option.id;

                    return (
                        <button
                            key={option.id}
                            onClick={() => onSelectOption(option.id)}
                            className={cn(
                                "relative p-4 rounded-lg border text-left transition-all duration-200",
                                "hover:scale-[1.02]",
                                option.bgClass,
                                option.borderClass,
                                isSelected && "ring-2 ring-offset-2 ring-offset-background",
                                isSelected && option.id === "extend" && "ring-blue-500",
                                isSelected && option.id === "help" && "ring-purple-500",
                                isSelected && option.id === "scope" && "ring-amber-500",
                                isSelected && option.id === "accept" && "ring-red-500"
                            )}
                            style={{
                                boxShadow: isSelected ? `0 0 20px ${option.glowColor}` : undefined,
                            }}
                        >
                            {/* Recommended badge */}
                            {isRecommended && (
                                <div
                                    className={cn(
                                        "absolute -top-2 -right-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                                        "bg-gradient-to-r from-cyan-500 to-purple-500 text-white",
                                        "animate-pulse shadow-lg shadow-purple-500/30"
                                    )}
                                >
                                    Recommended
                                </div>
                            )}

                            {/* Selected indicator */}
                            {isSelected && (
                                <div
                                    className={cn(
                                        "absolute top-2 right-2 h-5 w-5 rounded-full flex items-center justify-center",
                                        option.bgClass,
                                        "border",
                                        option.borderClass
                                    )}
                                >
                                    <Check className={cn("h-3 w-3", option.colorClass)} />
                                </div>
                            )}

                            <div className="flex items-start gap-3">
                                <div className={cn("p-2 rounded-lg", option.bgClass, "border", option.borderClass)}>
                                    <Icon className={cn("h-5 w-5", option.colorClass)} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h4 className={cn("font-semibold", option.colorClass)}>{option.title}</h4>
                                    <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* Dynamic form based on selected option */}
            {selectedOption && (
                <div className="mt-6 p-4 rounded-lg bg-muted/50 border border-muted-foreground/20 animate-fade-in">
                    {selectedOption === "extend" && <ExtendForm value={resolutionData} onChange={setResolutionData} />}
                    {selectedOption === "help" && <HelpForm value={resolutionData} onChange={setResolutionData} />}
                    {selectedOption === "scope" && <ScopeForm value={resolutionData} onChange={setResolutionData} />}
                    {selectedOption === "accept" && <AcceptForm value={resolutionData} onChange={setResolutionData} />}

                    <Button
                        onClick={handleConfirm}
                        className={cn(
                            "w-full mt-4 gap-2",
                            selectedOption === "extend" && "bg-blue-600 hover:bg-blue-700",
                            selectedOption === "help" && "bg-purple-600 hover:bg-purple-700",
                            selectedOption === "scope" && "bg-amber-600 hover:bg-amber-700",
                            selectedOption === "accept" && "bg-red-600 hover:bg-red-700"
                        )}
                    >
                        Confirm Resolution
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    );
}

/**
 * Form for extending deadline
 */
function ExtendForm({
    value,
    onChange,
}: {
    value: Partial<EscalationResolutionData>;
    onChange: (data: Partial<EscalationResolutionData>) => void;
}) {
    return (
        <div className="space-y-3">
            <div>
                <Label htmlFor="newDeadline" className="text-sm font-medium">
                    New Deadline
                </Label>
                <Input
                    id="newDeadline"
                    type="date"
                    className="mt-1.5"
                    value={value.newDeadline ? value.newDeadline.toISOString().split("T")[0] : ""}
                    onChange={(e) =>
                        onChange({
                            ...value,
                            newDeadline: e.target.value ? new Date(e.target.value) : undefined,
                        })
                    }
                />
            </div>
            <p className="text-xs text-muted-foreground">
                Choose a realistic new deadline. Consider adding buffer time.
            </p>
        </div>
    );
}

/**
 * Form for getting help
 */
function HelpForm({
    value,
    onChange,
}: {
    value: Partial<EscalationResolutionData>;
    onChange: (data: Partial<EscalationResolutionData>) => void;
}) {
    return (
        <div className="space-y-3">
            <div>
                <Label htmlFor="helperName" className="text-sm font-medium">
                    Who can help?
                </Label>
                <Input
                    id="helperName"
                    placeholder="Team member name or @mention"
                    className="mt-1.5"
                    value={value.helperName ?? ""}
                    onChange={(e) => onChange({ ...value, helperName: e.target.value })}
                />
            </div>
            <div>
                <Label htmlFor="helperNotes" className="text-sm font-medium">
                    What do you need help with?
                </Label>
                <Textarea
                    id="helperNotes"
                    placeholder="Specific areas where assistance would help..."
                    className="mt-1.5 min-h-[80px]"
                    value={value.helperNotes ?? ""}
                    onChange={(e) => onChange({ ...value, helperNotes: e.target.value })}
                />
            </div>
        </div>
    );
}

/**
 * Form for cutting scope
 */
function ScopeForm({
    value,
    onChange,
}: {
    value: Partial<EscalationResolutionData>;
    onChange: (data: Partial<EscalationResolutionData>) => void;
}) {
    const [newItem, setNewItem] = useState("");
    const scopeItems = value.scopeItems ?? [];

    function addItem() {
        if (!newItem.trim()) {
            return;
        }
        onChange({
            ...value,
            scopeItems: [...scopeItems, newItem.trim()],
        });
        setNewItem("");
    }

    function removeItem(index: number) {
        onChange({
            ...value,
            scopeItems: scopeItems.filter((_, i) => i !== index),
        });
    }

    return (
        <div className="space-y-3">
            <Label className="text-sm font-medium">Features to cut or defer</Label>
            <div className="flex gap-2">
                <Input
                    placeholder="Feature or requirement to cut..."
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addItem()}
                />
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                    Add
                </Button>
            </div>
            {scopeItems.length > 0 && (
                <ul className="space-y-1.5">
                    {scopeItems.map((item, index) => (
                        <li
                            key={index}
                            className="flex items-center gap-2 text-sm p-2 rounded bg-amber-500/10 border border-amber-500/20"
                        >
                            <Scissors className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            <span className="flex-1 text-amber-200 line-through opacity-70">{item}</span>
                            <button
                                type="button"
                                onClick={() => removeItem(index)}
                                className="text-muted-foreground hover:text-red-400"
                            >
                                &times;
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-xs text-muted-foreground">List features that can be deferred to a future release.</p>
        </div>
    );
}

/**
 * Form for accepting risk
 */
function AcceptForm({
    value,
    onChange,
}: {
    value: Partial<EscalationResolutionData>;
    onChange: (data: Partial<EscalationResolutionData>) => void;
}) {
    return (
        <div className="space-y-3">
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                    <div>
                        <h5 className="text-sm font-medium text-red-400">Accepting Risk</h5>
                        <p className="text-xs text-red-300/70 mt-1">
                            By accepting this risk, you acknowledge the deadline may be missed. This should be
                            communicated to stakeholders.
                        </p>
                    </div>
                </div>
            </div>
            <div>
                <Label htmlFor="acceptanceNote" className="text-sm font-medium">
                    Acknowledgment note (optional)
                </Label>
                <Textarea
                    id="acceptanceNote"
                    placeholder="Reason for accepting risk, mitigation plans..."
                    className="mt-1.5 min-h-[80px]"
                    value={value.acceptanceNote ?? ""}
                    onChange={(e) => onChange({ ...value, acceptanceNote: e.target.value })}
                />
            </div>
        </div>
    );
}
