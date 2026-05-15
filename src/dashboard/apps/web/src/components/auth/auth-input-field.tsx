import { cn } from "@ui/lib/utils";
import type React from "react";

interface AuthInputFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
    icon?: React.ReactNode;
    label?: string;
    description?: string;
    error?: string;
    id: string;
}

/**
 * AuthInputField — neon amber-bordered input with optional leading icon.
 * Matches the amber-500/20 auth form aesthetic across all auth routes.
 */
export function AuthInputField({
    icon,
    label,
    description,
    error,
    id,
    className,
    ...props
}: AuthInputFieldProps) {
    return (
        <div className="space-y-2">
            {label && (
                <label htmlFor={id} className="text-sm font-medium text-gray-300 block">
                    {label}
                </label>
            )}
            <div className="relative">
                {icon && (
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none flex items-center justify-center">
                        {icon}
                    </span>
                )}
                <input
                    id={id}
                    className={cn(
                        "w-full h-11 pr-4 rounded-lg bg-[#1a1a1f] border border-amber-500/20",
                        "focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 outline-none",
                        "transition-all placeholder:text-gray-600 text-white",
                        icon ? "pl-10" : "pl-4",
                        error && "border-red-500/50 focus:border-red-500/70 focus:ring-red-500/20",
                        className
                    )}
                    {...props}
                />
            </div>
            {description && !error && (
                <p className="text-xs text-gray-500">{description}</p>
            )}
            {error && (
                <p className="text-xs text-red-400">{error}</p>
            )}
        </div>
    );
}
