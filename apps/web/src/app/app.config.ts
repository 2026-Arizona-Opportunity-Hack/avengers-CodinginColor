import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling, withNavigationErrorHandler, withViewTransitions } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { provideEchartsCore } from 'ngx-echarts';
import { APP_ICONS } from './core/icons';
import { routes } from './app.routes';
import { Store } from './core/store';
import { demoWorkspaceMode } from './core/demo-workspace';

export async function initializeWorkspace(store: Store) {
  const demo = demoWorkspaceMode();
  store.enableDemo(demo === 'enter');
  if (demo === 'sign-in') store.signInDemo('m-ceo');
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' }), withViewTransitions({ skipInitialTransition: true }),
      withNavigationErrorHandler(event => { window.dispatchEvent(new CustomEvent('cic:module-error', { detail: event.error })); })),
    provideIcons(APP_ICONS),
    provideEchartsCore({ echarts: () => import('./core/echarts-setup').then((m) => m.default) }),
    // The public app always stays synthetic, even when live backend config is deployed.
    provideAppInitializer(() => initializeWorkspace(inject(Store))),
  ],
};
