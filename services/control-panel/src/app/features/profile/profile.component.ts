import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service.js';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  ThemePickerComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service.js';

@Component({
  standalone: true,
  imports: [FormsModule, BroncoButtonComponent, CardComponent, FormFieldComponent, ThemePickerComponent],
  template: `
    <div class="page-wrapper">
      <h1 class="page-title">Profile</h1>

      @if (authService.currentUser(); as user) {
        <app-card>
          <div class="profile-header">
            <div class="avatar">{{ user.name.charAt(0).toUpperCase() }}</div>
            <div>
              <div class="profile-name">{{ user.name }}</div>
              <div class="profile-role">{{ user.role }}</div>
            </div>
          </div>
          <div class="field">
            <span class="label">User ID</span>
            <span class="mono">{{ user.personId }}</span>
          </div>
        </app-card>

        <app-card>
          <h2 class="section-title">Theme</h2>
          <app-theme-picker />
        </app-card>

        <app-card>
          <h2 class="section-title">Edit Profile</h2>
          <div class="form-grid">
            <app-form-field label="Name">
              <input class="text-input" [(ngModel)]="profileName" />
            </app-form-field>
            <app-form-field label="Email">
              <input class="text-input" type="email" [(ngModel)]="profileEmail" />
            </app-form-field>
          </div>
          <div class="card-actions">
            <app-bronco-button variant="primary" (click)="saveProfile()" [disabled]="profileSaving">
              Save Changes
            </app-bronco-button>
          </div>
        </app-card>

        <app-card>
          <h2 class="section-title">Change Password</h2>
          <form (ngSubmit)="changePassword()" autocomplete="on">
            <div class="form-grid">
              <input
                type="text"
                name="username"
                autocomplete="username"
                [value]="user.email"
                readonly
                tabindex="-1"
                aria-hidden="true"
                class="pw-username-hint" />
              <app-form-field label="Current Password">
                <input
                  class="text-input"
                  type="password"
                  name="currentPassword"
                  autocomplete="current-password"
                  [(ngModel)]="currentPassword" />
              </app-form-field>
              <app-form-field label="New Password">
                <input
                  class="text-input"
                  type="password"
                  name="newPassword"
                  autocomplete="new-password"
                  [(ngModel)]="newPassword" />
              </app-form-field>
              <app-form-field label="Confirm New Password">
                <input
                  class="text-input"
                  type="password"
                  name="confirmPassword"
                  autocomplete="new-password"
                  [(ngModel)]="confirmPassword" />
              </app-form-field>
            </div>
            <div class="card-actions">
              <app-bronco-button type="submit" variant="destructive" [disabled]="passwordSaving">
                Change Password
              </app-bronco-button>
            </div>
          </form>
        </app-card>
      }
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-title {
      margin: 0 0 24px;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
    }

    app-card { display: block; margin-bottom: 16px; }

    .profile-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }
    .avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 600;
    }
    .profile-name {
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .profile-role {
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .field {
      display: flex;
      flex-direction: column;
      margin-top: 8px;
    }
    .label {
      font-size: 12px;
      color: var(--text-tertiary);
      margin-bottom: 4px;
    }
    .mono {
      font-family: monospace;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .section-title {
      margin: 0 0 16px;
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .form-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 600px;
    }

    .text-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .text-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.15);
    }
    .text-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .card-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }

    /* Hidden-but-discoverable username input so Safari/1Password can
       correlate the password change to the saved credential. The element
       must stay in the DOM — display:none / visibility:hidden would make
       autofill skip it. Absolute positioning + 1px/opacity:0 keeps it
       parseable by autofill while visually invisible. */
    .pw-username-hint {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
      border: 0;
      padding: 0;
    }

  `],
})
export class ProfileComponent implements OnInit {
  authService = inject(AuthService);
  private toast = inject(ToastService);

  profileName = '';
  profileEmail = '';
  profileSaving = false;

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  passwordSaving = false;

  ngOnInit(): void {
    const user = this.authService.currentUser();
    if (user) {
      this.profileName = user.name;
      this.profileEmail = user.email;
    }
  }

  saveProfile(): void {
    this.profileSaving = true;
    this.authService.updateProfile({ name: this.profileName, email: this.profileEmail }).subscribe({
      next: () => {
        this.toast.success('Profile updated');
        this.profileSaving = false;
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to update profile');
        this.profileSaving = false;
      },
    });
  }

  changePassword(): void {
    if (this.newPassword !== this.confirmPassword) {
      this.toast.info('New passwords do not match');
      return;
    }
    if (this.newPassword.length < 8) {
      this.toast.info('Password must be at least 8 characters');
      return;
    }
    this.passwordSaving = true;
    this.authService.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: () => {
        this.toast.success('Password changed successfully');
        this.currentPassword = '';
        this.newPassword = '';
        this.confirmPassword = '';
        this.passwordSaving = false;
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to change password');
        this.passwordSaving = false;
      },
    });
  }
}
