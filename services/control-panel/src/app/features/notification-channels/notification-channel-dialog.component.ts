import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
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
  standalone: true,
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit' : 'Add' }} Notification Channel</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="name" placeholder="e.g. My Email, Pushover Mobile" />
      </mat-form-field>

      @if (!isEdit) {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Type</mat-label>
          <mat-select [(ngModel)]="type" (selectionChange)="onTypeChange()">
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
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="saving">
        @if (saving) {
          <mat-spinner diameter="18"></mat-spinner>
        } @else {
          {{ isEdit ? 'Save' : 'Create' }}
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { display: flex; flex-direction: column; gap: 4px; min-width: 400px; }
    .full-width { width: 100%; }
    .half-width { width: 50%; }
  `],
})
export class NotificationChannelDialogComponent {
  private channelService = inject(NotificationChannelService);
  private dialogRef = inject(MatDialogRef<NotificationChannelDialogComponent>);
  private toast = inject(ToastService);
  private data: NotificationChannel | null = inject(MAT_DIALOG_DATA);

  isEdit = !!this.data;
  saving = false;
  name = this.data?.name ?? '';
  type = this.data?.type ?? 'EMAIL';

  emailConfig = {
    host: (this.data?.type === 'EMAIL' ? this.data.config['host'] as string : '') ?? '',
    port: (this.data?.type === 'EMAIL' ? this.data.config['port'] as number : 587) ?? 587,
    user: (this.data?.type === 'EMAIL' ? this.data.config['user'] as string : '') ?? '',
    password: '',
    from: (this.data?.type === 'EMAIL' ? this.data.config['from'] as string : '') ?? '',
    to: (this.data?.type === 'EMAIL' ? this.data.config['to'] as string : '') ?? '',
  };

  pushoverConfig = {
    appToken: '',
    userKey: '',
  };

  onTypeChange(): void {
    // Reset configs when type changes
  }

  save(): void {
    if (!this.name.trim()) {
      this.toast.info('Name is required');
      return;
    }

    this.saving = true;

    if (this.isEdit && this.data) {
      const config = this.buildConfig();
      this.channelService.update(this.data.id, { name: this.name, config }).subscribe({
        next: () => {
          this.saving = false;
          this.dialogRef.close(true);
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
          this.dialogRef.close(true);
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
      // Only include password if changed (non-empty)
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
