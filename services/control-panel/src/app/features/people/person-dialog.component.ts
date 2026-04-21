import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PersonService, type Person } from '../../core/services/person.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import {
  FormFieldComponent,
  TextInputComponent,
  SelectComponent,
  ToggleSwitchComponent,
  BroncoButtonComponent,
} from '../../shared/components/index.js';

@Component({
  selector: 'app-person-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    FormFieldComponent,
    TextInputComponent,
    SelectComponent,
    ToggleSwitchComponent,
    BroncoButtonComponent,
  ],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input [value]="form.name" (valueChange)="form.name = $event" />
      </app-form-field>
      <app-form-field label="Email">
        <app-text-input [value]="form.email" type="email" (valueChange)="form.email = $event" />
      </app-form-field>
      <app-form-field label="Phone">
        <app-text-input [value]="form.phone" (valueChange)="form.phone = $event" />
      </app-form-field>
      <app-form-field label="Role">
        <app-text-input [value]="form.role" placeholder="e.g. DBA, Developer, Manager" (valueChange)="form.role = $event" />
      </app-form-field>
      <app-form-field label="Slack User ID" hint="Used to link Slack messages to this person">
        <app-text-input [value]="form.slackUserId" placeholder="U0123456789" (valueChange)="form.slackUserId = $event" />
      </app-form-field>
      <label class="checkbox-row">
        <input type="checkbox" [(ngModel)]="form.isPrimary">
        <span>Primary contact</span>
      </label>

      <div class="portal-section">
        <app-form-field label="User Type">
          <app-select
            [value]="form.userType"
            [options]="userTypeOptions"
            (valueChange)="onUserTypeChange($event)" />
        </app-form-field>

        @if (!isEdit) {
          <app-form-field label="Password" hint="Minimum 8 characters — leave blank to create as contact only">
            <app-text-input
              [value]="form.password"
              type="password"
              (valueChange)="form.password = $event" />
          </app-form-field>
        }

        @if (isEdit) {
          <div class="toggle-row">
            <app-toggle-switch
              [checked]="form.isActive"
              [label]="form.isActive ? 'Active' : 'Inactive'"
              (checkedChange)="form.isActive = $event" />
          </div>
        }
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!canSave()" (click)="save()">
        {{ isEdit ? 'Save' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); cursor: pointer; }
    .portal-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
    }
    .toggle-row { display: flex; align-items: center; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class PersonDialogComponent implements OnInit {
  private personService = inject(PersonService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  person = input<Person | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;

  userTypeOptions = [
    { value: 'USER', label: 'User' },
    { value: 'ADMIN', label: 'Admin' },
  ];

  form = {
    name: '',
    email: '',
    phone: '',
    role: '',
    slackUserId: '',
    isPrimary: false,
    password: '',
    userType: 'USER' as 'USER' | 'ADMIN',
    isActive: true,
  };

  ngOnInit(): void {
    const p = this.person();
    if (p) {
      this.isEdit = true;
      this.form = {
        name: p.name,
        email: p.email,
        phone: p.phone ?? '',
        role: p.role ?? '',
        slackUserId: p.slackUserId ?? '',
        isPrimary: p.isPrimary,
        password: '',
        userType: (p.userType === 'ADMIN' ? 'ADMIN' : 'USER'),
        isActive: p.isActive,
      };
    }
  }

  onUserTypeChange(value: string): void {
    this.form.userType = value === 'ADMIN' ? 'ADMIN' : 'USER';
  }

  canSave(): boolean {
    if (!this.form.name || !this.form.email) return false;
    if (!this.isEdit && this.form.password.length > 0 && this.form.password.length < 8) return false;
    return true;
  }

  save(): void {
    const p = this.person();
    if (this.isEdit && p) {
      const update: Partial<Person> = {
        name: this.form.name,
        email: this.form.email,
        phone: this.form.phone === '' ? null : this.form.phone,
        role: this.form.role === '' ? null : this.form.role,
        slackUserId: this.form.slackUserId === '' ? null : this.form.slackUserId,
        isPrimary: this.form.isPrimary,
        userType: this.form.userType,
        isActive: this.form.isActive,
      };
      this.personService.updatePerson(p.id, update).subscribe({
        next: () => {
          this.toast.success('Person updated');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Update failed'),
      });
    } else {
      const create: Partial<Person> & { clientId: string; name: string; email: string; password?: string } = {
        clientId: this.clientId(),
        name: this.form.name,
        email: this.form.email,
        phone: this.form.phone || undefined,
        role: this.form.role || undefined,
        slackUserId: this.form.slackUserId || undefined,
        isPrimary: this.form.isPrimary,
        userType: this.form.userType,
      };
      if (this.form.password) {
        create.password = this.form.password;
      }
      this.personService.createPerson(create).subscribe({
        next: () => {
          this.toast.success('Person created');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Create failed'),
      });
    }
  }
}
