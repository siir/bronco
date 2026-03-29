import { Injectable, inject } from '@angular/core';
import { map, catchError, of } from 'rxjs';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class VersionService {
  private api = inject(ApiService);

  getVersion() {
    return this.api.get<{ version: string }>('/health').pipe(
      map(res => res.version ?? 'unknown'),
      catchError(() => of('unknown')),
    );
  }
}
