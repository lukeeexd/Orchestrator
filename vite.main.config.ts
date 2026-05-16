import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// We bundle most node_modules into main.js so the packaged app doesn't need
// a node_modules tree. Externals:
//
// 1. electron + node built-ins — Vite always externalises these for main.
// 2. sql.js — its UMD wrapper doesn't survive Rollup bundling (tries to set
//    `module.exports` against an undefined module object and throws at init).
//    Lives on disk via the forge afterCopy hook; fs.* / require.resolve read
//    through asar transparently at runtime.
//
// The Claude Agent SDK and its platform-specific native binaries used to
// live here — they're gone now. Workers spawn the user's installed `claude`
// CLI directly via child_process.spawn (see src/main/cli/spawn.ts).
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'sql.js',
];

export default defineConfig({
  build: {
    commonjsOptions: {
      // sql.js ships UMD; this lets Rollup unwrap the wrapper instead of
      // tripping on `Cannot set properties of undefined (setting 'exports')`.
      transformMixedEsModules: true,
    },
    rollupOptions: {
      external,
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});
