import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { UserService, type ControlPanelUser } from '../../core/services/user.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-user-dialog-content',
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
    @if (user() && !isSelf) {
      <mat-slide-toggle [(ngModel)]="isActive">{{ isActive ? 'Active' : 'Inactive' }}</mat-slide-toggle>
    }

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !email || (!user() && !password)">
        {{ user() ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
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
