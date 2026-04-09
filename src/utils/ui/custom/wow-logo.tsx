import { cn } from "@ui/lib/utils";

interface WowLogoProps {
    className?: string;
}

export function WowLogo({ className }: WowLogoProps) {
    return (
        <svg className={cn("size-6", className)} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden focusable="false">
            <path
                d="M7 5L3 12L7 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M14 5L10 12L14 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M21 5L17 12L21 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.5"
            />
        </svg>
    );
}
