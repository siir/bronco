import { Component, DestroyRef, inject, OnInit, signal, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { JsonPipe, DatePipe, SlicePipe, DecimalPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatChipsModule } from '@angular/material/chips';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TabGroupComponent, TabComponent } from '../../shared/components/index.js';
import { ClientHeaderComponent } from './client-detail/client-header.component';
import { ClientService, Client } from '../../core/services/client.service';
import { IntegrationService, type ClientIntegration } from '../../core/services/integration.service';
import { TicketService, Ticket } from '../../core/services/ticket.service';
import { IntegrationDialogComponent } from '../integrations/integration-dialog.component';
import { TicketDialogComponent } from '../tickets/ticket-dialog.component';
import { DialogComponent } from '../../shared/components/dialog.component';
import { ClientSystemsTabComponent } from './client-detail/tabs/systems-tab.component';
import { ClientContactsTabComponent } from './client-detail/tabs/contacts-tab.component';
import { ClientReposTabComponent } from './client-detail/tabs/repos-tab.component';
import { ClientMemoryService, type ClientMemory } from '../../core/services/client-memory.service';
import { ClientMemoryDialogComponent } from './client-memory-dialog.component';
import { McpServerInfoComponent } from '../../shared/components/mcp-server-info.component';
import { ClientUserService, type ClientUser } from '../../core/services/client-user.service';
import { ClientUserDialogComponent } from './client-user-dialog.component';
import { ClientEnvironmentService, type ClientEnvironment } from '../../core/services/client-environment.service';
import { ClientEnvironmentDialogComponent } from './client-environment-dialog.component';
import { InvoiceService, type Invoice } from '../../core/services/invoice.service';
import { GenerateInvoiceDialogComponent } from './generate-invoice-dialog.component';
import { ClientAiCredentialService, type ClientAiCredential } from '../../core/services/client-ai-credential.service';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { AiUsageService, type AiUsageClientSummary, type AiUsageLogEntry } from '../../core/services/ai-usage.service';
import { ToastService } from '../../core/services/toast.service';

const CLIENT_DETAIL_TAB_SLUGS = [
  'systems',
  'contacts',
  'repos',
  'integrations',
  'tickets',
  'memory',
  'environments',
  'users',
  'ai-credentials',
  'invoices',
  'ai-usage',
] as const;
type ClientDetailTabSlug = (typeof CLIENT_DETAIL_TAB_SLUGS)[number];
const AI_USAGE_TAB_INDEX = CLIENT_DETAIL_TAB_SLUGS.indexOf('ai-usage');

@Component({
  standalone: true,
  imports: [
    RouterLink, JsonPipe, DatePipe, SlicePipe, DecimalPipe, MatCardModule, MatButtonModule, MatIconModule,
    MatTableModule, MatChipsModule, MatSlideToggleModule, MatTooltipModule, McpServerInfoComponent,
    FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    TabGroupComponent, TabComponent, ClientHeaderComponent,
    ClientSystemsTabComponent, ClientContactsTabComponent, ClientReposTabComponent,
    DialogComponent, TicketDialogComponent,
    ClientMemoryDialogComponent, ClientEnvironmentDialogComponent, ClientUserDialogComponent, GenerateInvoiceDialogComponent,
    IntegrationDialogComponent,
  ],
  template: `
    @if (client(); as c) {
      <app-client-header [client]="c" (clientChange)="onClientUpdated($event)" />

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">
        <app-tab label="Systems">
          <app-client-systems-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Contacts">
          <app-client-contacts-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Repos">
          <app-client-repos-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Integrations">
          <div class="tab-content">
            <div class="tab-header">
              <h3>Integrations</h3>
              <button mat-raised-button color="primary" (click)="addIntegration()">
                <mat-icon>add</mat-icon> Add Integration
              </button>
            </div>
            @for (integ of integrations(); track integ.id) {
              <mat-card class="integration-card">
                <mat-card-content>
                  <div class="integ-header">
                    <mat-icon>{{ integrationIcon(integ.type) }}</mat-icon>
                    <strong>{{ integ.type }}</strong>
                    @if (integ.label && integ.label !== 'default') {
                      <span class="label-chip">{{ integ.label }}</span>
                    }
                    <mat-slide-toggle [checked]="integ.isActive" (change)="toggleIntegration(integ, $event.checked)">
                      {{ integ.isActive ? 'Active' : 'Inactive' }}
                    </mat-slide-toggle>
                    <span class="spacer"></span>
                    <button mat-icon-button (click)="editIntegration(integ)">
                      <mat-icon>edit</mat-icon>
                    </button>
                    <button mat-icon-button color="warn" (click)="deleteIntegration(integ.id)">
                      <mat-icon>delete</mat-icon>
                    </button>
                  </div>
                  @if (integ.notes) { <p class="integ-notes">{{ integ.notes }}</p> }
                  @if (integ.type === 'MCP_DATABASE' && integ.metadata) {
                    <app-mcp-server-info
                      [metadata]="integ.metadata"
                      [integrationId]="integ.id"
                      (verified)="load()"
                    />
                  } @else {
                    <pre class="config-preview">{{ redactConfig(integ.config) | json }}</pre>
                  }
                </mat-card-content>
              </mat-card>
            } @empty {
              <p class="empty">No integrations configured. Add IMAP, Azure DevOps, or MCP Database integrations.</p>
            }
          </div>
        </app-tab>

        <app-tab label="Tickets">
          <div class="tab-content">
            <div class="tab-header">
              <h3>Tickets</h3>
              <button mat-raised-button color="primary" (click)="createTicket()">
                <mat-icon>add</mat-icon> Create Ticket
              </button>
            </div>
            <table mat-table [dataSource]="tickets()" class="full-width">
              <ng-container matColumnDef="subject">
                <th mat-header-cell *matHeaderCellDef>Subject</th>
                <td mat-cell *matCellDef="let t">
                  <a [routerLink]="['/tickets', t.id]" class="link">{{ t.subject }}</a>
                </td>
              </ng-container>
              <ng-container matColumnDef="status">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let t">{{ t.status }}</td>
              </ng-container>
              <ng-container matColumnDef="priority">
                <th mat-header-cell *matHeaderCellDef>Priority</th>
                <td mat-cell *matCellDef="let t">
                  <span class="priority priority-{{ t.priority.toLowerCase() }}">{{ t.priority }}</span>
                </td>
              </ng-container>
              <ng-container matColumnDef="category">
                <th mat-header-cell *matHeaderCellDef>Category</th>
                <td mat-cell *matCellDef="let t">{{ t.category ?? '-' }}</td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="ticketColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: ticketColumns;"></tr>
            </table>
            @if (tickets().length === 0) { <p class="empty">No tickets for this client.</p> }
          </div>
        </app-tab>

        <app-tab label="Memory">
          <div class="tab-content">
            <div class="tab-header">
              <h3>AI Memory</h3>
              <button mat-raised-button color="primary" (click)="addMemory()">
                <mat-icon>add</mat-icon> Add Memory
              </button>
              <mat-form-field appearance="outline" class="compact-select">
                <mat-label>Source</mat-label>
                <mat-select [(ngModel)]="memSourceFilter" (ngModelChange)="filterMemories()">
                  <mat-option value="">All</mat-option>
                  <mat-option value="MANUAL">Manual</mat-option>
                  <mat-option value="AI_LEARNED">AI Learned</mat-option>
                </mat-select>
              </mat-form-field>
            </div>
            @for (mem of filteredMemories(); track mem.id) {
              <mat-card class="memory-card" [class.inactive-card]="!mem.isActive">
                <mat-card-content>
                  <div class="memory-header">
                    <mat-icon>{{ memoryTypeIcon(mem.memoryType) }}</mat-icon>
                    <strong>{{ mem.title }}</strong>
                    <span class="type-chip type-{{ mem.memoryType.toLowerCase() }}">{{ mem.memoryType }}</span>
                    <span class="source-badge source-{{ (mem.source ?? 'MANUAL').toLowerCase() }}">
                      {{ (mem.source ?? 'MANUAL') === 'AI_LEARNED' ? 'AI' : 'MANUAL' }}
                    </span>
                    @if (mem.category) {
                      <span class="category-chip">{{ mem.category }}</span>
                    }
                    <mat-slide-toggle [checked]="mem.isActive" (change)="toggleMemory(mem, $event.checked)">
                      {{ mem.isActive ? 'Active' : 'Inactive' }}
                    </mat-slide-toggle>
                    <span class="spacer"></span>
                    <button mat-icon-button (click)="editMemory(mem)"><mat-icon>edit</mat-icon></button>
                    <button mat-icon-button color="warn" (click)="deleteMemory(mem.id)"><mat-icon>delete</mat-icon></button>
                  </div>
                  @if (mem.tags.length) {
                    <div class="tags">
                      @for (tag of mem.tags; track tag) {
                        <span class="tag-chip">{{ tag }}</span>
                      }
                    </div>
                  }
                  <pre class="memory-content">{{ mem.content }}</pre>
                </mat-card-content>
              </mat-card>
            } @empty {
              <p class="empty">No memory entries. Add context, playbooks, or tool guidance to help AI analyze tickets for this client.</p>
            }
          </div>
        </app-tab>

        <app-tab label="Environments">
          <div class="tab-content">
            <div class="tab-header">
              <h3>Environments</h3>
              <button mat-raised-button color="primary" (click)="addEnvironment()">
                <mat-icon>add</mat-icon> Add Environment
              </button>
            </div>
            @for (env of environments(); track env.id) {
              <mat-card class="env-card" [class.inactive-card]="!env.isActive">
                <mat-card-content>
                  <div class="env-header">
                    <mat-icon>cloud</mat-icon>
                    <strong>{{ env.name }}</strong>
                    <span class="tag-chip">{{ env.tag }}</span>
                    @if (env.isDefault) {
                      <span class="default-chip">Default</span>
                    }
                    <mat-slide-toggle [checked]="env.isActive" (change)="toggleEnvironment(env, $event.checked)">
                      {{ env.isActive ? 'Active' : 'Inactive' }}
                    </mat-slide-toggle>
                    <span class="spacer"></span>
                    <button mat-icon-button (click)="editEnvironment(env)"><mat-icon>edit</mat-icon></button>
                    <button mat-icon-button color="warn" (click)="deleteEnvironment(env)"><mat-icon>delete</mat-icon></button>
                  </div>
                  @if (env.description) { <p class="env-desc">{{ env.description }}</p> }
                  @if (env.operationalInstructions) {
                    <pre class="memory-content">{{ env.operationalInstructions | slice:0:200 }}{{ env.operationalInstructions.length > 200 ? '...' : '' }}</pre>
                  }
                </mat-card-content>
              </mat-card>
            } @empty {
              <p class="empty">No environments configured. Add environments (e.g. Production, Development) to group systems, repos, and integrations.</p>
            }
          </div>
        </app-tab>

        <app-tab label="Users">
          <div class="tab-content">
            <div class="tab-header">
              <h3>Portal Users</h3>
              <button mat-raised-button color="primary" (click)="addClientUser()">
                <mat-icon>add</mat-icon> Add User
              </button>
            </div>
            <table mat-table [dataSource]="clientUsers()" class="full-width">
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
              <ng-container matColumnDef="isActiveUser">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let u">
                  <mat-chip [class.inactive]="!u.isActive">{{ u.isActive ? 'Active' : 'Inactive' }}</mat-chip>
                </td>
              </ng-container>
              <ng-container matColumnDef="lastLogin">
                <th mat-header-cell *matHeaderCellDef>Last Login</th>
                <td mat-cell *matCellDef="let u">{{ u.lastLoginAt ? (u.lastLoginAt | date:'short') : 'Never' }}</td>
              </ng-container>
              <ng-container matColumnDef="userActions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let u">
                  <button mat-icon-button (click)="editClientUser(u)"><mat-icon>edit</mat-icon></button>
                  <button mat-icon-button color="warn" (click)="deleteClientUser(u.id)"><mat-icon>person_off</mat-icon></button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="clientUserColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: clientUserColumns;"></tr>
            </table>
            @if (clientUsers().length === 0) { <p class="empty">No portal users for this client.</p> }
          </div>
        </app-tab>
        <app-tab label="AI Credentials">
          <div class="tab-content">
            <div class="tab-header">
              <h3>AI Credentials (BYOK)</h3>
            </div>
            <table mat-table [dataSource]="aiCredentials()" class="full-width">
              <ng-container matColumnDef="provider">
                <th mat-header-cell *matHeaderCellDef>Provider</th>
                <td mat-cell *matCellDef="let cred">{{ cred.provider }}</td>
              </ng-container>
              <ng-container matColumnDef="label">
                <th mat-header-cell *matHeaderCellDef>Label</th>
                <td mat-cell *matCellDef="let cred">{{ cred.label }}</td>
              </ng-container>
              <ng-container matColumnDef="key">
                <th mat-header-cell *matHeaderCellDef>API Key</th>
                <td mat-cell *matCellDef="let cred"><code>...{{ cred.last4 }}</code></td>
              </ng-container>
              <ng-container matColumnDef="credStatus">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let cred">
                  <mat-slide-toggle [checked]="cred.isActive" (change)="toggleCredential(cred, $event.checked)">
                    {{ cred.isActive ? 'Active' : 'Inactive' }}
                  </mat-slide-toggle>
                </td>
              </ng-container>
              <ng-container matColumnDef="credActions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let cred">
                  <button mat-icon-button matTooltip="Test" (click)="testCredential(cred)"><mat-icon>play_arrow</mat-icon></button>
                  <button mat-icon-button color="warn" matTooltip="Delete" (click)="deleteCredential(cred)"><mat-icon>delete</mat-icon></button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="credentialColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: credentialColumns;"></tr>
            </table>
            @if (aiCredentials().length === 0) { <p class="empty">No AI credentials configured. Add credentials to use BYOK mode.</p> }

            <mat-card class="add-cred-card">
              <mat-card-content>
                <h4>Add Credential</h4>
                <div class="cred-form">
                  <mat-form-field>
                    <mat-label>Provider</mat-label>
                    <mat-select [(ngModel)]="newCredProvider">
                      <mat-option value="CLAUDE">CLAUDE</mat-option>
                      <mat-option value="OPENAI">OPENAI</mat-option>
                      <mat-option value="GROK">GROK</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <mat-form-field>
                    <mat-label>Label</mat-label>
                    <input matInput [(ngModel)]="newCredLabel" placeholder="e.g. Production Key">
                  </mat-form-field>
                  <mat-form-field>
                    <mat-label>API Key</mat-label>
                    <input matInput type="password" [(ngModel)]="newCredApiKey" placeholder="sk-...">
                  </mat-form-field>
                  <button mat-raised-button color="primary" (click)="addCredential()" [disabled]="!newCredProvider || !newCredLabel || !newCredApiKey">
                    <mat-icon>add</mat-icon> Add
                  </button>
                </div>
              </mat-card-content>
            </mat-card>
          </div>
        </app-tab>

        <app-tab label="Invoices">
          <div class="tab-content">
            <div class="tab-header">
              <h3>Invoices</h3>
              <button mat-raised-button color="primary" (click)="openGenerateInvoiceDialog()">
                <mat-icon>receipt_long</mat-icon> Generate Invoice
              </button>
            </div>
            <table mat-table [dataSource]="invoices()" class="full-width">
              <ng-container matColumnDef="invoiceNumber">
                <th mat-header-cell *matHeaderCellDef>#</th>
                <td mat-cell *matCellDef="let inv">{{ inv.invoiceNumber }}</td>
              </ng-container>
              <ng-container matColumnDef="period">
                <th mat-header-cell *matHeaderCellDef>Period</th>
                <td mat-cell *matCellDef="let inv">
                  {{ inv.periodStart | date:'mediumDate' }} – {{ inv.periodEnd | date:'mediumDate' }}
                </td>
              </ng-container>
              <ng-container matColumnDef="requests">
                <th mat-header-cell *matHeaderCellDef>Requests</th>
                <td mat-cell *matCellDef="let inv">{{ inv.requestCount }}</td>
              </ng-container>
              <ng-container matColumnDef="totalBilled">
                <th mat-header-cell *matHeaderCellDef>Total Billed</th>
                <td mat-cell *matCellDef="let inv">\${{ inv.totalBilledCostUsd | number:'1.2-2' }}</td>
              </ng-container>
              <ng-container matColumnDef="invoiceStatus">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let inv">
                  <mat-chip [class.status-final]="inv.status === 'final'">{{ inv.status }}</mat-chip>
                </td>
              </ng-container>
              <ng-container matColumnDef="invoiceActions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let inv">
                  <a mat-icon-button [href]="getInvoiceDownloadUrl(inv.id)" target="_blank" rel="noopener noreferrer" matTooltip="Download PDF">
                    <mat-icon>download</mat-icon>
                  </a>
                  <button mat-icon-button color="warn" (click)="deleteInvoice(inv)" matTooltip="Delete">
                    <mat-icon>delete</mat-icon>
                  </button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="invoiceColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: invoiceColumns;"></tr>
            </table>
            @if (invoices().length === 0) { <p class="empty">No invoices generated yet.</p> }
          </div>
        </app-tab>

        <app-tab label="AI Usage">
          <div class="tab-content">
            <div class="tab-header">
              <h3>AI Usage</h3>
              <button mat-raised-button (click)="loadAiUsage()">
                <mat-icon>refresh</mat-icon> Refresh
              </button>
            </div>
            @if (aiUsageLoading()) {
              <p>Loading AI usage data...</p>
            } @else if (aiUsageSummary()) {
              <div class="kpi-grid">
                @for (w of aiUsageSummary()!.windows; track w.label) {
                  <mat-card class="kpi-card">
                    <mat-card-header><mat-card-title>{{ w.label }}</mat-card-title></mat-card-header>
                    <mat-card-content>
                      <div class="kpi-row"><span class="kpi-label">Tokens In</span><span class="kpi-value">{{ w.inputTokens | number }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Tokens Out</span><span class="kpi-value">{{ w.outputTokens | number }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Base Cost</span><span class="kpi-value">\${{ w.baseCostUsd | number:'1.4-4' }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Billed Cost</span><span class="kpi-value kpi-billed">\${{ w.billedCostUsd | number:'1.4-4' }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Requests</span><span class="kpi-value">{{ w.requestCount | number }}</span></div>
                    </mat-card-content>
                  </mat-card>
                }
              </div>
              <p class="markup-note">Billing markup: {{ aiUsageSummary()!.billingMarkupPercent }}x</p>

              <h4>Prompt Log</h4>
              <div class="log-nav">
                <button mat-button [disabled]="aiUsagePage() <= 0" (click)="aiUsagePrevPage()">Previous</button>
                <span>Page {{ aiUsagePage() + 1 }} of {{ aiUsageTotalPages() }}</span>
                <button mat-button [disabled]="aiUsagePage() >= aiUsageTotalPages() - 1" (click)="aiUsageNextPage()">Next</button>
              </div>
              <table mat-table [dataSource]="aiUsageLogs()" class="full-width">
                <ng-container matColumnDef="createdAt">
                  <th mat-header-cell *matHeaderCellDef>Time</th>
                  <td mat-cell *matCellDef="let l">{{ l.createdAt | date:'short' }}</td>
                </ng-container>
                <ng-container matColumnDef="taskType">
                  <th mat-header-cell *matHeaderCellDef>Task</th>
                  <td mat-cell *matCellDef="let l">{{ l.taskType }}</td>
                </ng-container>
                <ng-container matColumnDef="model">
                  <th mat-header-cell *matHeaderCellDef>Model</th>
                  <td mat-cell *matCellDef="let l">{{ l.model }}</td>
                </ng-container>
                <ng-container matColumnDef="provider">
                  <th mat-header-cell *matHeaderCellDef>Provider</th>
                  <td mat-cell *matCellDef="let l">{{ l.provider }}</td>
                </ng-container>
                <ng-container matColumnDef="inputTokens">
                  <th mat-header-cell *matHeaderCellDef>In</th>
                  <td mat-cell *matCellDef="let l">{{ l.inputTokens | number }}</td>
                </ng-container>
                <ng-container matColumnDef="outputTokens">
                  <th mat-header-cell *matHeaderCellDef>Out</th>
                  <td mat-cell *matCellDef="let l">{{ l.outputTokens | number }}</td>
                </ng-container>
                <ng-container matColumnDef="costUsd">
                  <th mat-header-cell *matHeaderCellDef>Cost</th>
                  <td mat-cell *matCellDef="let l">{{ l.costUsd != null ? '\$' + (l.costUsd | number:'1.4-4') : '-' }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="aiUsageLogColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: aiUsageLogColumns;"></tr>
              </table>
              @if (aiUsageLogs().length === 0) { <p class="empty">No AI usage logs for this client.</p> }
            } @else {
              <p class="empty">No AI usage data available. Click Refresh to load.</p>
            }
          </div>
        </app-tab>
      </app-tab-group>
    } @else {
      <p>Loading...</p>
    }

    @if (showTicketDialog()) {
      <app-dialog [open]="true" title="Create Ticket" maxWidth="560px" (openChange)="showTicketDialog.set(false)">
        <app-ticket-dialog-content
          [clientId]="id()"
          (created)="onTicketCreated($event)"
          (cancelled)="showTicketDialog.set(false)" />
      </app-dialog>
    }

    @if (showMemoryDialog()) {
      <app-dialog [open]="true" [title]="editingMemory() ? 'Edit Client Memory' : 'Add Client Memory'" maxWidth="650px" (openChange)="showMemoryDialog.set(false)">
        <app-client-memory-dialog-content
          [clientId]="id()"
          [memory]="editingMemory() ?? undefined"
          (saved)="onMemorySaved()"
          (cancelled)="showMemoryDialog.set(false)" />
      </app-dialog>
    }

    @if (showEnvironmentDialog()) {
      <app-dialog [open]="true" [title]="editingEnvironment() ? 'Edit Environment' : 'Add Environment'" maxWidth="650px" (openChange)="showEnvironmentDialog.set(false)">
        <app-client-environment-dialog-content
          [clientId]="id()"
          [environment]="editingEnvironment() ?? undefined"
          (saved)="onEnvironmentSaved()"
          (cancelled)="showEnvironmentDialog.set(false)" />
      </app-dialog>
    }

    @if (showUserDialog()) {
      <app-dialog [open]="true" [title]="editingUser() ? 'Edit User' : 'Create Portal User'" maxWidth="500px" (openChange)="showUserDialog.set(false)">
        <app-client-user-dialog-content
          [clientId]="id()"
          [user]="editingUser() ?? undefined"
          (saved)="onUserSaved()"
          (cancelled)="showUserDialog.set(false)" />
      </app-dialog>
    }

    @if (showInvoiceDialog()) {
      <app-dialog [open]="true" title="Generate Invoice" maxWidth="400px" (openChange)="showInvoiceDialog.set(false)">
        <app-generate-invoice-dialog-content
          [clientId]="id()"
          (generated)="onInvoiceGenerated()"
          (cancelled)="showInvoiceDialog.set(false)" />
      </app-dialog>
    }

    @if (showIntegrationDialog()) {
      <app-dialog [open]="true" [title]="editingIntegration() ? 'Edit Integration' : 'Add Integration'" maxWidth="600px" (openChange)="showIntegrationDialog.set(false)">
        <app-integration-dialog-content
          [clientId]="id()"
          [integration]="editingIntegration() ?? undefined"
          (saved)="onIntegrationSaved()"
          (cancelled)="showIntegrationDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .tab-content { padding: 16px 0; }
    .tab-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .tab-header h3 { margin: 0; }
    .full-width { width: 100%; }
    .link { text-decoration: none; color: #3f51b5; }
    .engine-chip { font-size: 11px; padding: 2px 6px; background: #e0f2f1; border-radius: 4px; color: #00695c; font-family: monospace; }
    .inactive { opacity: 0.5; }
    .primary-icon { color: #f9a825; font-size: 20px; }
    .empty { color: #999; padding: 16px; text-align: center; }
    .integration-card { margin-bottom: 12px; }
    .integ-header { display: flex; align-items: center; gap: 8px; }
    .integ-notes { color: #666; margin: 8px 0 4px; }
    .label-chip { font-size: 11px; padding: 2px 6px; background: #e8f5e9; border-radius: 4px; color: #2e7d32; font-family: monospace; }
    .config-preview { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; font-size: 12px; overflow-x: auto; }
    .spacer { flex: 1; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    code { font-size: 13px; }
    .memory-card { margin-bottom: 12px; }
    .memory-card.inactive-card { opacity: 0.5; }
    .memory-header { display: flex; align-items: center; gap: 8px; }
    .type-chip { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .type-context { background: #e3f2fd; color: #1565c0; }
    .type-playbook { background: #fce4ec; color: #c62828; }
    .type-tool_guidance { background: #f3e5f5; color: #6a1b9a; }
    .source-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
    .source-manual { background: #f5f5f5; color: #999; }
    .source-ai_learned { background: #ede7f6; color: #6a1b9a; }
    .category-chip { font-size: 11px; padding: 2px 6px; background: #fff3e0; color: #e65100; border-radius: 4px; }
    .tags { display: flex; gap: 4px; margin: 8px 0 4px; flex-wrap: wrap; }
    .tag-chip { font-size: 11px; padding: 2px 6px; background: #f5f5f5; color: #616161; border-radius: 4px; }
    .memory-content { background: #fafafa; padding: 8px 12px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-wrap: break-word; max-height: 200px; overflow-y: auto; }
    .type-admin { background: #e3f2fd; color: #1565c0; }
    .env-card { margin-bottom: 12px; }
    .env-card.inactive-card { opacity: 0.5; }
    .env-header { display: flex; align-items: center; gap: 8px; }
    .env-desc { color: #666; margin: 8px 0 4px; }
    .default-chip { font-size: 11px; padding: 2px 6px; background: #e3f2fd; color: #1565c0; border-radius: 4px; font-weight: 600; }
    .status-final { background: #e8f5e9; color: #2e7d32; }
    .add-cred-card { margin-top: 16px; }
    .add-cred-card h4 { margin: 0 0 12px; }
    .cred-form { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .cred-form mat-form-field { flex: 1; min-width: 160px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 12px; }
    .kpi-card { }
    .kpi-row { display: flex; justify-content: space-between; padding: 2px 0; }
    .kpi-label { color: #666; font-size: 13px; }
    .kpi-value { font-weight: 500; font-family: monospace; font-size: 13px; }
    .kpi-billed { color: #2e7d32; font-weight: 600; }
    .markup-note { color: #888; font-size: 12px; margin-bottom: 16px; }
    .log-nav { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  `],
})
export class ClientDetailComponent implements OnInit {
  id = input.required<string>();

  private clientService = inject(ClientService);
  private integrationService = inject(IntegrationService);
  private ticketService = inject(TicketService);
  private memoryService = inject(ClientMemoryService);
  private clientUserService = inject(ClientUserService);
  private envService = inject(ClientEnvironmentService);
  private invoiceService = inject(InvoiceService);
  private credentialService = inject(ClientAiCredentialService);
  private aiUsageService = inject(AiUsageService);
  private destroyRef = inject(DestroyRef);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  client = signal<Client | null>(null);
  integrations = signal<ClientIntegration[]>([]);
  tickets = signal<Ticket[]>([]);
  memories = signal<ClientMemory[]>([]);
  memSourceFilter = '';
  filteredMemories = signal<ClientMemory[]>([]);
  clientUsers = signal<ClientUser[]>([]);
  environments = signal<ClientEnvironment[]>([]);
  invoices = signal<Invoice[]>([]);
  aiCredentials = signal<ClientAiCredential[]>([]);
  aiUsageSummary = signal<AiUsageClientSummary | null>(null);
  aiUsageLogs = signal<AiUsageLogEntry[]>([]);
  aiUsageLoading = signal(false);
  aiUsagePage = signal(0);
  aiUsageTotal = signal(0);
  aiUsageTotalPages = signal(1);
  selectedTab = signal(0);

  ticketColumns = ['subject', 'status', 'priority', 'category'];
  clientUserColumns = ['name', 'email', 'userType', 'isActiveUser', 'lastLogin', 'userActions'];
  invoiceColumns = ['invoiceNumber', 'period', 'requests', 'totalBilled', 'invoiceStatus', 'invoiceActions'];
  credentialColumns = ['provider', 'label', 'key', 'credStatus', 'credActions'];
  aiUsageLogColumns = ['createdAt', 'taskType', 'model', 'provider', 'inputTokens', 'outputTokens', 'costUsd'];
  private readonly AI_USAGE_PAGE_SIZE = 25;

  newCredProvider = '';
  newCredLabel = '';
  newCredApiKey = '';

  ngOnInit(): void {
    const tabParam = this.route.snapshot.queryParamMap.get('tab');
    if (tabParam !== null) {
      const slugIdx = (CLIENT_DETAIL_TAB_SLUGS as readonly string[]).indexOf(tabParam);
      if (slugIdx >= 0) {
        this.selectedTab.set(slugIdx);
      } else {
        // Backwards compat: numeric ?tab=N from older bookmarks.
        const tab = Number(tabParam);
        if (Number.isInteger(tab) && tab >= 0 && tab < CLIENT_DETAIL_TAB_SLUGS.length) {
          this.selectedTab.set(tab);
        }
      }
    }
    this.load();
    if (this.selectedTab() === AI_USAGE_TAB_INDEX) this.loadAiUsage();
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    const slug: ClientDetailTabSlug = CLIENT_DETAIL_TAB_SLUGS[index] ?? CLIENT_DETAIL_TAB_SLUGS[0];
    this.router.navigate([], { queryParams: { tab: slug }, queryParamsHandling: 'merge', replaceUrl: true });
    if (index === AI_USAGE_TAB_INDEX && !this.aiUsageSummary()) this.loadAiUsage();
  }

  load(): void {
    const cid = this.id();
    this.clientService.getClient(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => this.client.set(c));
    this.integrationService.getIntegrations(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(i => this.integrations.set(i));
    this.ticketService.getTickets({ clientId: cid, limit: 20 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(t => this.tickets.set(t));
    this.memoryService.getMemories({ clientId: cid }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(m => { this.memories.set(m); this.filterMemories(); });
    this.clientUserService.getUsers(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(u => this.clientUsers.set(u));
    this.envService.getEnvironments(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(e => this.environments.set(e));
    this.invoiceService.getInvoices(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(i => this.invoices.set(i));
    this.credentialService.getCredentials(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => this.aiCredentials.set(c));
  }

  loadAiUsage(): void {
    const cid = this.id();
    this.aiUsageLoading.set(true);
    this.aiUsageService.getClientSummary(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (summary) => {
        this.aiUsageSummary.set(summary);
        this.aiUsageLoading.set(false);
      },
      error: () => this.aiUsageLoading.set(false),
    });
    this.loadAiUsageLogs();
  }

  private loadAiUsageLogs(): void {
    const cid = this.id();
    const page = this.aiUsagePage();
    this.aiUsageService.getClientLogs(cid, { limit: this.AI_USAGE_PAGE_SIZE, offset: page * this.AI_USAGE_PAGE_SIZE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        this.aiUsageLogs.set(res.logs);
        this.aiUsageTotal.set(res.total);
        this.aiUsageTotalPages.set(Math.max(1, Math.ceil(res.total / this.AI_USAGE_PAGE_SIZE)));
      });
  }

  aiUsagePrevPage(): void {
    if (this.aiUsagePage() > 0) {
      this.aiUsagePage.update(p => p - 1);
      this.loadAiUsageLogs();
    }
  }

  aiUsageNextPage(): void {
    if (this.aiUsagePage() < this.aiUsageTotalPages() - 1) {
      this.aiUsagePage.update(p => p + 1);
      this.loadAiUsageLogs();
    }
  }

  onClientUpdated(updated: Client): void {
    this.client.set(updated);
  }

  addIntegration(): void {
    this.editingIntegration.set(null);
    this.showIntegrationDialog.set(true);
  }

  onIntegrationSaved(): void {
    this.showIntegrationDialog.set(false);
    this.load();
  }

  showTicketDialog = signal(false);
  showMemoryDialog = signal(false);
  editingMemory = signal<ClientMemory | null>(null);
  showEnvironmentDialog = signal(false);
  editingEnvironment = signal<ClientEnvironment | null>(null);
  showUserDialog = signal(false);
  editingUser = signal<ClientUser | null>(null);
  showInvoiceDialog = signal(false);
  showIntegrationDialog = signal(false);
  editingIntegration = signal<ClientIntegration | null>(null);

  createTicket(): void {
    this.showTicketDialog.set(true);
  }

  onTicketCreated(_result: { id: string }): void {
    this.showTicketDialog.set(false);
    this.load();
  }

  toggleIntegration(integ: ClientIntegration, checked: boolean): void {
    // Optimistic update so toggle doesn't snap back
    this.integrations.update(list => list.map(i => i.id === integ.id ? { ...i, isActive: checked } : i));
    this.integrationService.updateIntegration(integ.id, { isActive: checked }).subscribe({
      next: () => {
        this.toast.success(`Integration ${checked ? 'enabled' : 'disabled'}`);
      },
      error: (err) => {
        // Revert optimistic update and reload authoritative state
        this.integrations.update(list => list.map(i => i.id === integ.id ? { ...i, isActive: !checked } : i));
        this.toast.error(err.error?.message ?? err.error?.error ?? 'Toggle failed');
        this.load();
      },
    });
  }

  editIntegration(integ: ClientIntegration): void {
    this.editingIntegration.set(integ);
    this.showIntegrationDialog.set(true);
  }

  deleteIntegration(id: string): void {
    this.integrationService.deleteIntegration(id).subscribe({
      next: () => {
        this.toast.success('Integration deleted');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
    });
  }

  filterMemories(): void {
    const all = this.memories();
    if (!this.memSourceFilter) {
      this.filteredMemories.set(all);
    } else {
      this.filteredMemories.set(all.filter(m => (m.source ?? 'MANUAL') === this.memSourceFilter));
    }
  }

  addMemory(): void {
    this.editingMemory.set(null);
    this.showMemoryDialog.set(true);
  }

  editMemory(mem: ClientMemory): void {
    this.editingMemory.set(mem);
    this.showMemoryDialog.set(true);
  }

  onMemorySaved(): void {
    this.showMemoryDialog.set(false);
    this.load();
  }

  toggleMemory(mem: ClientMemory, checked: boolean): void {
    this.memories.update(list => list.map(m => m.id === mem.id ? { ...m, isActive: checked } : m));
    this.filterMemories();
    this.memoryService.updateMemory(mem.id, { isActive: checked }).subscribe({
      next: () => this.toast.success(`Memory ${checked ? 'enabled' : 'disabled'}`),
      error: (err) => {
        this.memories.update(list => list.map(m => m.id === mem.id ? { ...m, isActive: !checked } : m));
        this.filterMemories();
        this.toast.error(err.error?.message ?? err.error?.error ?? 'Toggle failed');
      },
    });
  }

  deleteMemory(id: string): void {
    this.memoryService.deleteMemory(id).subscribe({
      next: () => {
        this.toast.success('Memory entry deleted');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
    });
  }

  addEnvironment(): void {
    this.editingEnvironment.set(null);
    this.showEnvironmentDialog.set(true);
  }

  editEnvironment(env: ClientEnvironment): void {
    this.editingEnvironment.set(env);
    this.showEnvironmentDialog.set(true);
  }

  onEnvironmentSaved(): void {
    this.showEnvironmentDialog.set(false);
    this.load();
  }

  toggleEnvironment(env: ClientEnvironment, checked: boolean): void {
    this.environments.update(list => list.map(e => e.id === env.id ? { ...e, isActive: checked } : e));
    this.envService.updateEnvironment(this.id(), env.id, { isActive: checked }).subscribe({
      next: () => this.toast.success(`Environment ${checked ? 'enabled' : 'disabled'}`),
      error: (err) => {
        this.environments.update(list => list.map(e => e.id === env.id ? { ...e, isActive: !checked } : e));
        this.toast.error(err.error?.error ?? err.error?.message ?? 'Toggle failed');
      },
    });
  }

  deleteEnvironment(env: ClientEnvironment): void {
    if (!confirm(`Delete environment "${env.name}"? Linked integrations, repos, and systems will be unlinked.`)) return;
    this.envService.deleteEnvironment(this.id(), env.id).subscribe({
      next: () => {
        this.toast.success('Environment deleted');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.error ?? err.error?.message ?? 'Delete failed'),
    });
  }

  memoryTypeIcon(type: string): string {
    switch (type) {
      case 'CONTEXT': return 'info';
      case 'PLAYBOOK': return 'menu_book';
      case 'TOOL_GUIDANCE': return 'build';
      default: return 'psychology';
    }
  }

  redactConfig(config: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['encryptedPassword', 'encryptedPat', 'password', 'pat', 'token', 'secret', 'apiKey'];
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      redacted[key] = sensitiveKeys.includes(key) ? '********' : value;
    }
    return redacted;
  }

  integrationIcon(type: string): string {
    switch (type) {
      case 'IMAP': return 'email';
      case 'AZURE_DEVOPS': return 'developer_board';
      case 'MCP_DATABASE': return 'dns';
      case 'SLACK': return 'chat';
      default: return 'extension';
    }
  }

  addClientUser(): void {
    this.editingUser.set(null);
    this.showUserDialog.set(true);
  }

  editClientUser(user: ClientUser): void {
    this.editingUser.set(user);
    this.showUserDialog.set(true);
  }

  onUserSaved(): void {
    this.showUserDialog.set(false);
    this.load();
  }

  deleteClientUser(id: string): void {
    this.clientUserService.deleteUser(id).subscribe({
      next: () => {
        this.toast.success('User deactivated');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Deactivation failed'),
    });
  }

  openGenerateInvoiceDialog(): void {
    this.showInvoiceDialog.set(true);
  }

  onInvoiceGenerated(): void {
    this.showInvoiceDialog.set(false);
    this.load();
  }

  getInvoiceDownloadUrl(invoiceId: string): string {
    return this.invoiceService.getDownloadUrl(this.id(), invoiceId);
  }

  deleteInvoice(inv: Invoice): void {
    if (!confirm(`Delete invoice #${inv.invoiceNumber}?`)) return;
    this.invoiceService.deleteInvoice(this.id(), inv.id).subscribe({
      next: () => {
        this.toast.success('Invoice deleted');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
    });
  }

  addCredential(): void {
    const cid = this.id();
    this.credentialService.createCredential(cid, {
      provider: this.newCredProvider,
      apiKey: this.newCredApiKey,
      label: this.newCredLabel,
    }).subscribe({
      next: () => {
        this.newCredProvider = '';
        this.newCredLabel = '';
        this.newCredApiKey = '';
        this.toast.success('Credential added');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Failed to add credential'),
    });
  }

  toggleCredential(cred: ClientAiCredential, checked: boolean): void {
    this.aiCredentials.update(list => list.map(c => c.id === cred.id ? { ...c, isActive: checked } : c));
    this.credentialService.updateCredential(this.id(), cred.id, { isActive: checked }).subscribe({
      next: () => this.toast.success(`Credential ${checked ? 'enabled' : 'disabled'}`),
      error: (err) => {
        this.aiCredentials.update(list => list.map(c => c.id === cred.id ? { ...c, isActive: !checked } : c));
        this.toast.error(err.error?.error ?? 'Toggle failed');
      },
    });
  }

  testCredential(cred: ClientAiCredential): void {
    this.toast.info('Testing credential...');
    this.credentialService.testCredential(this.id(), cred.id).subscribe({
      next: (result) => result.ok ? this.toast.success('Credential is valid') : this.toast.error(`Test failed: ${result.error}`),
      error: (err) => this.toast.error(err.error?.error ?? 'Test failed'),
    });
  }

  deleteCredential(cred: ClientAiCredential): void {
    if (!confirm(`Delete credential "${cred.label}"?`)) return;
    this.credentialService.deleteCredential(this.id(), cred.id).subscribe({
      next: () => {
        this.toast.success('Credential deleted');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }
}
