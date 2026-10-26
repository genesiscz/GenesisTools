import { Button } from "@ui/components/button";
import { cn } from "@ui/lib/utils";
import type React from "react";

// Not React.ElementType: its union of every HTML tag made each JSX use ~175k instantiations (see app-sidebar.tsx).
type IconComponent = React.ComponentType<{ className?: string }>;

interface FloatingActionButtonProps {
    icon: IconComponent;
    onClick: () => void;
    label: string;
    className?: string;
}

export function FloatingActionButton({ icon: Icon, onClick, label, className }: FloatingActionButtonProps) {
    return (
        <Button
            onClick={onClick}
            variant="brand"
            size="lg"
            aria-label={label}
            className={cn("fixed bottom-8 right-8 h-14 w-14 rounded-full p-0 z-50", className)}
        >
            <Icon className="h-6 w-6" />
        </Button>
    );
}
