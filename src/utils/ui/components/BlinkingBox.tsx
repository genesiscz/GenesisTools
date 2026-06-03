import { Slot } from "@radix-ui/react-slot";
import { cn } from "@ui/lib/utils";
import type { ComponentPropsWithoutRef, CSSProperties, ReactElement, ReactNode } from "react";

export type BlinkingBoxVariant = "amber-inset" | "cyan-inset" | "accent-glow";

const VARIANT_STYLE_ID = "ui-blinking-box-keyframes";

const VARIANT_KEYFRAMES: Record<BlinkingBoxVariant, string> = {
    "amber-inset": `@keyframes ui-blink-amber-inset {
  0%, 100% { background-color: transparent; box-shadow: none; }
  50% { background-color: rgba(251, 191, 36, 0.14); box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.5); }
}`,
    "cyan-inset": `@keyframes ui-blink-cyan-inset {
  0%, 100% { background-color: transparent; box-shadow: none; }
  50% { background-color: rgba(34, 211, 238, 0.1); box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.45); }
}`,
    "accent-glow": `@keyframes ui-blink-accent-glow {
  0%, 100% {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dd-accent-from, #a855f7) 55%, transparent);
    opacity: 1;
  }
  18%, 55% {
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, var(--dd-accent-from, #a855f7) 85%, transparent),
      0 0 22px color-mix(in srgb, var(--dd-accent-from, #a855f7) 35%, transparent);
    opacity: 1;
  }
}`,
};

function animationName(variant: BlinkingBoxVariant): string {
    if (variant === "amber-inset") {
        return "ui-blink-amber-inset";
    }

    if (variant === "cyan-inset") {
        return "ui-blink-cyan-inset";
    }

    return "ui-blink-accent-glow";
}

function BlinkingBoxKeyframes(): ReactElement {
    return (
        <style id={VARIANT_STYLE_ID}>
            {VARIANT_KEYFRAMES["amber-inset"]}
            {VARIANT_KEYFRAMES["cyan-inset"]}
            {VARIANT_KEYFRAMES["accent-glow"]}
        </style>
    );
}

export interface BlinkingBoxProps extends ComponentPropsWithoutRef<"div"> {
    active: boolean;
    children: ReactNode;
    variant?: BlinkingBoxVariant;
    iterations?: number;
    durationMs?: number;
    easing?: string;
    asChild?: boolean;
}

export function BlinkingBox({
    active,
    children,
    className,
    variant = "amber-inset",
    iterations = 4,
    durationMs = 550,
    easing = "ease-in-out",
    asChild = false,
    onAnimationEnd,
    style: styleProp,
    ...rest
}: BlinkingBoxProps): ReactElement {
    const Comp = asChild ? Slot : "div";
    const animationStyle: CSSProperties | undefined = active
        ? {
              animationName: animationName(variant),
              animationDuration: `${durationMs}ms`,
              animationTimingFunction: easing,
              animationIterationCount: iterations,
          }
        : undefined;

    const style: CSSProperties | undefined = animationStyle ? { ...styleProp, ...animationStyle } : styleProp;

    return (
        <>
            <BlinkingBoxKeyframes />
            <Comp
                {...rest}
                className={cn(className)}
                style={style}
                onAnimationEnd={active ? onAnimationEnd : undefined}
            >
                {children}
            </Comp>
        </>
    );
}
