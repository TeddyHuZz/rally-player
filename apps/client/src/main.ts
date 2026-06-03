import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { ApplicationRef, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

bootstrapApplication(App, appConfig)
  .then((appRef) => {
    const platformId = appRef.injector.get(PLATFORM_ID);
    
    if (isPlatformBrowser(platformId)) {
      // Cache the original fetch to prevent nested wrappers on hot reloads
      const originalFetch = (window as any).__originalFetch || window.fetch;
      (window as any).__originalFetch = originalFetch;
      
      const applicationRef = appRef.injector.get(ApplicationRef);
      
      window.fetch = function (...args) {
        return originalFetch.apply(this, args).finally(() => {
          // Defer execution to the next event loop tick to prevent ExpressionChangedAfterItHasBeenCheckedError
          setTimeout(() => {
            if (!applicationRef.destroyed) {
              applicationRef.tick();
            }
          }, 0);
        });
      };
    }
  })
  .catch((err) => console.error(err));
