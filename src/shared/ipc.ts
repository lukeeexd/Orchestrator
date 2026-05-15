export const IpcChannels = {
  AppPing: 'app:ping',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

export interface AppPingResponse {
  ok: true;
  version: string;
  startedAt: number;
}

export interface Settings {
  apiKey: string;
  defaultModel: string;
}

export interface OrchestratorApi {
  ping: () => Promise<AppPingResponse>;
  getSettings: () => Promise<Settings>;
  setSettings: (next: Partial<Settings>) => Promise<Settings>;
}

declare global {
  interface Window {
    api: OrchestratorApi;
  }
}
