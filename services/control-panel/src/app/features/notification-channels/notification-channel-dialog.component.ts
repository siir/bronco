import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  NotificationChannelService,
  NotificationChannel,
} from '../../core/services/notification-channel.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-notification-channel-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" placeholder="e.g. My Email, Pushover Mobile" />
    </mat-form-field>

    @if (!isEdit) {
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Type</mat-label>
        <mat-select [(ngModel)]="type">
          <mat-option value="EMAIL">Email (SMTP)</mat-option>
          <mat-option value="PUSHOVER">Pushover</mat-option>
        </mat-select>
      </mat-form-field>
    }

    @if (type === 'EMAIL') {
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>SMTP Host</mat-label>
        <input matInput [(ngModel)]="emailConfig.host" placeholder="smtp.gmail.com" />
      </mat-form-field>
      <mat-form-field appearance="outline" class="half-width">
        <mat-label>SMTP Port</mat-label>
        <input matInput type="number" [(ngModel)]="emailConfig.port" />
      </mat-form-field>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>SMTP User</mat-label>
        <input matInput [(ngModel)]="emailConfig.user" />
      </mat-form-field>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>SMTP Password</mat-label>
        <input matInput type="password" [(ngModel)]="emailConfig.password" placeholder="{{ isEdit ? '(unchanged)' : '' }}" />
      </mat-form-field>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>From Address</mat-label>
        <input matInput [(ngModel)]="emailConfig.from" placeholder="alerts@example.com" />
      </mat-form-field>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Send Alerts To</mat-label>
        <input matInput [(ngModel)]="emailConfig.to" placeholder="you@example.com" />
      </mat-form-field>
    }

    @if (type === 'PUSHOVER') {
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>App Token</mat-label>
        <input matInput [(ngModel)]="pushoverConfig.appToken" placeholder="{{ isEdit ? '(unchanged)' : '' }}" />
      </mat-form-field>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>User Key</mat-label>
        <input matInput [(ngModel)]="pushoverConfig.userKey" placeholder="{{ isEdit ? '(unchanged)' : '' }}" />
      </mat-form-field>
    }

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="saving">
        @if (saving) {
          <mat-spinner diameter="18"></mat-spinner>
        } @else {
          {{ isEdit ? 'Save' : 'Create' }}
        }
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; }
    .half-width { width: 50%; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class NotificationChannelDialogComponent implements OnInit {
  private channelService = inject(NotificationChannelService);
  private toast = inject(ToastService);

  channel = input<NotificationChannel | null>(null);
  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;
  saving = false;
  name = '';
  type: string = 'EMAIL';

  emailConfig = {
    host: '',
    port: 587,
    user: '',
    password: '',
    from: '',
    to: '',
  };

  pushoverConfig = {
    appToken: '',
    userKey: '',
  };

  ngOnInit(): void {
    const c = this.channel();
    if (c) {
      this.isEdit = true;
      this.name = c.name;
      this.type = c.type;
      if (c.type === 'EMAIL') {
        this.emailConfig = {
          host: (c.config['host'] as string) ?? '',
          port: (c.config['port'] as number) ?? 587,
          user: (c.config['user'] as string) ?? '',
          password: '',
          from: (c.config['from'] as string) ?? '',
          to: (c.config['to'] as string) ?? '',
        };
      }
    }
  }

  save(): void {
    if (!this.name.trim()) {
      this.toast.info('Name is required');
      return;
    }

    this.saving = true;
    const c = this.channel();

    if (this.isEdit && c) {
      const config = this.buildConfig();
      this.channelService.update(c.id, { name: this.name, config }).subscribe({
        next: () => {
          this.saving = false;
          this.saved.emit(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.error ?? 'Failed to update');
        },
      });
    } else {
      const config = this.buildConfig();
      this.channelService.create({ name: this.name, type: this.type, config }).subscribe({
        next: () => {
          this.saving = false;
          this.saved.emit(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.error ?? 'Failed to create');
        },
      });
    }
  }

  private buildConfig(): Record<string, unknown> {
    if (this.type === 'EMAIL') {
      const config: Record<string, unknown> = {
        host: this.emailConfig.host,
        port: this.emailConfig.port,
        user: this.emailConfig.user,
        from: this.emailConfig.from,
        to: this.emailConfig.to,
      };
      if (this.emailConfig.password) {
        config['password'] = this.emailConfig.password;
      }
      return config;
    }

    if (this.type === 'PUSHOVER') {
      const config: Record<string, unknown> = {};
      if (this.pushoverConfig.appToken) config['appToken'] = this.pushoverConfig.appToken;
      if (this.pushoverConfig.userKey) config['userKey'] = this.pushoverConfig.userKey;
      return config;
    }

    return {};
  }
}
