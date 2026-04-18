import { Directive, HostListener, Renderer2, inject, output } from '@angular/core';

@Directive({
  selector: '[appPullToRefresh]',
  standalone: true,
  host: { style: 'overscroll-behavior: contain' },
})
export class PullToRefreshDirective {
  private renderer = inject(Renderer2);

  readonly refresh = output<void>();

  private startY = 0;
  private currentDelta = 0;
  private pulling = false;
  private spinner: HTMLElement | null = null;
  private readonly threshold = 60;

  @HostListener('touchstart', ['$event'])
  onTouchStart(e: TouchEvent): void {
    if (!('ontouchstart' in window)) return;
    if (window.scrollY > 0) return;
    this.startY = e.touches[0].clientY;
    this.currentDelta = 0;
    this.pulling = true;
  }

  @HostListener('touchmove', ['$event'])
  onTouchMove(e: TouchEvent): void {
    if (!this.pulling) return;
    if (window.scrollY > 0) { this.reset(); return; }
    const delta = e.touches[0].clientY - this.startY;
    if (delta <= 0) { this.reset(); return; }
    this.currentDelta = delta;
    this.showSpinner(Math.min(delta, this.threshold));
  }

  @HostListener('touchend')
  onTouchEnd(): void {
    if (!this.pulling) return;
    const delta = this.currentDelta;
    this.reset();
    if (delta >= this.threshold) this.refresh.emit();
  }

  private showSpinner(progress: number): void {
    if (!this.spinner) {
      this.spinner = this.renderer.createElement('div');
      this.renderer.addClass(this.spinner, 'pull-to-refresh-spinner');
      this.renderer.appendChild(document.body, this.spinner);
    }
    this.renderer.setStyle(this.spinner, 'opacity', String(Math.min(progress / this.threshold, 1)));
  }

  private reset(): void {
    this.pulling = false;
    this.currentDelta = 0;
    if (this.spinner) {
      this.renderer.removeChild(document.body, this.spinner);
      this.spinner = null;
    }
  }
}
