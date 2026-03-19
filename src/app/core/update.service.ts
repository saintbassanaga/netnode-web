import { Injectable } from '@angular/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

@Injectable({ providedIn: 'root' })
export class UpdateService {
  async checkAndInstall(): Promise<void> {
    const update = await check();
    if (!update) return;

    console.log(`[UpdateService] Update available: ${update.version} — downloading…`);
    await update.downloadAndInstall();
    await relaunch();
  }
}
