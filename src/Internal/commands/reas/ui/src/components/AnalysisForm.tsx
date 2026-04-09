import { buildPeriodOptions, DISPOSITIONS, PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { DistrictCommandSelect } from "@ui/components/command";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { Building2, Calendar, DollarSign, Home, Loader2, Maximize2, Ruler, Search, Wallet } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

interface AnalysisFormData {
    district: string;
    type: string;
    disposition: string;
    periods: string[];
    price: string;
    area: string;
    rent: string;
    monthlyCosts: string;
}

interface AnalysisFormProps {
    onSubmit: (data: AnalysisFormData) => void;
    isLoading: boolean;
}

interface FieldErrors {
    district?: boolean;
    type?: boolean;
    price?: boolean;
    area?: boolean;
}

export type { AnalysisFormData };

export function AnalysisForm({ onSubmit, isLoading }: AnalysisFormProps) {
    const periodOptions = useMemo(() => buildPeriodOptions(), []);

    const [form, setForm] = useState<AnalysisFormData>({
        district: "",
        type: "",
        disposition: "all",
        periods: [periodOptions[0].value],
        price: "",
        area: "",
        rent: "",
        monthlyCosts: "",
    });

    const [errors, setErrors] = useState<FieldErrors>({});
    const [attempted, setAttempted] = useState(false);

    const updateField = useCallback(
        <K extends keyof AnalysisFormData>(key: K, value: AnalysisFormData[K]) => {
            setForm((prev) => ({ ...prev, [key]: value }));

            if (attempted) {
                setErrors((prev) => ({ ...prev, [key]: false }));
            }
        },
        [attempted]
    );

    const togglePeriod = useCallback((period: string) => {
        setForm((prev) => {
            const current = prev.periods;
            const next = current.includes(period) ? current.filter((p) => p !== period) : [...current, period];
            return { ...prev, periods: next.length > 0 ? next : current };
        });
    }, []);

    const handleSubmit = useCallback(() => {
        setAttempted(true);

        const newErrors: FieldErrors = {
            district: !form.district,
            type: !form.type,
            price: !form.price || Number(form.price) <= 0,
            area: !form.area || Number(form.area) <= 0,
        };

        setErrors(newErrors);

        if (Object.values(newErrors).some(Boolean)) {
            return;
        }

        onSubmit(form);
    }, [form, onSubmit]);

    return (
        <Card className="border-white/5">
            <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                    <Search className="h-4 w-4 text-amber-400" />
                    Analysis Parameters
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
                {/* District */}
                <FormField label="District" icon={<Home className="h-3.5 w-3.5" />} required error={errors.district}>
                    <DistrictCommandSelect
                        value={form.district}
                        onValueChange={(v) => updateField("district", v)}
                        error={errors.district}
                    />
                </FormField>

                {/* Property Type */}
                <FormField
                    label="Property Type"
                    icon={<Building2 className="h-3.5 w-3.5" />}
                    required
                    error={errors.type}
                >
                    <div className="flex gap-2">
                        {PROPERTY_TYPES.map((pt) => (
                            <button
                                key={pt.value}
                                type="button"
                                onClick={() => updateField("type", pt.value)}
                                className={cn(
                                    "flex-1 rounded-md border px-3 py-1.5 text-xs font-mono transition-all",
                                    form.type === pt.value
                                        ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                                        : "border-white/10 bg-transparent text-gray-400 hover:border-white/20 hover:text-gray-300",
                                    errors.type && !form.type && "border-red-500/30"
                                )}
                            >
                                {pt.label}
                            </button>
                        ))}
                    </div>
                </FormField>

                {/* Disposition */}
                <FormField label="Disposition" icon={<Maximize2 className="h-3.5 w-3.5" />}>
                    <div className="flex flex-wrap gap-1.5">
                        {DISPOSITIONS.map((d) => (
                            <button
                                key={d.value}
                                type="button"
                                onClick={() => updateField("disposition", d.value)}
                                className={cn(
                                    "rounded-md border px-2.5 py-1 text-xs font-mono transition-all",
                                    form.disposition === d.value
                                        ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-400"
                                        : "border-white/10 bg-transparent text-gray-500 hover:border-white/20 hover:text-gray-400"
                                )}
                            >
                                {d.label}
                            </button>
                        ))}
                    </div>
                </FormField>

                {/* Period */}
                <FormField label="Period" icon={<Calendar className="h-3.5 w-3.5" />}>
                    <div className="flex flex-wrap gap-1.5">
                        {periodOptions.map((p) => (
                            <button
                                key={p.value}
                                type="button"
                                onClick={() => togglePeriod(p.value)}
                                className={cn(
                                    "rounded-md border px-2.5 py-1 text-xs font-mono transition-all",
                                    form.periods.includes(p.value)
                                        ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                                        : "border-white/10 bg-transparent text-gray-500 hover:border-white/20 hover:text-gray-400"
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                </FormField>

                {/* Price & Area row */}
                <div className="grid grid-cols-2 gap-4">
                    <FormField
                        label="Price"
                        icon={<DollarSign className="h-3.5 w-3.5" />}
                        required
                        error={errors.price}
                        suffix="CZK"
                    >
                        <Input
                            type="number"
                            placeholder="4 500 000"
                            value={form.price}
                            onChange={(e) => updateField("price", e.target.value)}
                            className={cn(
                                "font-mono text-xs",
                                errors.price && "border-red-500/50 ring-2 ring-red-500/20"
                            )}
                        />
                    </FormField>

                    <FormField
                        label="Area"
                        icon={<Ruler className="h-3.5 w-3.5" />}
                        required
                        error={errors.area}
                        suffix="m²"
                    >
                        <Input
                            type="number"
                            placeholder="65"
                            value={form.area}
                            onChange={(e) => updateField("area", e.target.value)}
                            className={cn(
                                "font-mono text-xs",
                                errors.area && "border-red-500/50 ring-2 ring-red-500/20"
                            )}
                        />
                    </FormField>
                </div>

                {/* Rent & Costs row */}
                <div className="grid grid-cols-2 gap-4">
                    <FormField label="Monthly Rent" icon={<Wallet className="h-3.5 w-3.5" />} suffix="CZK">
                        <Input
                            type="number"
                            placeholder="18 000"
                            value={form.rent}
                            onChange={(e) => updateField("rent", e.target.value)}
                            className="font-mono text-xs"
                        />
                    </FormField>

                    <FormField label="Monthly Costs" icon={<Wallet className="h-3.5 w-3.5" />} suffix="CZK">
                        <Input
                            type="number"
                            placeholder="3 500"
                            value={form.monthlyCosts}
                            onChange={(e) => updateField("monthlyCosts", e.target.value)}
                            className="font-mono text-xs"
                        />
                    </FormField>
                </div>

                {/* Submit */}
                <Button
                    variant="outline"
                    className="w-full font-mono text-sm gap-2 h-10 bg-amber-500/10 hover:bg-amber-500/15 border-amber-500/40 text-amber-400 hover:text-amber-300 hover:border-amber-500/60 shadow-[0_0_15px_rgba(245,158,11,0.08)] hover:shadow-[0_0_20px_rgba(245,158,11,0.15)] transition-all"
                    onClick={handleSubmit}
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Analyzing...
                        </>
                    ) : (
                        <>
                            <Search className="h-4 w-4" />
                            Run Analysis
                        </>
                    )}
                </Button>

                {attempted && Object.values(errors).some(Boolean) && (
                    <p className="text-xs text-red-400 font-mono text-center">Please fill in all required fields</p>
                )}
            </CardContent>
        </Card>
    );
}

interface FormFieldProps {
    label: string;
    icon: React.ReactNode;
    required?: boolean;
    error?: boolean;
    suffix?: string;
    children: React.ReactNode;
}

function FormField({ label, icon, required, error, suffix, children }: FormFieldProps) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
                <span className={cn("text-muted-foreground", error && "text-red-400")}>{icon}</span>
                <span className={cn("text-xs font-mono font-medium", error ? "text-red-400" : "text-gray-400")}>
                    {label}
                </span>
                {required && (
                    <Badge
                        variant="outline"
                        className={cn(
                            "text-[9px] px-1 py-0 h-3.5",
                            error ? "border-red-500/30 text-red-400" : "border-white/10 text-gray-600"
                        )}
                    >
                        required
                    </Badge>
                )}
                {suffix && <span className="ml-auto text-[10px] text-gray-600 font-mono">{suffix}</span>}
            </div>
            {children}
        </div>
    );
}
