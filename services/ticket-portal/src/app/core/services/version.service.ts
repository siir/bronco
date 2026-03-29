import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map, catchError, of } from 'rxjs';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class VersionService {
  private http = inject(HttpClient);

  getVersion() {
    return this.http.get<{ version: string }>(`${environment.apiUrl}/health`).pipe(
      map(res => res.version ?? 'unknown'),
      catchError(() => of('unknown')),
    );
  }
}
