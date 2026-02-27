declare module "asciichart" {
    interface PlotOptions {
        height?: number;
        width?: number;
        min?: number;
        max?: number;
        offset?: number;
        padding?: string;
        format?: (value: number) => string;
        colors?: string[];
    }

    function plot(data: number[] | number[][], options?: PlotOptions): string;

    const red: string;
    const green: string;
    const blue: string;
    const yellow: string;
    const cyan: string;
    const magenta: string;
    const white: string;
    const reset: string;

    export { plot, red, green, blue, yellow, cyan, magenta, white, reset };
    export default { plot, red, green, blue, yellow, cyan, magenta, white, reset };
}
