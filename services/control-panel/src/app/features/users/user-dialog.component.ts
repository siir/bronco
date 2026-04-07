import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { UserService, type ControlPanelUser } from '../../core/services/user.service';
import { ToastService } from '../../core/services/toast.service';

interface DialogData {
  user?: ControlPanelUser;
  currentUserId?: string;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatSlideToggleModule],
  template: `
    <h2 mat-dialog-title>{{ data.user ? 'Edit User' : 'Create User' }}</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="name" required>
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>Email</mat-label>
        <input matInput [(ngModel)]="email" type="email" required>
      </mat-form-field>
      @if (!data.user) {
        <mat-form-field class="full-width">
          <mat-label>Password</mat-label>
          <input matInput [(ngModel)]="password" type="password" required minlength="8">
        </mat-form-field>
      }
      <mat-form-field class="full-width">
        <mat-label>Role</mat-label>
        <mat-select [(ngModel)]="role">
          <mat-option value="ADMIN">Admin</mat-option>
          <mat-option value="OPERATOR">Operator</mat-option>
        </mat-select>
      </mat-form-field>
      @if (role === 'OPERATOR' || role === 'ADMIN') {
        <mat-form-field class="full-width">
          <mat-label>Slack User ID</mat-label>
          <input matInput [(ngModel)]="slackUserId" placeholder="U0123456789">
          <mat-hint>Click user profile in Slack → More → Copy member ID</mat-hint>
        </mat-form-field>
      }
      @if (data.user && !isSelf) {
        <mat-slide-toggle [(ngModel)]="isActive">{{ isActive ? 'Active' : 'Inactive' }}</mat-slide-toggle>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !email || (!data.user && !password)">
        {{ data.user ? 'Update' : 'Create' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class UserDialogComponent {
  private dialogRef = inject(MatDialogRef<UserDialogComponent>);
  data = inject<DialogData>(MAT_DIALOG_DATA);
  private userService = inject(UserService);
  private toast = inject(ToastService);

  name = this.data.user?.name ?? '';
  email = this.data.user?.email ?? '';
  password = '';
  role = this.data.user?.role ?? 'OPERATOR';
  slackUserId = this.data.user?.slackUserId ?? '';
  isActive = this.data.user?.isActive ?? true;
  isSelf = this.data.user?.id === this.data.currentUserId;

  save(): void {
    if (this.data.user) {
      this.userService.updateUser(this.data.user.id, {
        name: this.name,
        email: this.email,
        role: this.role,
        isActive: this.isActive,
        ...(this.slackUserId !== undefined && { slackUserId: this.slackUserId }),
      }).subscribe({
        next: () => {
          this.toast.success('User updated');
          this.dialogRef.close(true);
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
          this.dialogRef.close(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Create failed'),
      });
    }
  }
}
