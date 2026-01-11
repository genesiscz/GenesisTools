import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import type { NitroConfig } from 'nitro/types'

const nitroConfig: NitroConfig = {
  experimental: {
    database: true,
  },
  database: {
    default: {
      connector: 'sqlite',
      options: { name: 'dashboard' },
    },
  },
}
import neon from './neon-vite-plugin.ts'

const config = defineConfig({
  plugins: [
    devtools(),
    nitro(nitroConfig),
    neon,
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@dashboard/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
      '@dashboard/ui': new URL('../../packages/ui/src/index.ts', import.meta.url).pathname,
    },
  },
  // PowerSync web workers require 'es' format for code-splitting builds
  worker: {
    format: 'es',
  },
  // PowerSync worker/WASM configuration
  // Exclude packages with workers/WASM from optimization
  optimizeDeps: {
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
    include: ['@powersync/web > js-logger'],
  },
})

export default config
