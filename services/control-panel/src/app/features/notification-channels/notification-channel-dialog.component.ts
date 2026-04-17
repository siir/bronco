import { Component, inject, input, output, OnInit } from '@angular/core';
import {
  NotificationChannelService,
  NotificationChannel,
} from '../../core/services/notification-channel.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-notification-channel-dialog-content',
  standalone: true,
  imports: [
    FormFieldComponent,
    TextInputComponent,
    SelectComponent,
    BroncoButtonComponent,
  ],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input [value]="name" placeholder="e.g. My Email, Pushover Mobile" (valueChange)="name = $event" />
      </app-form-field>

      @if (!isEdit) {
        <app-form-field label="Type">
          <app-select [value]="type" [options]="typeOptions" (valueChange)="onTypeChange($event)" />
        </app-form-field>
      }

      @if (type === 'EMAIL') {
        <app-form-field label="SMTP Host">
          <app-text-input [value]="emailConfig.host" placeholder="smtp.gmail.com" (valueChange)="emailConfig.host = $event" />
        </app-form-field>
        <app-form-field label="SMTP Port">
          <app-text-input [value]="'' + emailConfig.port" type="number" (valueChange)="emailConfig.port = parsePort($event)" />
        </app-form-field>
        <app-form-field label="SMTP User">
          <app-text-input [value]="emailConfig.user" (valueChange)="emailConfig.user = $event" />
        </app-form-field>
        <app-form-field label="SMTP Password">
          <app-text-input
            [value]="emailConfig.password"
            type="password"
            [placeholder]="isEdit ? '(unchanged)' : ''"
            (valueChange)="emailConfig.password = $event" />
        </app-form-field>
        <app-form-field label="From Address">
          <app-text-input [value]="emailConfig.from" placeholder="alerts@example.com" (valueChange)="emailConfig.from = $event" />
        </app-form-field>
        <app-form-field label="Send Alerts To">
          <app-text-input [value]="emailConfig.to" placeholder="you@example.com" (valueChange)="emailConfig.to = $event" />
        </app-form-field>
      }

      @if (type === 'PUSHOVER') {
        <app-form-field label="App Token">
          <app-text-input
            [value]="pushoverConfig.appToken"
            [placeholder]="isEdit ? '(unchanged)' : ''"
            (valueChange)="pushoverConfig.appToken = $event" />
        </app-form-field>
        <app-form-field label="User Key">
          <app-text-input
            [value]="pushoverConfig.userKey"
            [placeholder]="isEdit ? '(unchanged)' : ''"
            (valueChange)="pushoverConfig.userKey = $event" />
        </app-form-field>
      }
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="saving" (click)="save()">
        {{ saving ? 'Saving…' : (isEdit ? 'Save' : 'Create') }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
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

  typeOptions = [
    { value: 'EMAIL', label: 'Email (SMTP)' },
    { value: 'PUSHOVER', label: 'Pushover' },
  ];

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

  onTypeChange(newType: string): void {
    this.type = newType;
    this.emailConfig = { host: '', port: 587, user: '', password: '', from: '', to: '' };
    this.pushoverConfig = { appToken: '', userKey: '' };
  }

  parsePort(val: string): number {
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? 587 : n;
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
