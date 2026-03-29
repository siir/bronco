import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ClientUserService, type ClientUser } from '../../core/services/client-user.service';

interface DialogData {
  clientId: string;
  user?: ClientUser;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatSlideToggleModule],
  template: `
    <h2 mat-dialog-title>{{ data.user ? 'Edit User' : 'Create Portal User' }}</h2>
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
        <mat-label>User Type</mat-label>
        <mat-select [(ngModel)]="userType">
          <mat-option value="USER">User</mat-option>
          <mat-option value="ADMIN">Admin</mat-option>
        </mat-select>
      </mat-form-field>
      @if (data.user) {
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
export class ClientUserDialogComponent {
  private dialogRef = inject(MatDialogRef<ClientUserDialogComponent>);
  data = inject<DialogData>(MAT_DIALOG_DATA);
  private clientUserService = inject(ClientUserService);
  private snackBar = inject(MatSnackBar);

  name = this.data.user?.name ?? '';
  email = this.data.user?.email ?? '';
  password = '';
  userType = this.data.user?.userType ?? 'USER';
  isActive = this.data.user?.isActive ?? true;

  save(): void {
    if (this.data.user) {
      this.clientUserService.updateUser(this.data.user.id, {
        name: this.name,
        email: this.email,
        userType: this.userType,
        isActive: this.isActive,
      }).subscribe({
        next: () => {
          this.snackBar.open('User updated', 'OK', { duration: 3000 });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.message ?? err.error?.error ?? 'Update failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    } else {
      this.clientUserService.createUser({
        clientId: this.data.clientId,
        email: this.email,
        password: this.password,
        name: this.name,
        userType: this.userType,
      }).subscribe({
        next: () => {
          this.snackBar.open('User created', 'OK', { duration: 3000 });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.message ?? err.error?.error ?? 'Create failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    }
  }
}
