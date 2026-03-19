import { APP_INITIALIZER, ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { CryptoService } from './core/crypto.service';
import { provideNetnodeInit } from './core/netnode-init';
import { UpdateService } from './core/update.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    {
      // Loads (or generates) the RSA identity key pair before anything renders.
      provide: APP_INITIALIZER,
      useFactory: (crypto: CryptoService) => () => crypto.init(),
      deps: [CryptoService],
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: provideNetnodeInit,
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: (update: UpdateService) => () => {
        update.checkAndInstall().catch((err) =>
          console.warn('[UpdateService] update check failed', err),
        );
      },
      deps: [UpdateService],
      multi: true,
    },
  ],
};
