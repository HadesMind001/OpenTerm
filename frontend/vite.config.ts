import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electronSimple from 'vite-plugin-electron/simple'

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'
  const port = isDev ? 5173 : undefined

  return {
    plugins: [
      react(),
      tailwindcss(),
      electronSimple({
        main: {
          entry: 'electron/main.js',
          vite: {
            build: {
              watch: isDev ? {} : undefined,
            },
          },
        },
        preload: {
          input: 'electron/preload.mjs',
        },
      }),
    ],
    server: isDev
      ? {
          port,
          proxy: {
            '/api': 'http://127.0.0.1:8000',
            '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
          },
        }
      : undefined,
    envPrefix: ['VITE_'],
  }
})