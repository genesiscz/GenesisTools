// Ambient declarations for Metro-bundled binary assets imported via `require(...)`. Metro turns a
// `require("*.ttf")` into a numeric asset id (or an asset descriptor); these declarations just let
// `tsc` type-check the import. victory-native's `useFont` / Skia's font loader accept this value.
declare module "*.ttf" {
    const asset: number;
    export default asset;
}

declare module "*.otf" {
    const asset: number;
    export default asset;
}
