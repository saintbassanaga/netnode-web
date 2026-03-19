import { Injectable } from '@angular/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private granted = false;

  async requestPermission(): Promise<void> {
    this.granted = await isPermissionGranted();
    if (!this.granted) {
      const permission = await requestPermission();
      this.granted = permission === 'granted';
    }
  }

  send(title: string, body: string): void {
    if (!this.granted) return;
    sendNotification({ title, body });
  }
}
