import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [FormsModule, BroncoButtonComponent, CardComponent, FormFieldComponent],
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
            <span class="mono">{{ user.id }}</span>
          </div>
        </app-card>

        <app-card>
          <h2 class="section-title">Theme</h2>
          <div class="theme-grid">
            @for (theme of themeService.themes; track theme.id) {
              <button
                class="theme-card"
                [class.theme-card-active]="theme.id === themeService.currentTheme().id"
                (click)="themeService.setTheme(theme.id)">
                <div class="theme-card-preview" [class.theme-card-dark]="theme.isDark">
                  <span class="theme-swatch" [style.background]="theme.accentColor"></span>
                </div>
                <div class="theme-card-info">
                  <span class="theme-card-name">{{ theme.name }}</span>
                  <span class="theme-card-desc">{{ theme.description }}</span>
                </div>
                @if (theme.id === themeService.currentTheme().id) {
                  <span class="theme-check">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </span>
                }
              </button>
            }
          </div>
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
          <div class="form-grid">
            <app-form-field label="Current Password">
              <input class="text-input" type="password" [(ngModel)]="currentPassword" />
            </app-form-field>
            <app-form-field label="New Password">
              <input class="text-input" type="password" [(ngModel)]="newPassword" />
            </app-form-field>
            <app-form-field label="Confirm New Password">
              <input class="text-input" type="password" [(ngModel)]="confirmPassword" />
            </app-form-field>
          </div>
          <div class="card-actions">
            <app-bronco-button variant="destructive" (click)="changePassword()" [disabled]="passwordSaving">
              Change Password
            </app-bronco-button>
          </div>
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

    .theme-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .theme-card {
      position: relative;
      background: var(--bg-page);
      border: 2px solid var(--border-light);
      border-radius: var(--radius-md);
      padding: 0;
      cursor: pointer;
      text-align: left;
      font-family: var(--font-primary);
      overflow: hidden;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    .theme-card:hover {
      border-color: var(--border-medium);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
    .theme-card-active {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .theme-card-active:hover {
      border-color: var(--accent);
    }
    .theme-card-preview {
      height: 48px;
      background: #f5f5f7;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid var(--border-light);
    }
    .theme-card-preview.theme-card-dark {
      background: #1a1a1a;
    }
    .theme-swatch {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      flex-shrink: 0;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    }
    .theme-card-info {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .theme-card-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .theme-card-desc {
      font-size: 11px;
      color: var(--text-tertiary);
      line-height: 1.3;
    }
    .theme-check {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
    }
  `],
})
export class ProfileComponent implements OnInit {
  authService = inject(AuthService);
  readonly themeService = inject(ThemeService);
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
