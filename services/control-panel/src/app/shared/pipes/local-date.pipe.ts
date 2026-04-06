import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'localDate', standalone: true, pure: true })
export class LocalDatePipe implements PipeTransform {
  transform(value: string | Date | null | undefined, includeTime = true): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    if (includeTime) {
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
