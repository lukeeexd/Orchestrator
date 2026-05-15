import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// We bundle most node_modules into main.js so the packaged app doesn't need
// a node_modules tree. Two exceptions remain external:
//
// 1. electron + node built-ins — Vite always externalises these for main.
// 2. The Claude Agent SDK's platform-specific binary package (which contains
//    the claude.exe subprocess) — we can't bundle a 218 MB native binary,
//    so it has to live on disk and the bundled SDK code resolves to it via
//    a regular `require` at runtime. We mark every platform variant external
//    so Vite doesn't try to follow the optionalDependency chain.
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  '@anthropic-ai/claude-agent-sdk-win32-x64',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
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
