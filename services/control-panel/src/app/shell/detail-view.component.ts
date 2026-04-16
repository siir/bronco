import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DetailPanelComponent } from './detail-panel.component.js';
import { DetailPanelService } from '../core/services/detail-panel.service.js';

/**
 * Mobile-only routed wrapper for the detail panel.
 *
 * Reads `:type` and `:id` from the route, hydrates `DetailPanelService` state,
 * then renders the same `DetailPanelComponent` used in desktop's side pane.
 * The panel's full-screen styling on this route is applied via a global CSS
 * selector (`.detail-route-page app-detail-panel`) in styles.scss so the
 * DetailPanelComponent itself remains unchanged.
 */
@Component({
  selector: 'app-detail-view',
  standalone: true,
  imports: [DetailPanelComponent],
  template: `
    <div class="detail-route-page">
      <app-detail-panel />
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .detail-route-page {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
  `],
})
export class DetailViewComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly detailPanel = inject(DetailPanelService);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    // Hydrate on every param change (e.g. if user swaps entity via deep link).
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(pm => {
        this.detailPanel.hydrateFromParams({
          type: pm.get('type'),
          id: pm.get('id'),
          mode: this.route.snapshot.queryParamMap.get('mode'),
        });
      });

    // Leaving the route clears state so the inline pane doesn't re-appear on
    // a subsequent desktop resize with stale signals.
    this.destroyRef.onDestroy(() => this.detailPanel.dismiss());
  }
}
