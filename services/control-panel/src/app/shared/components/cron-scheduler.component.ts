import { Component, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormFieldComponent } from './form-field.component.js';
import { TextInputComponent } from './text-input.component.js';
import { SelectComponent } from './select.component.js';

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 2 AM', value: '0 2 * * *' },
  { label: 'Daily at 8 AM', value: '0 8 * * *' },
  { label: 'Every Monday at 9 AM', value: '0 9 * * 1' },
  { label: 'Custom', value: '' },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
  const ampm = i < 12 ? 'AM' : 'PM';
  return { value: i, label: `${h12}:00 ${ampm}` };
});

const MINUTE_OPTIONS = [0, 15, 30, 45].map((m) => ({ value: m, label: m.toString().padStart(2, '0') }));

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'America/New_York (Eastern)' },
  { value: 'America/Chicago', label: 'America/Chicago (Central)' },
  { value: 'America/Denver', label: 'America/Denver (Mountain)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (Pacific)' },
  { value: 'UTC', label: 'UTC' },
];

export interface CronSchedulerValue {
  scheduleType: 'time' | 'cron';
  scheduleHour: number;
  scheduleMinute: number;
  selectedDays: boolean[];
  scheduleTimezone: string;
  cronExpression: string;
  /** UTC cron derived from time fields (time mode) or equal to cronExpression (cron mode). */
  utcCron: string;
}

@Component({
  selector: 'app-cron-scheduler',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, SelectComponent],
  template: `
    <app-form-field label="Schedule Type">
      <app-select [value]="scheduleType" [options]="scheduleTypeOptions" (valueChange)="onScheduleTypeChange($event)"></app-select>
    </app-form-field>

    @if (scheduleType === 'time') {
      <div class="time-row">
        <app-form-field label="Hour">
          <app-select [value]="scheduleHour.toString()" [options]="hourSelectOptions" (valueChange)="scheduleHour = +$event; emit()"></app-select>
        </app-form-field>
        <app-form-field label="Minute">
          <app-select [value]="scheduleMinute.toString()" [options]="minuteSelectOptions" (valueChange)="scheduleMinute = +$event; emit()"></app-select>
        </app-form-field>
      </div>

      <div class="days-section">
        <label class="days-label">Days</label>
        <div class="days-row">
          @for (day of dayNames; track $index) {
            <label class="checkbox-item">
              <input type="checkbox" class="form-checkbox" [checked]="selectedDays[$index]" (change)="onDayToggle($index)">
              {{ day }}
            </label>
          }
        </div>
        <span class="days-hint">Leave all unchecked for every day</span>
      </div>

      <app-form-field label="Timezone">
        <app-select [value]="scheduleTimezone" [options]="commonTimezones" (valueChange)="scheduleTimezone = $event; emit()"></app-select>
      </app-form-field>

      <div class="utc-hint">Next run: {{ computedUtcTime }} UTC</div>
    }

    @if (scheduleType === 'cron') {
      <app-form-field label="Schedule Preset">
        <app-select [value]="cronPreset" [options]="cronPresets" (valueChange)="cronPreset = $event; onPresetChange()"></app-select>
      </app-form-field>

      <app-form-field label="Cron Expression" [hint]="cronHumanReadable">
        <app-text-input [value]="cronExpression" (valueChange)="cronExpression = $event; emit()" placeholder="0 * * * *"></app-text-input>
      </app-form-field>
    }
  `,
  styles: [`
    .time-row { display: flex; gap: 12px; }
    .time-row app-form-field { flex: 1; }
    .days-section { margin-bottom: 16px; }
    .days-label { font-size: 12px; color: var(--text-tertiary); display: block; margin-bottom: 4px; }
    .days-row { display: flex; gap: 4px; flex-wrap: wrap; }
    .days-hint { font-size: 11px; color: var(--text-tertiary); display: block; margin-top: 2px; }
    .utc-hint { font-size: 12px; color: var(--color-info); margin-bottom: 12px; padding: 4px 8px; background: var(--color-info-subtle); border-radius: 4px; }
    .checkbox-item { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
    .form-checkbox { width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); }

    @media (max-width: 767.98px) {
      .time-row { flex-direction: column; gap: 12px; }
      .checkbox-item, .form-checkbox { min-height: 44px; }
    }
  `],
})
export class CronSchedulerComponent implements OnInit {
  initialScheduleType = input<'time' | 'cron'>('time');
  initialHour = input<number>(8);
  initialMinute = input<number>(0);
  initialDays = input<boolean[]>([false, false, false, false, false, false, false]);
  initialTimezone = input<string>('America/Chicago');
  initialCronExpression = input<string>('0 * * * *');

  valueChange = output<CronSchedulerValue>();

  scheduleType: 'time' | 'cron' = 'time';
  scheduleHour = 8;
  scheduleMinute = 0;
  scheduleTimezone = 'America/Chicago';
  selectedDays: boolean[] = [false, false, false, false, false, false, false];
  cronExpression = '0 * * * *';
  cronPreset = '';

  scheduleTypeOptions = [
    { value: 'time', label: 'Time-based (recommended)' },
    { value: 'cron', label: 'Custom cron' },
  ];
  cronPresets = CRON_PRESETS;
  hourSelectOptions = HOUR_OPTIONS.map((h) => ({ value: h.value.toString(), label: h.label }));
  minuteSelectOptions = MINUTE_OPTIONS.map((m) => ({ value: m.value.toString(), label: m.label }));
  dayNames = DAY_NAMES;
  commonTimezones = COMMON_TIMEZONES;

  get cronHumanReadable(): string {
    return describeCron(this.cronExpression);
  }

  get computedUtcTime(): string {
    return computeUtcPreview(this.scheduleHour, this.scheduleMinute, this.selectedDays, this.scheduleTimezone);
  }

  ngOnInit(): void {
    this.scheduleType = this.initialScheduleType();
    this.scheduleHour = this.initialHour();
    this.scheduleMinute = this.initialMinute();
    this.selectedDays = [...this.initialDays()];
    this.scheduleTimezone = this.initialTimezone();
    this.cronExpression = this.initialCronExpression();
    const match = CRON_PRESETS.find((pr) => pr.value === this.cronExpression);
    this.cronPreset = match ? match.value : '';
  }

  onScheduleTypeChange(val: string): void {
    this.scheduleType = val === 'cron' ? 'cron' : 'time';
    this.emit();
  }

  onPresetChange(): void {
    if (this.cronPreset) {
      this.cronExpression = this.cronPreset;
    }
    this.emit();
  }

  onDayToggle(index: number): void {
    this.selectedDays = [...this.selectedDays];
    this.selectedDays[index] = !this.selectedDays[index];
    this.emit();
  }

  emit(): void {
    const utcCron = this.scheduleType === 'time'
      ? buildUtcCronFromLocal(this.scheduleHour, this.scheduleMinute, this.selectedDays, this.scheduleTimezone)
      : this.cronExpression;

    this.valueChange.emit({
      scheduleType: this.scheduleType,
      scheduleHour: this.scheduleHour,
      scheduleMinute: this.scheduleMinute,
      selectedDays: [...this.selectedDays],
      scheduleTimezone: this.scheduleTimezone,
      cronExpression: this.cronExpression,
      utcCron,
    });
  }
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour at :00';
  if (min === '0' && hour?.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return `Every ${hour.slice(2)} hours`;
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow === '*') return `Daily at ${hour}:${min.padStart(2, '0')}`;
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = days[Number(dow)] ?? dow;
    return `Every ${dayName} at ${hour}:${min.padStart(2, '0')}`;
  }
  return expr;
}

function computeUtcPreview(hour: number, minute: number, selectedDays: boolean[], timezone: string): string {
  try {
    const now = new Date();
    const localStr = now.toLocaleDateString('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [month, day, year] = localStr.split('/').map(Number);
    const target = new Date(Date.UTC(year, month - 1, day, hour, minute));

    const utcParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(target);
    const localParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(target);

    const getVal = (parts: Intl.DateTimeFormatPart[], type: string) => {
      const v = parts.find((p) => p.type === type)?.value ?? '0';
      return type === 'hour' && v === '24' ? 0 : Number(v);
    };

    const toUtcMillis = (parts: Intl.DateTimeFormatPart[]) =>
      Date.UTC(getVal(parts, 'year'), getVal(parts, 'month') - 1, getVal(parts, 'day'), getVal(parts, 'hour'), getVal(parts, 'minute'));

    const offsetMinutes = Math.round((toUtcMillis(localParts) - toUtcMillis(utcParts)) / 60000);
    let resultMinutes = (hour * 60 + minute) - offsetMinutes;
    if (resultMinutes < 0) resultMinutes += 24 * 60;
    if (resultMinutes >= 24 * 60) resultMinutes -= 24 * 60;

    let utcMinute = minute - (offsetMinutes % 60);
    let utcHour = hour - Math.trunc(offsetMinutes / 60);
    if (utcMinute < 0) { utcMinute += 60; utcHour -= 1; }
    else if (utcMinute >= 60) { utcMinute -= 60; utcHour += 1; }
    let dayShift = 0;
    if (utcHour < 0) { dayShift = -1; }
    else if (utcHour >= 24) { dayShift = 1; }

    const rH = Math.floor(resultMinutes / 60);
    const rM = resultMinutes % 60;

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const anySelected = selectedDays.some(Boolean);
    let displayDays = selectedDays.map((c, i) => c ? i : -1).filter((i) => i >= 0);
    if (dayShift !== 0) {
      displayDays = displayDays.map((d) => ((d + dayShift) % 7 + 7) % 7);
      displayDays.sort((a, b) => a - b);
    }
    const daysText = !anySelected || selectedDays.every(Boolean)
      ? 'Daily'
      : displayDays.map((d) => dayNames[d]).join(', ');

    return `${daysText} at ${rH.toString().padStart(2, '0')}:${rM.toString().padStart(2, '0')}`;
  } catch {
    return 'Unable to compute';
  }
}

/** Convert a local-time schedule into a UTC cron expression using Intl for DST-aware offset. */
function buildUtcCronFromLocal(hour: number, minute: number, selectedDays: boolean[], timezone: string): string {
  try {
    const now = new Date();
    const fmt = (tz: string) => new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);

    const getVal = (parts: Intl.DateTimeFormatPart[], type: string): number => {
      const v = parts.find((p) => p.type === type)?.value ?? '0';
      return type === 'hour' && v === '24' ? 0 : Number(v);
    };
    const toMs = (parts: Intl.DateTimeFormatPart[]) =>
      Date.UTC(getVal(parts, 'year'), getVal(parts, 'month') - 1, getVal(parts, 'day'), getVal(parts, 'hour'), getVal(parts, 'minute'));

    const offsetMinutes = Math.round((toMs(fmt(timezone)) - toMs(fmt('UTC'))) / 60000);

    let utcMinute = minute - (offsetMinutes % 60);
    let utcHour = hour - Math.trunc(offsetMinutes / 60);

    if (utcMinute < 0) { utcMinute += 60; utcHour -= 1; }
    else if (utcMinute >= 60) { utcMinute -= 60; utcHour += 1; }

    let dayShift = 0;
    if (utcHour < 0) { utcHour += 24; dayShift = -1; }
    else if (utcHour >= 24) { utcHour -= 24; dayShift = 1; }

    const anySelected = selectedDays.some(Boolean);
    if (!anySelected) {
      return `${utcMinute} ${utcHour} * * *`;
    }

    const days = selectedDays.map((c, i) => c ? i : -1).filter((i) => i >= 0);
    const shifted = dayShift !== 0 ? days.map((d) => ((d + dayShift) % 7 + 7) % 7) : days;
    const unique = [...new Set(shifted)].sort((a, b) => a - b);
    return `${utcMinute} ${utcHour} * * ${unique.join(',')}`;
  } catch {
    return `${minute} ${hour} * * *`;
  }
}
