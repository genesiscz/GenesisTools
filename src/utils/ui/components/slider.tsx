import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@ui/lib/utils";
import type * as React from "react";

function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
    return (
        <SliderPrimitive.Root
            data-slot="slider"
            className={cn("relative flex w-full touch-none items-center select-none", className)}
            {...props}
        >
            <SliderPrimitive.Track
                data-slot="slider-track"
                className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary/40"
            >
                <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
            </SliderPrimitive.Track>
            {props.value?.map((value, index) => (
                <SliderPrimitive.Thumb
                    key={`${index}-${value}`}
                    data-slot="slider-thumb"
                    className="block size-4 rounded-full border border-primary/60 bg-background shadow transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50"
                />
            ))}
        </SliderPrimitive.Root>
    );
}

export { Slider };
