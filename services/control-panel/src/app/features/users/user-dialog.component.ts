import { Component, inject, input, output, OnInit } from '@angular/core';
import { UserService, type ControlPanelUser } from '../../core/services/user.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-user-dialog-content',
  standalone: true,
  imports: [FormFieldComponent, TextInputComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input [value]="name" (valueChange)="name = $event" />
      </app-form-field>
      <app-form-field label="Email">
        <app-text-input [value]="email" type="email" (valueChange)="email = $event" />
      </app-form-field>
      @if (!user()) {
        <app-form-field label="Password">
          <app-text-input [value]="password" type="password" (valueChange)="password = $event" />
        </app-form-field>
      }
      <app-form-field label="Role">
        <app-select [value]="role" [options]="roleOptions" (valueChange)="role = $event" />
      </app-form-field>
      @if (role === 'OPERATOR' || role === 'ADMIN') {
        <app-form-field label="Slack User ID" hint="Click user profile in Slack → More → Copy member ID">
          <app-text-input [value]="slackUserId" placeholder="U0123456789" (valueChange)="slackUserId = $event" />
        </app-form-field>
      }
      @if (user() && !isSelf) {
        <app-toggle-switch
          [checked]="isActive"
          [label]="isActive ? 'Active' : 'Inactive'"
          (checkedChange)="isActive = $event" />
      }
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!name || !email || (!user() && !password)" (click)="save()">
        {{ user() ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class UserDialogComponent implements OnInit {
  private userService = inject(UserService);
  private toast = inject(ToastService);

  user = input<ControlPanelUser | undefined>(undefined);
  currentUserId = input<string | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  name = '';
  email = '';
  password = '';
  role: string = 'OPERATOR';
  slackUserId = '';
  isActive = true;
  isSelf = false;

  roleOptions = [
    { value: 'ADMIN', label: 'Admin' },
    { value: 'OPERATOR', label: 'Operator' },
  ];

  ngOnInit(): void {
    const u = this.user();
    if (u) {
      this.name = u.name;
      this.email = u.email;
      this.role = u.role;
      this.slackUserId = u.slackUserId ?? '';
      this.isActive = u.isActive;
      this.isSelf = u.id === this.currentUserId();
    }
  }

  save(): void {
    const u = this.user();
    if (!u && this.password.length < 8) {
      this.toast.error('Password must be at least 8 characters');
      return;
    }
    if (u) {
      this.userService.updateUser(u.id, {
        name: this.name,
        email: this.email,
        role: this.role,
        isActive: this.isActive,
        ...(this.slackUserId !== undefined && { slackUserId: this.slackUserId }),
      }).subscribe({
        next: () => {
          this.toast.success('User updated');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Update failed'),
      });
    } else {
      this.userService.createUser({
        email: this.email,
        password: this.password,
        name: this.name,
        role: this.role,
        ...(this.slackUserId && { slackUserId: this.slackUserId }),
      }).subscribe({
        next: () => {
          this.toast.success('User created');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Create failed'),
      });
    }
  }
}
