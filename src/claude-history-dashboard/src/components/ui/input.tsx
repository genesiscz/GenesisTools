import type * as React from "react";

import { cn } from "@/lib/utils";

type InputVariant = "default" | "cyber";

interface InputProps extends React.ComponentProps<"input"> {
	variant?: InputVariant;
}

const inputVariants: Record<InputVariant, string> = {
	default: "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50",
	cyber: "glass-card neon-border border-primary/30 bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-primary/30",
};

function Input({ className, type, variant = "cyber", ...props }: InputProps) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				"focus-visible:ring-[3px]",
				"aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
				inputVariants[variant],
				className
			)}
			{...props}
		/>
	);
}

export { Input };
