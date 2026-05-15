import { Label } from "@ui/components/label";
import { cn } from "@ui/lib/utils";
import type React from "react";

interface FormFieldProps {
    id?: string;
    label: React.ReactNode;
    required?: boolean;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

export function FormField({ id, label, required, hint, error, children, className }: FormFieldProps) {
    return (
        <div className={cn("space-y-2", className)}>
            <Label htmlFor={id}>
                {label}
                {required && <span className="text-red-400">*</span>}
            </Label>
            {children}
            {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
            {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
    );
}
