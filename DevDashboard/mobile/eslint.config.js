// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // `e2e/` has its own tsconfig (`@e2e/*` paths) + is type-checked separately
    // (`tsc -p e2e/tsconfig.json`); the root ESLint resolver can't see those aliases, so
    // exclude it here to avoid false `import/no-unresolved` errors on the WDIO specs.
    ignores: ["dist/*", "e2e/*"],
  }
]);
