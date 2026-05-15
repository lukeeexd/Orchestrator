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
    // asar is disabled deliberately: the Claude Agent SDK spawns its native
    // claude.exe binary via child_process.spawn, and spawn() doesn't have
    // the asar-transparent path translation that fs.* does. With asar on,
    // the SDK gets a "resources\app.asar\...\claude.exe — exists but failed
    // to launch" error because the path is still inside an archive.
    // Disabling asar means the binary sits as a real file Windows can spawn.
    asar: false,
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          const copyPkg = (pkg: string) => {
            const src = path.resolve(__dirname, 'node_modules', pkg);
            const dst = path.join(buildPath, 'node_modules', pkg);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.cpSync(src, dst, { recursive: true });
          };
          copyPkg('@anthropic-ai/claude-agent-sdk-win32-x64');
          copyPkg('sql.js');
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
      // asar is disabled, so the integrity / asar-only fuses can't apply.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
