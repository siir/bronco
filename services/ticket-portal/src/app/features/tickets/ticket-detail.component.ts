import { Component, DestroyRef, inject, OnInit, signal, input, computed, ElementRef, ViewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TicketService, type Ticket, type TicketEvent } from '../../core/services/ticket.service';

@Component({
  standalone: true,
  imports: [RouterLink, DatePipe, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatTabsModule, MatSelectModule, MatTooltipModule],
  template: `
    @if (ticket(); as t) {
      <div class="page-header">
        <div>
          <a routerLink="/tickets" class="back-link">Tickets</a> /
          <h1 class="inline">@if (t.ticketNumber) { <span class="ticket-number">#{{ t.ticketNumber }}</span> — }{{ t.subject }}</h1>
        </div>
      </div>

      <div class="ticket-meta">
        <span class="priority priority-{{ t.priority.toLowerCase() }}">{{ t.priority }}</span>
        <span class="status status-{{ t.status.toLowerCase().replace('_', '-') }}">{{ t.status.replace('_', ' ') }}</span>
        @if (t.category) {
          <span class="category-badge">{{ t.category }}</span>
        }
        <span class="source">via {{ t.source }}</span>
        <span class="date">{{ t.createdAt | date:'medium' }}</span>
      </div>

      <!-- Info tabs -->
      <mat-tab-group class="info-tabs" animationDuration="0ms">
        @if (emailBlurb()) {
          <mat-tab label="AI Summary">
            <div class="tab-content">
              <p class="blurb-text">{{ emailBlurb() }}</p>
            </div>
          </mat-tab>
        }
        @if (t.summary) {
          <mat-tab label="Resolution Summary">
            <div class="tab-content">
              <p class="summary-text">{{ t.summary }}</p>
            </div>
          </mat-tab>
        }
        <mat-tab label="Details">
          <div class="tab-content">
            @if (t.description) {
              <p class="description">{{ descExpanded || t.description.length <= 300 ? t.description : t.description.slice(0, 300) + '...' }}</p>
              @if (t.description.length > 300) {
                <button mat-button class="show-more-btn" (click)="descExpanded = !descExpanded">
                  {{ descExpanded ? 'Show less' : 'Show more' }}
                </button>
              }
            }
            @if (t.system) { <p><strong>System:</strong> {{ t.system.name }}</p> }
            @for (f of t.followers || []; track f.id) {
              @if (f.followerType === 'REQUESTER' && f.contact) { <p><strong>Submitted by:</strong> {{ f.contact.name }} ({{ f.contact.email }})</p> }
            }
          </div>
        </mat-tab>
      </mat-tab-group>

      <!-- Artifacts -->
      @if (ticket()?.artifacts?.length) {
        <mat-card class="artifacts-card">
          <mat-card-header>
            <mat-icon mat-card-avatar>attach_file</mat-icon>
            <mat-card-title>Attachments</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <div class="artifact-list">
              @for (a of ticket()!.artifacts!; track a.id) {
                <a [href]="ticketService.getAttachmentDownloadUrl(ticket()!.id, a.id)" class="artifact-item" target="_blank" rel="noopener noreferrer">
                  <mat-icon>description</mat-icon>
                  <span>{{ a.filename }}</span>
                  <span class="artifact-size">{{ formatFileSize(a.sizeBytes) }}</span>
                </a>
              }
            </div>
          </mat-card-content>
        </mat-card>
      }

      <!-- Timeline -->
      <div class="timeline-header">
        <h3>Timeline</h3>
        <div class="timeline-controls">
          <mat-form-field class="timeline-filter-field">
            <mat-label>Filter</mat-label>
            <mat-select [ngModel]="timelineFilter()" (ngModelChange)="timelineFilter.set($event)">
              <mat-option value="">All Events</mat-option>
              <mat-option value="COMMENT">Comments</mat-option>
              <mat-option value="STATUS_CHANGE">Status Changes</mat-option>
              <mat-option value="EMAIL_INBOUND">Inbound Emails</mat-option>
              <mat-option value="EMAIL_OUTBOUND">Outbound Emails</mat-option>
            </mat-select>
          </mat-form-field>
          <button mat-icon-button [matTooltip]="timelineSortAsc() ? 'Oldest first' : 'Newest first'" (click)="toggleSortOrder()">
            <mat-icon>{{ timelineSortAsc() ? 'arrow_upward' : 'arrow_downward' }}</mat-icon>
          </button>
        </div>
      </div>
      <div class="timeline">
        @for (event of filteredEvents(); track event.id) {
          <mat-card class="event-card">
            <mat-card-content>
              <div class="event-header">
                <mat-icon>{{ eventIcon(event.eventType) }}</mat-icon>
                <strong>{{ formatEventType(event.eventType) }}</strong>
                <span class="event-actor">by {{ event.actor }}</span>
                <span class="event-date">{{ event.createdAt | date:'short' }}</span>
              </div>
              @if (event.content) {
                <p class="event-content" [class.collapsed]="!expandedEvents[event.id] && event.content.length > 500">
                  {{ expandedEvents[event.id] ? event.content : event.content.slice(0, 500) }}
                  @if (event.content.length > 500 && !expandedEvents[event.id]) {
                    <span class="ellipsis">...</span>
                  }
                </p>
                @if (event.content.length > 500) {
                  <button mat-button class="show-more-btn" (click)="expandedEvents[event.id] = !expandedEvents[event.id]">
                    {{ expandedEvents[event.id] ? 'Show less' : 'Show more' }}
                  </button>
                }
              }
            </mat-card-content>
          </mat-card>
        } @empty {
          <p class="empty">No events match the current filter.</p>
        }
      </div>

      <!-- Add Comment & Upload -->
      <mat-card class="add-comment">
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Add comment</mat-label>
            <textarea matInput [(ngModel)]="newComment" rows="3"></textarea>
          </mat-form-field>
          <div class="comment-actions">
            <button mat-raised-button color="primary" (click)="addComment()" [disabled]="!newComment">
              <mat-icon>send</mat-icon> Add Comment
            </button>
            <button mat-stroked-button (click)="fileInput.click()">
              <mat-icon>attach_file</mat-icon> Upload File
            </button>
            <input #fileInput type="file" hidden (change)="uploadFile($event)">
          </div>
          @if (uploading()) {
            <p class="uploading">Uploading...</p>
          }
        </mat-card-content>
      </mat-card>
    } @else {
      <p>Loading...</p>
    }
  `,
  styles: [`
    .page-header { margin-bottom: 16px; }
    .back-link { text-decoration: none; color: #666; }
    .inline { display: inline; margin: 0 8px 0 4px; }
    .ticket-number { color: #666; font-family: monospace; }
    .ticket-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    .status { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #666; }
    .status-open { background: #e3f2fd; color: #1565c0; }
    .status-in-progress { background: #fff3e0; color: #e65100; }
    .status-waiting { background: #fff8e1; color: #f9a825; }
    .status-resolved { background: #e8f5e9; color: #2e7d32; }
    .status-closed { background: #f5f5f5; color: #999; }
    .category-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #f3e5f5; color: #6a1b9a; }
    .source { color: #666; font-size: 13px; }
    .date { color: #999; font-size: 13px; }
    .info-tabs { margin-bottom: 16px; }
    .tab-content { padding: 16px 0; }
    .blurb-text { line-height: 1.5; margin: 0; }
    .summary-text { white-space: pre-wrap; line-height: 1.6; }
    .description { white-space: pre-wrap; }
    .show-more-btn { font-size: 12px; color: #1565c0; padding: 0; min-width: auto; }
    .artifacts-card { margin-bottom: 16px; }
    .artifact-list { display: flex; flex-direction: column; gap: 4px; }
    .artifact-item { display: flex; align-items: center; gap: 8px; text-decoration: none; color: #1565c0; padding: 4px 0; font-size: 13px; }
    .artifact-item:hover { text-decoration: underline; }
    .artifact-size { color: #999; font-size: 11px; }
    .timeline-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .timeline-header h3 { margin: 0; }
    .timeline-controls { display: flex; align-items: center; gap: 8px; }
    .timeline-filter-field { width: 160px; font-size: 13px; }
    .timeline { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .event-header { display: flex; align-items: center; gap: 8px; }
    .event-actor { color: #666; font-size: 13px; }
    .event-date { color: #999; font-size: 13px; margin-left: auto; }
    .event-content { margin-top: 8px; white-space: pre-wrap; line-height: 1.5; }
    .event-content.collapsed { max-height: 100px; overflow: hidden; }
    .ellipsis { color: #999; }
    .add-comment { margin-bottom: 24px; }
    .comment-actions { display: flex; gap: 8px; align-items: center; }
    .full-width { width: 100%; }
    .empty { color: #999; padding: 16px; text-align: center; }
    .uploading { color: #666; font-size: 13px; margin-top: 8px; }
  `],
})
export class TicketDetailComponent implements OnInit {
  id = input.required<string>();

  ticketService = inject(TicketService);
  private destroyRef = inject(DestroyRef);
  private snackBar = inject(MatSnackBar);

  ticket = signal<Ticket | null>(null);
  events = signal<TicketEvent[]>([]);
  newComment = '';
  descExpanded = false;
  uploading = signal(false);
  expandedEvents: Record<string, boolean> = {};

  timelineFilter = signal('');
  timelineSortAsc = signal(true);

  filteredEvents = computed(() => {
    let evts = this.events();
    if (this.timelineFilter()) {
      evts = evts.filter(e => e.eventType === this.timelineFilter());
    }
    if (!this.timelineSortAsc()) {
      evts = [...evts].reverse();
    }
    return evts;
  });

  emailBlurb = computed(() => {
    const evts = this.events();
    const triage = evts.find(e =>
      e.eventType === 'AI_ANALYSIS' &&
      (e.metadata as Record<string, unknown> | null)?.['phase'] === 'triage',
    );
    if (!triage) return null;
    const meta = triage.metadata as Record<string, unknown> | null;
    return (meta?.['summary'] as string) ?? null;
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.ticketService.getTicket(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(t => {
      this.ticket.set(t);
      this.events.set(t.events ?? []);
    });
  }

  addComment(): void {
    this.ticketService.addComment(this.id(), this.newComment).subscribe({
      next: () => {
        this.newComment = '';
        this.snackBar.open('Comment added', 'OK', { duration: 3000 });
        this.load();
      },
      error: () => this.snackBar.open('Failed to add comment', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  uploadFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploading.set(true);
    this.ticketService.uploadAttachment(this.id(), file).subscribe({
      next: () => {
        this.uploading.set(false);
        this.snackBar.open('File uploaded', 'OK', { duration: 3000 });
        this.load();
        input.value = '';
      },
      error: () => {
        this.uploading.set(false);
        this.snackBar.open('Upload failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
        input.value = '';
      },
    });
  }

  eventIcon(type: string): string {
    const icons: Record<string, string> = {
      COMMENT: 'comment',
      STATUS_CHANGE: 'swap_horiz',
      PRIORITY_CHANGE: 'priority_high',
      CATEGORY_CHANGE: 'category',
      AI_ANALYSIS: 'psychology',
      AI_RECOMMENDATION: 'lightbulb',
      EMAIL_INBOUND: 'email',
      EMAIL_OUTBOUND: 'send',
      CODE_CHANGE: 'code',
      SYSTEM_NOTE: 'info',
    };
    return icons[type] ?? 'event';
  }

  formatEventType(type: string): string {
    return type.replace(/_/g, ' ');
  }

  toggleSortOrder(): void {
    this.timelineSortAsc.update(v => !v);
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
