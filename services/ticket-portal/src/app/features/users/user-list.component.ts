import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { UserService, type ClientUser } from '../../core/services/user.service';

@Component({
  standalone: true,
  imports: [DatePipe, MatTableModule, MatButtonModule, MatIconModule, MatChipsModule, MatDialogModule],
  template: `
    <div class="page-header">
      <h1>Users</h1>
      <button mat-raised-button color="primary" (click)="openDialog()">
        <mat-icon>add</mat-icon> Add User
      </button>
    </div>

    <table mat-table [dataSource]="users()" class="full-width">
      <ng-container matColumnDef="name">
        <th mat-header-cell *matHeaderCellDef>Name</th>
        <td mat-cell *matCellDef="let u">{{ u.name }}</td>
      </ng-container>
      <ng-container matColumnDef="email">
        <th mat-header-cell *matHeaderCellDef>Email</th>
        <td mat-cell *matCellDef="let u">{{ u.email }}</td>
      </ng-container>
      <ng-container matColumnDef="userType">
        <th mat-header-cell *matHeaderCellDef>Type</th>
        <td mat-cell *matCellDef="let u">
          <span class="type-chip" [class.type-admin]="u.userType === 'ADMIN'">{{ u.userType }}</span>
        </td>
      </ng-container>
      <ng-container matColumnDef="isActive">
        <th mat-header-cell *matHeaderCellDef>Status</th>
        <td mat-cell *matCellDef="let u">
          <mat-chip [class.inactive]="!u.isActive">{{ u.isActive ? 'Active' : 'Inactive' }}</mat-chip>
        </td>
      </ng-container>
      <ng-container matColumnDef="lastLogin">
        <th mat-header-cell *matHeaderCellDef>Last Login</th>
        <td mat-cell *matCellDef="let u">{{ u.lastLoginAt ? (u.lastLoginAt | date:'short') : 'Never' }}</td>
      </ng-container>
      <ng-container matColumnDef="actions">
        <th mat-header-cell *matHeaderCellDef></th>
        <td mat-cell *matCellDef="let u">
          <button mat-icon-button aria-label="Edit user" (click)="openDialog(u)"><mat-icon>edit</mat-icon></button>
          @if (u.isActive) {
            <button mat-icon-button color="warn" aria-label="Deactivate user" (click)="deactivate(u.id)"><mat-icon>person_off</mat-icon></button>
          }
        </td>
      </ng-container>
      <tr mat-header-row *matHeaderRowDef="columns"></tr>
      <tr mat-row *matRowDef="let row; columns: columns;"></tr>
    </table>
    @if (users().length === 0) {
      <p class="empty">No users yet.</p>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .full-width { width: 100%; }
    .type-chip { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-family: monospace; background: #f5f5f5; }
    .type-admin { background: #e3f2fd; color: #1565c0; }
    .inactive { opacity: 0.5; }
    .empty { color: #999; text-align: center; padding: 32px; }
  `],
})
export class UserListComponent implements OnInit {
  private userService = inject(UserService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  users = signal<ClientUser[]>([]);
  columns = ['name', 'email', 'userType', 'isActive', 'lastLogin', 'actions'];

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.userService.getUsers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(u => this.users.set(u));
  }

  openDialog(user?: ClientUser): void {
    const ref = this.dialog.open(UserDialogComponent, { width: '500px', data: { user } });
    ref.afterClosed().subscribe(result => { if (result) this.load(); });
  }

  deactivate(id: string): void {
    this.userService.deleteUser(id).subscribe({
      next: () => {
        this.snackBar.open('User deactivated', 'OK', { duration: 3000 });
        this.load();
      },
      error: (err) => this.snackBar.open(err.error?.error ?? 'Failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
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
export class UserDialogComponent {
  private dialogRef = inject(MatDialogRef<UserDialogComponent>);
  data = inject<{ user?: ClientUser }>(MAT_DIALOG_DATA);
  private userService = inject(UserService);
  private snackBar = inject(MatSnackBar);

  name = this.data.user?.name ?? '';
  email = this.data.user?.email ?? '';
  password = '';
  userType = this.data.user?.userType ?? 'USER';
  isActive = this.data.user?.isActive ?? true;

  save(): void {
    if (this.data.user) {
      this.userService.updateUser(this.data.user.id, {
        name: this.name,
        email: this.email,
        userType: this.userType,
        isActive: this.isActive,
      }).subscribe({
        next: () => {
          this.snackBar.open('User updated', 'OK', { duration: 3000 });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.error ?? 'Update failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    } else {
      this.userService.createUser({
        email: this.email,
        password: this.password,
        name: this.name,
        userType: this.userType,
      }).subscribe({
        next: () => {
          this.snackBar.open('User created', 'OK', { duration: 3000 });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.error ?? 'Create failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    }
  }
}
