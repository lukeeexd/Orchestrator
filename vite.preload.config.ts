import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import pkg from './package.json';

const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(pkg.dependencies ?? {}),
];

export default defineConfig({
  build: {
    rollupOptions: {
      external,
      output: {
        entryFileNames: 'preload.js',
      },
    },
  },
});
