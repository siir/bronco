import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'relativeTime', standalone: true, pure: true })
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | Date | null | undefined): string {
    if (!value) return '';
    const date = new Date(value);
    if (isNaN(date.getTime())) return String(value);

    const now = Date.now();
    const diffMs = now - date.getTime();

    // Future dates (clock skew or scheduled items)
    if (diffMs < 0) {
      const absSec = Math.floor(-diffMs / 1000);
      if (absSec < 60) return 'just now';
      const absMin = Math.floor(absSec / 60);
      if (absMin < 60) return `in ${absMin}m`;
      const absHr = Math.floor(absMin / 60);
      if (absHr < 24) return `in ${absHr}h`;
      const absDays = Math.floor(absHr / 24);
      return `in ${absDays}d`;
    }

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHr / 24);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
