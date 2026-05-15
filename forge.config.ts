import path from 'node:path';
import fs from 'node:fs';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Orchestrator',
    executableName: 'Orchestrator',
    asar: {
      // The Claude Agent SDK code is bundled into main.js by Vite, but the
      // platform-specific binary package (claude.exe, ~218 MB) stays on
      // disk. It must live under node_modules/@anthropic-ai/ for the
      // bundled SDK's `require()` to resolve it. We copy it into the
      // build dir via afterCopy, then unpack it from asar so the .exe is
      // a real file the SDK can spawn.
      unpack:
        '**/{*.node,node_modules/@anthropic-ai/claude-agent-sdk-win32-*/**}',
    },
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          const src = path.resolve(
            __dirname,
            'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64',
          );
          const dst = path.join(
            buildPath,
            'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64',
          );
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.cpSync(src, dst, { recursive: true });
          callback();
        } catch (e) {
          callback(e as Error);
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'orchestrator',
      authors: 'lukeeexd',
      description: 'Desktop app for orchestrating Claude agents.',
      setupExe: 'Orchestrator-Setup.exe',
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
