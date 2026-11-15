import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling, withViewTransitions } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { provideEchartsCore } from 'ngx-echarts';
import { APP_ICONS } from './core/icons';
import { routes } from './app.routes';
import { loadLiveConfig } from './core/api';
import { Store } from './core/store';
import { demoWorkspaceMode } from './core/demo-workspace';

export async function initializeWorkspace(store: Store) {
  const demo = demoWorkspaceMode();
  if (demo) { store.enableDemo(demo === 'enter'); return; }
  const config = await loadLiveConfig();
  if (config) store.connect(config);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' }), withViewTransitions({ skipInitialTransition: true })),
    provideIcons(APP_ICONS),
    provideEchartsCore({ echarts: () => import('./core/echarts-setup').then((m) => m.default) }),
    // A deployed config.json switches the app to the live API; without one it runs on demo data.
    provideAppInitializer(() => initializeWorkspace(inject(Store))),
  ],
};
