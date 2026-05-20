import { ipcMain } from 'electron';
import { IpcChannels, type Settings } from '../../shared/ipc';
import { readSettings, writeSettings } from '../settings';
import type { IpcContext } from './_shared';
import { validated } from './_shared';
import { partialSettingsSchema } from './_schemas';

export function registerSettingsHandlers(ctx: IpcContext): void {
  ipcMain.handle(IpcChannels.SettingsGet, (): Settings => readSettings());
  validated(
    IpcChannels.SettingsSet,
    partialSettingsSchema,
    (_event, next): Settings => {
      const merged = writeSettings(next as Partial<Settings>);
      ctx.broadcast(IpcChannels.SettingsEventChanged, merged);
      return merged;
    },
  );
}
