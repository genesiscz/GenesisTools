import { Button } from "@ui/components/button";
import { Loader2 } from "lucide-react";
import type React from "react";

interface OAuthButtonProps {
    provider: string;
    icon: React.ReactNode;
    loading?: boolean;
    disabled?: boolean;
    onClick?: () => void;
}

/**
 * OAuthButton — amber-bordered provider OAuth button for auth forms.
 * Shows a loading spinner while the provider redirect is in progress.
 */
export function OAuthButton({ provider, icon, loading = false, disabled = false, onClick }: OAuthButtonProps) {
    return (
        <Button
            type="button"
            variant="outline"
            className="w-full h-11 border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5 text-white"
            onClick={onClick}
            disabled={disabled || loading}
        >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <span className="mr-2">{icon}</span>}
            Continue with {provider}
        </Button>
    );
}
