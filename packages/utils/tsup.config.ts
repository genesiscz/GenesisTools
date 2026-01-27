import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'core/storage/index': 'src/core/storage/index.ts',
    'core/formatting': 'src/core/formatting.ts',
    'core/path': 'src/core/path.ts',
    'core/diff': 'src/core/diff.ts',
    'core/rate-limit': 'src/core/rate-limit.ts',
    'core/logger': 'src/core/logger.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  platform: 'neutral',
  external: ['chalk', 'pino', 'pino-pretty'],
  // Tree-shake unused exports
  treeshake: true,
});
