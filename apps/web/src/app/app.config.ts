import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { loadLiveConfig } from './core/api';
import { Store } from './core/store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    // A deployed config.json switches the app to the live API; without one it runs on demo data.
    provideAppInitializer(() => {
      const store = inject(Store);
      return loadLiveConfig().then((config) => { if (config) store.connect(config); });
    }),
  ],
};
