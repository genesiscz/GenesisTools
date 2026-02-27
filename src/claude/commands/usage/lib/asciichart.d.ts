declare module "asciichart" {
    interface PlotOptions {
        height?: number;
        offset?: number;
        padding?: string;
        min?: number;
        max?: number;
        format?: (value: number) => string;
        colors?: string[];
    }

    function plot(data: number[] | number[][], options?: PlotOptions): string;

    const black: string;
    const red: string;
    const green: string;
    const yellow: string;
    const blue: string;
    const magenta: string;
    const cyan: string;
    const lightgray: string;
    const darkgray: string;
    const lightred: string;
    const lightgreen: string;
    const lightyellow: string;
    const lightblue: string;
    const lightmagenta: string;
    const lightcyan: string;
    const white: string;
    const reset: string;
    const defaultColor: string;

    export {
        plot,
        black, red, green, yellow, blue, magenta, cyan,
        lightgray, darkgray, lightred, lightgreen, lightyellow,
        lightblue, lightmagenta, lightcyan, white, reset, defaultColor,
    };
    export default {
        plot,
        black, red, green, yellow, blue, magenta, cyan,
        lightgray, darkgray, lightred, lightgreen, lightyellow,
        lightblue, lightmagenta, lightcyan, white, reset, defaultColor,
    };
}
