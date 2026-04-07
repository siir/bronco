import { Component, inject, OnInit, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  NotificationChannelService,
  NotificationChannel,
} from '../../core/services/notification-channel.service';
import { NotificationChannelDialogComponent } from './notification-channel-dialog.component';
import { ToastService } from '../../core/services/toast.service';
import {
  DropdownMenuComponent,
  DropdownItemComponent,
} from '../../shared/components/index.js';

@Component({
  standalone: true,
  selector: 'app-notification-channels',
  imports: [
    FormsModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    DropdownMenuComponent,
    DropdownItemComponent,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <div class="section-header">
      <h2>Notification Channels</h2>
      <button mat-raised-button color="primary" (click)="openDialog()">
        <mat-icon>add</mat-icon> Add Channel
      </button>
    </div>

    @if (channels().length === 0 && !loading()) {
      <mat-card class="empty-card">
        <mat-card-content>
          <div class="empty-content">
            <mat-icon class="empty-icon">notifications_off</mat-icon>
            <div>
              <div class="empty-title">No notification channels configured</div>
              <div class="empty-subtitle">Add an email or Pushover channel to receive alerts when services go down.</div>
            </div>
          </div>
        </mat-card-content>
      </mat-card>
    }

    <div class="channel-grid">
      @for (ch of channels(); track ch.id) {
        <mat-card class="channel-card">
          <mat-card-content>
            <div class="channel-header">
              <div class="channel-name">
                <mat-icon class="type-icon">{{ ch.type === 'EMAIL' ? 'email' : 'phone_android' }}</mat-icon>
                {{ ch.name }}
              </div>
              <div class="channel-actions">
                <mat-slide-toggle
                  [checked]="ch.isActive"
                  (change)="toggleActive(ch)"
                  matTooltip="Enable/disable this channel"
                ></mat-slide-toggle>
                <button type="button" class="icon-btn" [attr.aria-label]="'Actions for ' + ch.name" #menuTrigger (click)="menu.toggle()">&#x22EE;</button>
                <app-dropdown-menu #menu [trigger]="menuTrigger">
                  <app-dropdown-item (action)="openDialog(ch)">Edit</app-dropdown-item>
                  <app-dropdown-item (action)="testChannel(ch)">Send Test</app-dropdown-item>
                  <app-dropdown-item (action)="deleteChannel(ch)" [destructive]="true">Delete</app-dropdown-item>
                </app-dropdown-menu>
              </div>
            </div>

            <div class="channel-meta">
              <span class="type-chip type-{{ ch.type.toLowerCase() }}">{{ ch.type }}</span>
              @if (!ch.isActive) {
                <span class="inactive-chip">DISABLED</span>
              }
            </div>

            @if (ch.type === 'EMAIL') {
              <div class="config-detail">
                <span class="detail-label">To</span>
                <span class="detail-value">{{ ch.config['to'] }}</span>
              </div>
              <div class="config-detail">
                <span class="detail-label">From</span>
                <span class="detail-value">{{ ch.config['from'] }}</span>
              </div>
              <div class="config-detail">
                <span class="detail-label">Host</span>
                <span class="detail-value">{{ ch.config['host'] }}:{{ ch.config['port'] }}</span>
              </div>
            }
            @if (ch.type === 'PUSHOVER') {
              <div class="config-detail">
                <span class="detail-label">App Token</span>
                <span class="detail-value">{{ ch.config['appToken'] }}</span>
              </div>
              <div class="config-detail">
                <span class="detail-label">User Key</span>
                <span class="detail-value">{{ ch.config['userKey'] }}</span>
              </div>
            }

            @if (testing() === ch.id) {
              <div class="test-status">
                <mat-spinner diameter="16"></mat-spinner>
                <span>Sending test...</span>
              </div>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .section-header h2 { margin: 0; font-size: 16px; font-weight: 500; color: #555; }

    .empty-card { border-left: 4px solid #ff9800; }
    .empty-content { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
    .empty-icon { font-size: 32px; width: 32px; height: 32px; color: #ff9800; }
    .empty-title { font-size: 16px; font-weight: 500; }
    .empty-subtitle { font-size: 14px; color: #666; }

    .channel-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }

    .channel-card { position: relative; }
    .channel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .channel-name { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: 15px; }
    .channel-actions { display: flex; align-items: center; gap: 4px; }
    .type-icon { color: #666; font-size: 20px; width: 20px; height: 20px; }

    .channel-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .type-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: monospace;
    }
    .type-chip.type-email { background: #e3f2fd; color: #1565c0; }
    .type-chip.type-pushover { background: #f3e5f5; color: #7b1fa2; }
    .inactive-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: #f5f5f5;
      color: #757575;
      font-family: monospace;
    }

    .config-detail {
      display: flex;
      justify-content: space-between;
      padding: 2px 0;
      font-size: 13px;
    }
    .detail-label { color: #888; }
    .detail-value { font-family: monospace; color: #333; }

    .test-status {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 13px;
      color: #666;
    }

    .icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 18px;
      color: var(--text-tertiary);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      line-height: 1;
    }
    .icon-btn:hover { background: var(--bg-hover); }
  `],
})
export class NotificationChannelsComponent implements OnInit {
  private channelService = inject(NotificationChannelService);
  private toast = inject(ToastService);
  private dialog = inject(MatDialog);

  channels = signal<NotificationChannel[]>([]);
  loading = signal(false);
  testing = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.channelService.list().subscribe({
      next: (channels) => {
        this.channels.set(channels);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  openDialog(channel?: NotificationChannel): void {
    const dialogRef = this.dialog.open(NotificationChannelDialogComponent, {
      width: '480px',
      data: channel ?? null,
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) this.load();
    });
  }

  toggleActive(channel: NotificationChannel): void {
    this.channelService.update(channel.id, { isActive: !channel.isActive }).subscribe({
      next: () => this.load(),
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to update');
      },
    });
  }

  testChannel(channel: NotificationChannel): void {
    this.testing.set(channel.id);
    this.channelService.test(channel.id).subscribe({
      next: (res) => {
        this.testing.set(null);
        if (res.success) {
          this.toast.success(res.message ?? 'Test sent!');
        } else {
          this.toast.error(`Test failed: ${res.error}`);
        }
      },
      error: (err) => {
        this.testing.set(null);
        this.toast.error(err.error?.error ?? 'Test failed');
      },
    });
  }

  deleteChannel(channel: NotificationChannel): void {
    if (!confirm(`Delete notification channel "${channel.name}"?`)) return;
    this.channelService.delete(channel.id).subscribe({
      next: () => {
        this.toast.success('Channel deleted');
        this.load();
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to delete');
      },
    });
  }
}
