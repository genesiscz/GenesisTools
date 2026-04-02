import { buildPeriodOptions, DISPOSITIONS, PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import type { SavePropertyInput } from "@app/Internal/commands/reas/lib/store";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { DistrictCommandSelect } from "@ui/components/command";
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";

interface AddPropertyFormProps {
    onAdd: (input: SavePropertyInput) => Promise<void>;
}

const PERIOD_OPTIONS = buildPeriodOptions();
const DEFAULT_PROVIDERS = ["reas", "sreality", "bezrealitky", "ereality", "mf"];
const PROVIDER_OPTIONS = [
    { value: "reas", label: "REAS sold" },
    { value: "sreality", label: "Sreality" },
    { value: "bezrealitky", label: "Bezrealitky" },
    { value: "ereality", label: "Ereality" },
    { value: "mf", label: "MF benchmark" },
] as const;

export function AddPropertyForm({ onAdd }: AddPropertyFormProps) {
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
    const [listingUrl, setListingUrl] = useState("");
    const [periods, setPeriods] = useState(PERIOD_OPTIONS[0]?.value ?? "");
    const [providers, setProviders] = useState<string[]>(DEFAULT_PROVIDERS);
    const [mortgageRate, setMortgageRate] = useState("");
    const [mortgageTerm, setMortgageTerm] = useState("");
    const [downPayment, setDownPayment] = useState("");
    const [loanAmount, setLoanAmount] = useState("");
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
        setListingUrl("");
        setPeriods(PERIOD_OPTIONS[0]?.value ?? "");
        setProviders(DEFAULT_PROVIDERS);
        setMortgageRate("");
        setMortgageTerm("");
        setDownPayment("");
        setLoanAmount("");
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
                periods: periods || undefined,
                providers: providers.length > 0 ? providers.join(",") : undefined,
                listingUrl: listingUrl.trim() || undefined,
                mortgageRate: Number(mortgageRate) || undefined,
                mortgageTerm: Number(mortgageTerm) || undefined,
                downPayment: Number(downPayment) || undefined,
                loanAmount: Number(loanAmount) || undefined,
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
        periods,
        providers,
        listingUrl,
        mortgageRate,
        mortgageTerm,
        downPayment,
        loanAmount,
        notes,
        onAdd,
        resetForm,
    ]);

    const toggleProvider = useCallback((provider: string, checked: boolean) => {
        setProviders((current) => {
            if (checked) {
                return current.includes(provider) ? current : [...current, provider];
            }

            return current.filter((value) => value !== provider);
        });
    }, []);

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

                    <div>
                        <label htmlFor="prop-district" className="block text-[10px] font-mono text-gray-500 mb-1">
                            District *
                        </label>
                        <DistrictCommandSelect
                            value={district}
                            onValueChange={setDistrict}
                            placeholder="Select district..."
                            shouldFilter={false}
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="prop-type" className="block text-[10px] font-mono text-gray-500 mb-1">
                                Property Type *
                            </label>
                            <select
                                id="prop-type"
                                value={constructionType}
                                onChange={(e) => setConstructionType(e.target.value)}
                                className="cyber-select"
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
                                className="cyber-select"
                            >
                                {DISPOSITIONS.map((d) => (
                                    <option key={d.value} value={d.value}>
                                        {d.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

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

                    <div>
                        <label htmlFor="prop-url" className="block text-[10px] font-mono text-gray-500 mb-1">
                            Listing URL
                        </label>
                        <Input
                            id="prop-url"
                            type="url"
                            value={listingUrl}
                            onChange={(e) => setListingUrl(e.target.value)}
                            placeholder="https://www.sreality.cz/..."
                            className="h-8 text-xs font-mono bg-black/20 border-white/10"
                        />
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                        <div>
                            <div className="mb-1 block text-[10px] font-mono text-gray-500">Analysis Period</div>
                            <Select value={periods} onValueChange={setPeriods}>
                                <SelectTrigger className="h-8 border-white/10 bg-black/20 text-xs font-mono text-gray-300">
                                    <SelectValue placeholder="Select period" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {PERIOD_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <div className="mb-1 block text-[10px] font-mono text-gray-500">Providers</div>
                            <div className="grid grid-cols-2 gap-2 rounded border border-white/10 bg-black/20 p-3">
                                {PROVIDER_OPTIONS.map((provider) => (
                                    <label
                                        key={provider.value}
                                        htmlFor={`provider-${provider.value}`}
                                        className="flex items-center gap-2 text-[11px] font-mono text-gray-300"
                                    >
                                        <Checkbox
                                            id={`provider-${provider.value}`}
                                            checked={providers.includes(provider.value)}
                                            onCheckedChange={(checked) => toggleProvider(provider.value, checked === true)}
                                        />
                                        <span>{provider.label}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="rounded border border-white/10 bg-black/10 p-3">
                        <div className="mb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-gray-500">
                            Mortgage
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                            <div>
                                <label htmlFor="prop-mortgage-rate" className="mb-1 block text-[10px] font-mono text-gray-500">
                                    Rate (%)
                                </label>
                                <Input
                                    id="prop-mortgage-rate"
                                    type="number"
                                    value={mortgageRate}
                                    onChange={(e) => setMortgageRate(e.target.value)}
                                    placeholder="4.29"
                                    className="h-8 border-white/10 bg-black/20 text-xs font-mono"
                                />
                            </div>
                            <div>
                                <label htmlFor="prop-mortgage-term" className="mb-1 block text-[10px] font-mono text-gray-500">
                                    Term (years)
                                </label>
                                <Input
                                    id="prop-mortgage-term"
                                    type="number"
                                    value={mortgageTerm}
                                    onChange={(e) => setMortgageTerm(e.target.value)}
                                    placeholder="30"
                                    className="h-8 border-white/10 bg-black/20 text-xs font-mono"
                                />
                            </div>
                            <div>
                                <label htmlFor="prop-down-payment" className="mb-1 block text-[10px] font-mono text-gray-500">
                                    Down payment (CZK)
                                </label>
                                <Input
                                    id="prop-down-payment"
                                    type="number"
                                    value={downPayment}
                                    onChange={(e) => setDownPayment(e.target.value)}
                                    placeholder="1000000"
                                    className="h-8 border-white/10 bg-black/20 text-xs font-mono"
                                />
                            </div>
                            <div>
                                <label htmlFor="prop-loan-amount" className="mb-1 block text-[10px] font-mono text-gray-500">
                                    Loan amount (CZK)
                                </label>
                                <Input
                                    id="prop-loan-amount"
                                    type="number"
                                    value={loanAmount}
                                    onChange={(e) => setLoanAmount(e.target.value)}
                                    placeholder="4000000"
                                    className="h-8 border-white/10 bg-black/20 text-xs font-mono"
                                />
                            </div>
                        </div>
                    </div>

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
