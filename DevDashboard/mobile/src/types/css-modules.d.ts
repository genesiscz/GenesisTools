// Ambient declaration for CSS-module imports used by `.web.tsx` components (react-native-web).
// Native bundles never load these; the declaration just lets `tsc` type-check the web variants.
declare module "*.module.css" {
    const classes: { readonly [key: string]: string };
    export default classes;
}
