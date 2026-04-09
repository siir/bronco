import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClientUserService, type ClientUser } from '../../core/services/client-user.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-client-user-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input
          [value]="name"
          (valueChange)="name = $event" />
      </app-form-field>
      <app-form-field label="Email">
        <app-text-input
          [value]="email"
          type="email"
          (valueChange)="email = $event" />
      </app-form-field>
      @if (!user()) {
        <app-form-field label="Password">
          <app-text-input
            [value]="password"
            type="password"
            (valueChange)="password = $event" />
        </app-form-field>
      }
      <app-form-field label="User Type">
        <app-select
          [value]="userType"
          [options]="userTypeOptions"
          (valueChange)="userType = $event" />
      </app-form-field>
      @if (user()) {
        <div class="toggle-row">
          <app-toggle-switch
            [checked]="isActive"
            [label]="isActive ? 'Active' : 'Inactive'"
            (checkedChange)="isActive = $event" />
        </div>
      }
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!name || !email || (!user() && password.length < 8)" (click)="save()">
        {{ user() ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .toggle-row { display: flex; align-items: center; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ClientUserDialogComponent implements OnInit {
  private clientUserService = inject(ClientUserService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  user = input<ClientUser>();

  saved = output<boolean>();
  cancelled = output<void>();

  userTypeOptions = [
    { value: 'USER', label: 'User' },
    { value: 'ADMIN', label: 'Admin' },
  ];

  name = '';
  email = '';
  password = '';
  userType = 'USER';
  isActive = true;

  ngOnInit(): void {
    const u = this.user();
    if (u) {
      this.name = u.name ?? '';
      this.email = u.email ?? '';
      this.userType = u.userType ?? 'USER';
      this.isActive = u.isActive ?? true;
    }
  }

  save(): void {
    const u = this.user();
    if (u) {
      this.clientUserService.updateUser(u.id, {
        name: this.name,
        email: this.email,
        userType: this.userType,
        isActive: this.isActive,
      }).subscribe({
        next: () => {
          this.toast.success('User updated');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Update failed'),
      });
    } else {
      this.clientUserService.createUser({
        clientId: this.clientId(),
        email: this.email,
        password: this.password,
        name: this.name,
        userType: this.userType,
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
