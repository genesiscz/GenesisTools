import { DISPOSITIONS, PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import type { SavePropertyInput } from "@app/Internal/commands/reas/lib/store";
import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";

interface AddPropertyFormProps {
    districts: string[];
    onAdd: (input: SavePropertyInput) => Promise<void>;
}

export function AddPropertyForm({ districts, onAdd }: AddPropertyFormProps) {
    const [open, setOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [name, setName] = useState("");
    const [district, setDistrict] = useState("");
    const [constructionType, setConstructionType] = useState("brick");
    const [disposition, setDisposition] = useState("all");
    const [targetPrice, setTargetPrice] = useState("");
    const [targetArea, setTargetArea] = useState("");
    const [monthlyRent, setMonthlyRent] = useState("");
    const [monthlyCosts, setMonthlyCosts] = useState("");
    const [notes, setNotes] = useState("");

    const resetForm = useCallback(() => {
        setName("");
        setDistrict("");
        setConstructionType("brick");
        setDisposition("all");
        setTargetPrice("");
        setTargetArea("");
        setMonthlyRent("");
        setMonthlyCosts("");
        setNotes("");
    }, []);

    const canSubmit = name.trim() && district && constructionType;

    const handleSubmit = useCallback(async () => {
        if (!canSubmit) {
            return;
        }

        setSubmitting(true);

        try {
            await onAdd({
                name: name.trim(),
                district,
                constructionType,
                disposition: disposition && disposition !== "all" ? disposition : undefined,
                targetPrice: Number(targetPrice) || 0,
                targetArea: Number(targetArea) || 0,
                monthlyRent: Number(monthlyRent) || 0,
                monthlyCosts: Number(monthlyCosts) || 0,
                notes: notes.trim() || undefined,
            });

            resetForm();
            setOpen(false);
        } finally {
            setSubmitting(false);
        }
    }, [
        canSubmit,
        name,
        district,
        constructionType,
        disposition,
        targetPrice,
        targetArea,
        monthlyRent,
        monthlyCosts,
        notes,
        onAdd,
        resetForm,
    ]);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 font-mono text-xs"
                >
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                    Add Property
                </Button>
            </DialogTrigger>

            <DialogContent className="bg-[#0a0a14] border-amber-500/20 max-w-lg">
                <DialogHeader>
                    <DialogTitle className="font-mono text-amber-400">Add Property to Watchlist</DialogTitle>
                    <DialogDescription className="font-mono text-gray-500 text-xs">
                        Track a property for recurring analysis
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    {/* Name */}
                    <div>
                        <label htmlFor="prop-name" className="block text-[10px] font-mono text-gray-500 mb-1">
                            Name *
                        </label>
                        <Input
                            id="prop-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="My apartment in Praha 2"
                            className="h-8 text-xs font-mono bg-black/20 border-white/10"
                        />
                    </div>

                    {/* District */}
                    <div>
                        <label htmlFor="prop-district" className="block text-[10px] font-mono text-gray-500 mb-1">
                            District *
                        </label>
                        <select
                            id="prop-district"
                            value={district}
                            onChange={(e) => setDistrict(e.target.value)}
                            className="w-full h-8 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                        >
                            <option value="">Select district...</option>
                            {districts.map((d) => (
                                <option key={d} value={d}>
                                    {d}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Type + Disposition */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="prop-type" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Property Type *
                            </label>
                            <select
                                id="prop-type"
                                value={constructionType}
                                onChange={(e) => setConstructionType(e.target.value)}
                                className="w-full h-8 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                            >
                                {PROPERTY_TYPES.map((t) => (
                                    <option key={t.value} value={t.value}>
                                        {t.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="prop-disp" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Disposition
                            </label>
                            <select
                                id="prop-disp"
                                value={disposition}
                                onChange={(e) => setDisposition(e.target.value)}
                                className="w-full h-8 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                            >
                                {DISPOSITIONS.map((d) => (
                                    <option key={d.value} value={d.value}>
                                        {d.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Price + Area */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="prop-price" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Price (CZK)
                            </label>
                            <Input
                                id="prop-price"
                                type="number"
                                value={targetPrice}
                                onChange={(e) => setTargetPrice(e.target.value)}
                                placeholder="5000000"
                                className="h-8 text-xs font-mono bg-black/20 border-white/10"
                            />
                        </div>
                        <div>
                            <label htmlFor="prop-area" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Area (m2)
                            </label>
                            <Input
                                id="prop-area"
                                type="number"
                                value={targetArea}
                                onChange={(e) => setTargetArea(e.target.value)}
                                placeholder="80"
                                className="h-8 text-xs font-mono bg-black/20 border-white/10"
                            />
                        </div>
                    </div>

                    {/* Rent + Costs */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="prop-rent" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Monthly Rent (CZK)
                            </label>
                            <Input
                                id="prop-rent"
                                type="number"
                                value={monthlyRent}
                                onChange={(e) => setMonthlyRent(e.target.value)}
                                placeholder="15000"
                                className="h-8 text-xs font-mono bg-black/20 border-white/10"
                            />
                        </div>
                        <div>
                            <label htmlFor="prop-costs" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Monthly Costs (CZK)
                            </label>
                            <Input
                                id="prop-costs"
                                type="number"
                                value={monthlyCosts}
                                onChange={(e) => setMonthlyCosts(e.target.value)}
                                placeholder="5000"
                                className="h-8 text-xs font-mono bg-black/20 border-white/10"
                            />
                        </div>
                    </div>

                    {/* Notes */}
                    <div>
                        <label htmlFor="prop-notes" className="block text-[10px] font-mono text-gray-500 mb-1">
                            Notes
                        </label>
                        <textarea
                            id="prop-notes"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Optional notes about the property..."
                            rows={2}
                            className="w-full rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-3 py-2 resize-none"
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        onClick={handleSubmit}
                        disabled={!canSubmit || submitting}
                        className="bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 font-mono text-xs"
                    >
                        {submitting ? (
                            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        ) : (
                            <Plus className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        Add to Watchlist
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
