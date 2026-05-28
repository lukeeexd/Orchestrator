import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IpcChannels } from '../../shared/ipc';
import {
  describeAttachments,
  disposePastedFile,
  pasteTempDir,
  readAttachmentAsDataUrl,
  savePastedImage,
  supportedAttachmentExtensions,
} from '../attachments';
import {
  allowAttachment,
  allowDroppedAttachment,
  isAttachmentAllowed,
} from '../security/attachments';

export function registerAttachmentsHandlers(): void {
  ipcMain.handle(IpcChannels.AttachmentPick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { attachments: [] };
    // Filter the dialog to types we can actually do something with —
    // text files inline as code blocks, images flow through as vision
    // content blocks, PDFs as document blocks. Anything else used to
    // sneak through and chip as 'unsupported', wasting a click.
    const result = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported attachments',
          extensions: supportedAttachmentExtensions(),
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { attachments: [] };
    }
    // M2: every picked path is a user-gesture event — allow-list
    // it so the runner can later read it via prepareAttachments
    // and the renderer can read its thumb via AttachmentReadThumb.
    // Paths that fail realpath resolution (deleted between pick
    // and IPC return) are dropped silently and chip as "read
    // failed" via describeAttachments.
    for (const p of result.filePaths) {
      try {
        allowAttachment(p);
      } catch {
        /* describeAttachments will mark it ok:false */
      }
    }
    return { attachments: describeAttachments(result.filePaths) };
  });

  ipcMain.handle(
    IpcChannels.AttachmentSavePaste,
    (_event, base64: string, mediaType: string) => {
      // Per-app subdir under the OS temp so we don't trip on collisions
      // with other apps. App-startup sweep handles long-term hygiene;
      // per-chip dispose (below) handles the immediate "user clicked ×"
      // case.
      const info = savePastedImage(pasteTempDir(), base64, mediaType);
      // M2: allow-list the written path so subsequent runner reads
      // succeed. The save itself is server-driven (we minted the
      // path), so this is trust-bounded.
      if (info.ok && info.path) {
        try {
          allowAttachment(info.path);
        } catch {
          /* lost between write and realpath — skip allow-list,
             describeAttachments already covers the failure path */
        }
      }
      return info;
    },
  );

  ipcMain.handle(
    IpcChannels.AttachmentReadThumb,
    (_event, target: string): string => {
      // M2: only serve thumbs for paths in the per-session allow-
      // list. Without this, a renderer can call readThumb on any
      // image file on disk and exfiltrate it as a data URL.
      if (!isAttachmentAllowed(target)) return '';
      return readAttachmentAsDataUrl(target);
    },
  );

  ipcMain.handle(
    IpcChannels.AttachmentDescribePaths,
    (_event, paths: unknown) => {
      // Wraps describeAttachments so the drag-drop handler can validate
      // non-image files (text, PDF) the same way the picker does. Image
      // drops go through savePastedImage instead — we don't have a
      // ready disk path for an in-memory blob.
      //
      // R-Vuln1-2026-05-28: this is the renderer-supplied entry into
      // the per-session attachment allow-list. Pre-fix, any renderer-
      // controlled value would land in the allow-list and become
      // inlinable into the LLM prompt — a one-step exfil primitive
      // for `.env` / `~/.claude/settings.json` / etc. The drop guard
      // (allowDroppedAttachment) now enforces extension + project-
      // workspace containment via realpath before the path joins the
      // allow-list. Files outside any workspace need the file picker
      // (server-minted path) instead. Belt-and-suspenders: runtime
      // type / cap guard on the incoming array, replacing the
      // implicit `string[]` type-only contract.
      const safeList: string[] = Array.isArray(paths)
        ? paths.filter((p): p is string => typeof p === 'string').slice(0, 32)
        : [];
      for (const p of safeList) {
        try {
          allowDroppedAttachment(p);
        } catch {
          /* skip — the chip surfaces as ok:false via describeAttachments */
        }
      }
      return describeAttachments(safeList);
    },
  );

  ipcMain.handle(
    IpcChannels.AttachmentDispose,
    (_event, target: string): { ok: boolean } => {
      // disposePastedFile rejects anything outside our managed subdir,
      // so it's safe for the renderer to call this for every chip
      // removal — picked attachments outside the subdir are silently
      // ignored.
      return { ok: disposePastedFile(pasteTempDir(), target) };
    },
  );
}
