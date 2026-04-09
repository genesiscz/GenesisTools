import { ChevronRight } from "lucide-react";
import { LangPill } from "./lang-pill";

interface LanguageSelectorProps {
    from: { flag?: string; name: string };
    to: { flag?: string; name: string };
    onSwap?: () => void;
}

export function LanguageSelector({ from, to, onSwap }: LanguageSelectorProps) {
    return (
        <div className="flex items-center gap-3">
            <LangPill active onClick={onSwap}>
                {from.flag && <span>{from.flag}</span>}
                <span>{from.name}</span>
            </LangPill>
            <ChevronRight size={14} className="text-muted-foreground/50" />
            <LangPill onClick={onSwap}>
                {to.flag && <span>{to.flag}</span>}
                <span>{to.name}</span>
            </LangPill>
        </div>
    );
}
