import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TicketService } from '../../core/services/ticket.service';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, MatSelectModule],
  template: `
    <div class="page-header">
      <a routerLink="/tickets" class="back-link">Tickets</a> /
      <h1 class="inline">New Ticket</h1>
    </div>

    <mat-card>
      <mat-card-content>
        <mat-form-field class="full-width">
          <mat-label>Subject</mat-label>
          <input matInput [(ngModel)]="subject" required>
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Description</mat-label>
          <textarea matInput [(ngModel)]="description" rows="6"></textarea>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Priority</mat-label>
          <mat-select [(ngModel)]="priority">
            <mat-option value="LOW">Low</mat-option>
            <mat-option value="MEDIUM">Medium</mat-option>
            <mat-option value="HIGH">High</mat-option>
            <mat-option value="CRITICAL">Critical</mat-option>
          </mat-select>
        </mat-form-field>
      </mat-card-content>
      <mat-card-actions align="end">
        <button mat-button routerLink="/tickets">Cancel</button>
        <button mat-raised-button color="primary" (click)="create()" [disabled]="!subject || submitting()">
          @if (submitting()) {
            Creating...
          } @else {
            Create Ticket
          }
        </button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: [`
    .page-header { margin-bottom: 16px; }
    .back-link { text-decoration: none; color: #666; }
    .inline { display: inline; margin: 0 8px 0 4px; }
    .full-width { width: 100%; }
  `],
})
export class TicketCreateComponent {
  private ticketService = inject(TicketService);
  private router = inject(Router);
  private snackBar = inject(MatSnackBar);

  subject = '';
  description = '';
  priority = 'MEDIUM';
  submitting = signal(false);

  create(): void {
    this.submitting.set(true);
    this.ticketService.createTicket({
      subject: this.subject,
      description: this.description || undefined,
      priority: this.priority,
    }).subscribe({
      next: (ticket) => {
        this.snackBar.open('Ticket created', 'OK', { duration: 3000 });
        this.router.navigate(['/tickets', ticket.id]);
      },
      error: (err) => {
        this.submitting.set(false);
        this.snackBar.open(err.error?.error ?? 'Failed to create ticket', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }
}
