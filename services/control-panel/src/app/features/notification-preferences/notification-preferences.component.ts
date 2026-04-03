import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { environment } from '../../../environments/environment';

interface NotificationPreference {
  id: string;
  event: string;
  description: string;
  emailEnabled: boolean;
  slackEnabled: boolean;
  slackTarget: string | null;
  emailTarget: string | null;
  isActive: boolean;
}

interface OperatorOption {
  id: string;
  name: string;
  email: string;
  slackUserId: string | null;
  isActive: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  TICKET_CREATED: 'New Ticket',
  ANALYSIS_COMPLETE: 'Analysis Complete',
  SUFFICIENCY_CHANGED: 'Sufficiency Changed',
  USER_REPLIED: 'User Replied',
  PLAN_READY: 'Plan Ready',
  PLAN_APPROVED: 'Plan Approved',
  PLAN_REJECTED: 'Plan Rejected',
  RESOLUTION_COMPLETE: 'Resolution Complete',
  SERVICE_HEALTH_ALERT: 'Service Health Alert',
  PROBE_ALERT: 'Probe Alert',
};

const SLACK_TARGET_OPTIONS = [
  { value: 'default', label: 'Default Channel' },
  { value: 'assigned_operator', label: 'Assigned Operator (DM)' },
  { value: 'all_operators', label: 'All Operators (DM each)' },
  { value: 'specific_operator', label: 'Specific Operator' },
  { value: 'custom', label: 'Custom Channel ID' },
];

const EMAIL_TARGET_OPTIONS = [
  { value: 'all_operators', label: 'All Operators' },
  { value: 'assigned_operator', label: 'Assigned Operator' },
  { value: 'specific_operator', label: 'Specific Operator' },
  { value: 'custom', label: 'Custom Email' },
];

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatTableModule,
    MatSlideToggleModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  template: `
    <h1>Notification Preferences</h1>
    <p class="subtitle">Configure which events trigger notifications and through which channels.</p>

    @if (loading()) {
      <div class="spinner-wrapper"><mat-spinner diameter="40" /></div>
    } @else {
      <mat-card>
        <mat-card-content>
          <div class="table-wrapper">
            <table mat-table [dataSource]="preferences()" class="pref-table">

              <ng-container matColumnDef="event">
                <th mat-header-cell *matHeaderCellDef>Event</th>
                <td mat-cell *matCellDef="let pref">
                  <div class="event-cell">
                    <strong>{{ eventLabel(pref.event) }}</strong>
                    <span class="event-desc">{{ pref.description }}</span>
                  </div>
                </td>
              </ng-container>

              <ng-container matColumnDef="emailEnabled">
                <th mat-header-cell *matHeaderCellDef>Email</th>
                <td mat-cell *matCellDef="let pref">
                  <mat-slide-toggle [(ngModel)]="pref.emailEnabled" />
                </td>
              </ng-container>

              <ng-container matColumnDef="emailTarget">
                <th mat-header-cell *matHeaderCellDef>Email Target</th>
                <td mat-cell *matCellDef="let pref">
                  @if (pref.emailEnabled) {
                    <mat-form-field appearance="outline" class="compact-field">
                      <mat-select [value]="emailTargetSelection(pref)" (selectionChange)="onEmailTargetChange(pref, $event.value)">
                        @for (opt of emailTargetOptions; track opt.value) {
                          <mat-option [value]="opt.value">{{ opt.label }}</mat-option>
                        }
                      </mat-select>
                    </mat-form-field>
                    @if (emailTargetSelection(pref) === 'custom') {
                      <mat-form-field appearance="outline" class="compact-field custom-input">
                        <input matInput [(ngModel)]="pref.emailTarget" placeholder="user@example.com">
                      </mat-form-field>
                    }
                    @if (emailTargetSelection(pref) === 'specific_operator') {
                      <mat-form-field appearance="outline" class="compact-field custom-input">
                        <mat-select
                          [value]="selectedOperatorValue(pref.emailTarget)"
                          (selectionChange)="pref.emailTarget = $event.value"
                          placeholder="Select operator">
                          @for (op of operators(); track op.id) {
                            <mat-option [value]="'operator:' + op.id">{{ op.name }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                    }
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="slackEnabled">
                <th mat-header-cell *matHeaderCellDef>Slack</th>
                <td mat-cell *matCellDef="let pref">
                  <mat-slide-toggle [(ngModel)]="pref.slackEnabled" />
                </td>
              </ng-container>

              <ng-container matColumnDef="slackTarget">
                <th mat-header-cell *matHeaderCellDef>Slack Target</th>
                <td mat-cell *matCellDef="let pref">
                  @if (pref.slackEnabled) {
                    <mat-form-field appearance="outline" class="compact-field">
                      <mat-select [value]="slackTargetSelection(pref)" (selectionChange)="onSlackTargetChange(pref, $event.value)">
                        @for (opt of slackTargetOptions; track opt.value) {
                          <mat-option [value]="opt.value">{{ opt.label }}</mat-option>
                        }
                      </mat-select>
                    </mat-form-field>
                    @if (slackTargetSelection(pref) === 'custom') {
                      <mat-form-field appearance="outline" class="compact-field custom-input">
                        <input matInput [(ngModel)]="pref.slackTarget" placeholder="C0123456789">
                      </mat-form-field>
                    }
                    @if (slackTargetSelection(pref) === 'specific_operator') {
                      <mat-form-field appearance="outline" class="compact-field custom-input">
                        <mat-select
                          [value]="selectedOperatorValue(pref.slackTarget)"
                          (selectionChange)="pref.slackTarget = $event.value"
                          placeholder="Select operator">
                          @for (op of operators(); track op.id) {
                            <mat-option [value]="'operator:' + op.id">{{ op.name }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                    }
                  }
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
            </table>
          </div>

          <div class="actions">
            <button mat-flat-button color="primary" (click)="saveAll()" [disabled]="saving()">
              @if (saving()) {
                <mat-spinner diameter="20" />
              } @else {
                <mat-icon>save</mat-icon>
                Save All
              }
            </button>
          </div>
        </mat-card-content>
      </mat-card>
    }
  `,
  styles: [`
    .subtitle {
      color: #666;
      margin-bottom: 16px;
    }
    .spinner-wrapper {
      display: flex;
      justify-content: center;
      padding: 40px;
    }
    .table-wrapper {
      overflow-x: auto;
    }
    .pref-table {
      width: 100%;
    }
    .event-cell {
      display: flex;
      flex-direction: column;
      padding: 8px 0;
    }
    .event-desc {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }
    .compact-field {
      font-size: 13px;
      max-width: 200px;
    }
    .custom-input {
      margin-left: 8px;
      max-width: 180px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid #e0e0e0;
    }
    .actions button mat-icon {
      margin-right: 4px;
    }
  `],
})
export class NotificationPreferencesComponent implements OnInit {
  private http = inject(HttpClient);
  private snackBar = inject(MatSnackBar);

  loading = signal(true);
  saving = signal(false);
  preferences = signal<NotificationPreference[]>([]);
  operators = signal<OperatorOption[]>([]);

  displayedColumns = ['event', 'emailEnabled', 'emailTarget', 'slackEnabled', 'slackTarget'];
  slackTargetOptions = SLACK_TARGET_OPTIONS;
  emailTargetOptions = EMAIL_TARGET_OPTIONS;

  ngOnInit(): void {
    this.load();
    this.http.get<OperatorOption[]>(`${environment.apiUrl}/operators`).subscribe({
      next: ops => this.operators.set(ops.filter(o => o.isActive !== false)),
      error: () => { /* non-critical, leave empty */ },
    });
  }

  eventLabel(event: string): string {
    return EVENT_LABELS[event] ?? event;
  }

  slackTargetSelection(pref: NotificationPreference): string {
    if (pref.slackTarget === null || pref.slackTarget === undefined) return 'default';
    if (pref.slackTarget === 'assigned_operator' || pref.slackTarget === 'all_operators') return pref.slackTarget;
    if (pref.slackTarget.startsWith('operator:')) return 'specific_operator';
    return 'custom';
  }

  emailTargetSelection(pref: NotificationPreference): string {
    if (pref.emailTarget === null || pref.emailTarget === undefined || pref.emailTarget === 'all_operators') return 'all_operators';
    if (pref.emailTarget === 'assigned_operator') return 'assigned_operator';
    if (pref.emailTarget.startsWith('operator:')) return 'specific_operator';
    return 'custom';
  }

  onSlackTargetChange(pref: NotificationPreference, value: string): void {
    if (value === 'default') {
      pref.slackTarget = null;
    } else if (value === 'custom') {
      pref.slackTarget = '';
    } else if (value === 'specific_operator') {
      // Use 'operator:' prefix as placeholder so slackTargetSelection() keeps returning
      // 'specific_operator' until the user picks an operator from the dropdown.
      pref.slackTarget = 'operator:';
    } else {
      pref.slackTarget = value;
    }
  }

  onEmailTargetChange(pref: NotificationPreference, value: string): void {
    if (value === 'custom') {
      pref.emailTarget = '';
    } else if (value === 'specific_operator') {
      // Use 'operator:' prefix as placeholder so emailTargetSelection() keeps returning
      // 'specific_operator' until the user picks an operator from the dropdown.
      pref.emailTarget = 'operator:';
    } else {
      pref.emailTarget = value;
    }
  }

  selectedOperatorValue(target: string | null): string {
    if (target?.startsWith('operator:')) return target;
    return '';
  }

  private load(): void {
    this.loading.set(true);
    this.http.get<NotificationPreference[]>(`${environment.apiUrl}/notification-preferences`).subscribe({
      next: prefs => {
        this.preferences.set(prefs);
        this.loading.set(false);
      },
      error: () => {
        this.snackBar.open('Failed to load notification preferences', 'Dismiss', { duration: 5000 });
        this.loading.set(false);
      },
    });
  }

  saveAll(): void {
    this.saving.set(true);
    const payload = this.preferences().map(p => ({
      event: p.event,
      emailEnabled: p.emailEnabled,
      slackEnabled: p.slackEnabled,
      slackTarget: (p.slackTarget && p.slackTarget !== 'operator:') ? p.slackTarget : null,
      emailTarget: (p.emailTarget && p.emailTarget !== 'operator:') ? p.emailTarget : null,
      isActive: p.isActive,
    }));

    this.http.put(`${environment.apiUrl}/notification-preferences`, payload).subscribe({
      next: () => {
        this.snackBar.open('Preferences saved', 'Dismiss', { duration: 3000 });
        this.saving.set(false);
      },
      error: () => {
        this.snackBar.open('Failed to save preferences', 'Dismiss', { duration: 5000 });
        this.saving.set(false);
      },
    });
  }
}
