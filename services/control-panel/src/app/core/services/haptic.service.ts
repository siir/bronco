import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class HapticService {
  tap(): void {
    if (!('vibrate' in navigator)) return;
    navigator.vibrate(10);
  }

  success(): void {
    if (!('vibrate' in navigator)) return;
    navigator.vibrate([10, 30, 10]);
  }

  warn(): void {
    if (!('vibrate' in navigator)) return;
    navigator.vibrate(30);
  }
}
