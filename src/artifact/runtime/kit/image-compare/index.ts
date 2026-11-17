// ImageCompare's public exports; the kit index re-exports this list.

export {
    type ImageComparePage,
    ImageCompareProvider,
    type ImageCompareProviderProps,
    useImageCompare,
} from "./context";
export {
    type CompareRegion,
    DEFAULT_DIFF_THRESHOLD,
    diffImages,
    diffSummary,
    IMAGE_DIFF_COLOR,
    type ImageCompareItem,
    type ImageCompareSide,
    type ImageDiff,
    padToCommonSize,
    type RgbaImage,
} from "./core";
export {
    ImageCompare,
    ImageCompareModeSwitch,
    type ImageCompareModeSwitchProps,
    type ImageCompareProps,
} from "./image-compare";
export { loadImagePixels, type PixelError, type PixelLoad } from "./load";
export { COMPARE_MODES } from "./registry";
export type { CompareImage, CompareMode, CompareStageProps, PixelState } from "./stage";
