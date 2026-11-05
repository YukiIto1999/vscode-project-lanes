import { defineConfig } from 'vite-plus';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/extension.ts',
      formats: ['cjs'],
      fileName: 'extension',
    },
    outDir: 'dist',
    sourcemap: true,
    target: 'node22',
    rollupOptions: {
      external: ['vscode', 'node-pty', /^node:/],
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
  lint: {
    ignorePatterns: ['dist/**'],
  },
  fmt: {
    singleQuote: true,
  },
});
