import { Component, inject, OnInit, signal } from '@angular/core';
import {
  NotificationChannelService,
  NotificationChannel,
} from '../../core/services/notification-channel.service';
import { NotificationChannelDialogComponent } from './notification-channel-dialog.component';
import { ToastService } from '../../core/services/toast.service';
import {
  BroncoButtonComponent,
  CardComponent,
  ToggleSwitchComponent,
  DropdownMenuComponent,
  DropdownItemComponent,
  DialogComponent,
} from '../../shared/components/index.js';

@Component({
  standalone: true,
  selector: 'app-notification-channels',
  imports: [
    BroncoButtonComponent,
    CardComponent,
    ToggleSwitchComponent,
    DropdownMenuComponent,
    DropdownItemComponent,
    DialogComponent,
    NotificationChannelDialogComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">Notification Channels</h1>
        <app-bronco-button variant="primary" (click)="openDialog()">
          + Add Channel
        </app-bronco-button>
      </div>

      @if (loading()) {
        <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
      }

      @if (channels().length === 0 && !loading()) {
        <app-card padding="md" class="empty-card">
          <div class="empty-content">
            <span class="empty-icon" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </span>
            <div>
              <div class="empty-title">No notification channels configured</div>
              <div class="empty-subtitle">Add an email or Pushover channel to receive alerts when services go down.</div>
            </div>
          </div>
        </app-card>
      }

      <div class="channel-grid">
        @for (ch of channels(); track ch.id) {
          <app-card padding="md" class="channel-card">
            <div class="channel-header">
              <div class="channel-name">
                <span class="type-icon" aria-hidden="true">
                  @if (ch.type === 'EMAIL') {
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                      <polyline points="22,6 12,13 2,6"/>
                    </svg>
                  } @else {
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                      <line x1="12" y1="18" x2="12.01" y2="18"/>
                    </svg>
                  }
                </span>
                {{ ch.name }}
              </div>
              <div class="channel-actions">
                <app-toggle-switch
                  [checked]="ch.isActive"
                  [label]="'Enable ' + ch.name"
                  (checkedChange)="toggleActive(ch)"
                ></app-toggle-switch>
                <app-bronco-button variant="icon" size="sm" [attr.aria-label]="'Actions for ' + ch.name" #menuTrigger (click)="menu.toggle()">
                  &#x22EE;
                </app-bronco-button>
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
                <span class="spinner" aria-hidden="true"></span>
                <span>Sending test...</span>
              </div>
            }
          </app-card>
        }
      </div>
    </div>

    @if (showDialog()) {
      <app-dialog [open]="true" [title]="(editingChannel() ? 'Edit' : 'Add') + ' Notification Channel'" maxWidth="480px" (openChange)="showDialog.set(false)">
        <app-notification-channel-dialog-content
          [channel]="editingChannel()"
          (saved)="onSaved()"
          (cancelled)="showDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .page-title {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
      font-family: var(--font-primary);
    }

    .loading-wrapper {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    .loading-text { color: var(--text-tertiary); font-size: 13px; }

    /* Empty state */
    .empty-card { border-left: 4px solid var(--color-warning); margin-bottom: 16px; }
    .empty-content { display: flex; align-items: center; gap: 16px; padding: 4px 0; }
    .empty-icon { color: var(--color-warning); flex-shrink: 0; display: flex; }
    .empty-title { font-size: 15px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px; }
    .empty-subtitle { font-size: 13px; color: var(--text-secondary); }

    /* Channel grid */
    .channel-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }

    .channel-card { position: relative; }
    .channel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .channel-name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 15px;
      color: var(--text-primary);
    }
    .channel-actions { display: flex; align-items: center; gap: 6px; }
    .type-icon {
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
    }

    /* Chips */
    .channel-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .type-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: monospace;
    }
    .type-chip.type-email {
      background: var(--color-info-subtle);
      color: var(--color-info);
    }
    .type-chip.type-pushover {
      background: var(--color-purple-subtle);
      color: var(--color-purple);
    }
    .inactive-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-muted);
      color: var(--text-tertiary);
      font-family: monospace;
    }

    /* Config details */
    .config-detail {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      font-size: 13px;
    }
    .detail-label { color: var(--text-tertiary); }
    .detail-value { font-family: monospace; color: var(--text-primary); }

    /* Test status */
    .test-status {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* CSS-only spinner */
    @keyframes bronco-spin {
      to { transform: rotate(360deg); }
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-medium);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: bronco-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
  `],
})
export class NotificationChannelsComponent implements OnInit {
  private channelService = inject(NotificationChannelService);
  private toast = inject(ToastService);

  channels = signal<NotificationChannel[]>([]);
  loading = signal(false);
  testing = signal<string | null>(null);
  showDialog = signal(false);
  editingChannel = signal<NotificationChannel | null>(null);

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
    this.editingChannel.set(channel ?? null);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
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
