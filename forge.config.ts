import path from 'node:path';
import fs from 'node:fs';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Orchestrator',
    executableName: 'Orchestrator',
    // asar is back on now that the bundled Claude Agent SDK is gone. We
    // shell out to the user's installed `claude` CLI via child_process.spawn
    // — no native binary lives inside our bundle anymore, so the
    // asar-can't-spawn-from-archive problem is moot. sql.js still needs to
    // be planted (its UMD wrapper doesn't bundle cleanly under Vite); fs.*
    // reads through asar transparently so it stays happy after archiving.
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          const src = path.resolve(__dirname, 'node_modules', 'sql.js');
          const dst = path.join(buildPath, 'node_modules', 'sql.js');
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
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // asar is on again, but we keep these two fuses OFF: when they were
      // turned on in v0.4.0, packaged installs landed on disk fine via
      // Squirrel but refused to launch silently — the embedded asar hash
      // never matched, integrity validation killed the process before any
      // UI, and there was no error dialog. Re-enable only when we have a
      // way to verify the integrity hash flows through electron-forge's
      // Squirrel maker correctly end-to-end.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
