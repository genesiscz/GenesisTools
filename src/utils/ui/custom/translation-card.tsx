import { ArrowDown } from "lucide-react";
import { LanguageSelector } from "./language-selector";

interface TranslationCardProps {
    sourceLang: { flag?: string; name: string };
    targetLang: { flag?: string; name: string };
    detectedText: string;
    translatedText: string;
}

export function TranslationCard({ sourceLang, targetLang, detectedText, translatedText }: TranslationCardProps) {
    return (
        <div className="space-y-3">
            <LanguageSelector from={sourceLang} to={targetLang} />
            <div className="bg-background/60 rounded-xl p-3 border border-border/50">
                <p className="text-xs text-muted-foreground leading-relaxed">{detectedText}</p>
            </div>
            <div className="flex items-center justify-center">
                <div className="size-7 rounded-full bg-orange-500/10 flex items-center justify-center">
                    <ArrowDown size={14} className="text-orange-500" />
                </div>
            </div>
            <div className="bg-background/60 rounded-xl p-3 border border-orange-500/20">
                <p className="text-xs text-foreground leading-relaxed">{translatedText}</p>
            </div>
        </div>
    );
}
