import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ClientUserService, type ClientUser } from '../../core/services/client-user.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-client-user-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatSlideToggleModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" required>
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Email</mat-label>
      <input matInput [(ngModel)]="email" type="email" required>
    </mat-form-field>
    @if (!user()) {
      <mat-form-field class="full-width">
        <mat-label>Password</mat-label>
        <input matInput [(ngModel)]="password" type="password" required minlength="8">
      </mat-form-field>
    }
    <mat-form-field class="full-width">
      <mat-label>User Type</mat-label>
      <mat-select [(ngModel)]="userType">
        <mat-option value="USER">User</mat-option>
        <mat-option value="ADMIN">Admin</mat-option>
      </mat-select>
    </mat-form-field>
    @if (user()) {
      <mat-slide-toggle [(ngModel)]="isActive">{{ isActive ? 'Active' : 'Inactive' }}</mat-slide-toggle>
    }

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !email || (!user() && !password)">
        {{ user() ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; } .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }`],
})
export class ClientUserDialogComponent implements OnInit {
  private clientUserService = inject(ClientUserService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  user = input<ClientUser>();

  saved = output<boolean>();
  cancelled = output<void>();

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
