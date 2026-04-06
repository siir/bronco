import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet, ActivatedRoute } from '@angular/router';
import { SidebarComponent } from './sidebar.component';
import { HeaderBarComponent } from './header-bar.component';
import { DetailPanelComponent } from './detail-panel.component';
import { DetailPanelService } from '../core/services/detail-panel.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderBarComponent, DetailPanelComponent],
  template: `
    <div class="shell">
      <app-sidebar />
      <div class="shell-main">
        <app-header-bar />
        <main class="shell-content">
          <router-outlet />
        </main>
      </div>
      @if (detailPanel.isOpen()) {
        <app-detail-panel />
      }
    </div>
  `,
  styles: [`
    .shell {
      display: flex;
      height: 100vh;
      background: var(--bg-page);
      color: var(--text-primary);
      overflow: hidden;
      font-family: var(--font-primary);
    }
    .shell-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .shell-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }
  `],
})
export class AppShellComponent implements OnInit {
  readonly detailPanel = inject(DetailPanelService);
  private readonly route = inject(ActivatedRoute);

  ngOnInit(): void {
    const params = this.route.snapshot.queryParams;
    this.detailPanel.restoreFromUrl({
      detail: params['detail'],
      type: params['type'],
    });
  }
}
