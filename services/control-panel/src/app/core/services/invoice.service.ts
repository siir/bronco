import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service.js';

export interface Invoice {
  id: string;
  invoiceNumber: number;
  periodStart: string;
  periodEnd: string;
  totalBaseCostUsd: number;
  totalBilledCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  markupPercent: number;
  status: 'draft' | 'final';
  pdfPath: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class InvoiceService {
  private api = inject(ApiService);

  getInvoices(clientId: string): Observable<Invoice[]> {
    return this.api.get<Invoice[]>(`/clients/${clientId}/invoices`);
  }

  generateInvoice(clientId: string, body: { periodStart: string; periodEnd: string; finalize?: boolean }): Observable<Invoice> {
    return this.api.post<Invoice>(`/clients/${clientId}/invoices/generate`, body);
  }

  updateInvoice(clientId: string, invoiceId: string, body: { status: string }): Observable<Invoice> {
    return this.api.patch<Invoice>(`/clients/${clientId}/invoices/${invoiceId}`, body);
  }

  deleteInvoice(clientId: string, invoiceId: string): Observable<void> {
    return this.api.delete<void>(`/clients/${clientId}/invoices/${invoiceId}`);
  }

  getDownloadUrl(clientId: string, invoiceId: string): string {
    return `/api/clients/${clientId}/invoices/${invoiceId}/download`;
  }
}
