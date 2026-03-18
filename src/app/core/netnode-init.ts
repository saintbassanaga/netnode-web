import { inject } from '@angular/core';
import { RxStompState } from '@stomp/rx-stomp';
import { filter, take } from 'rxjs/operators';
import { StompService } from './stomp.service';
import { MessageService } from './message.service';

/**
 * APP_INITIALIZER factory.
 * Waits for STOMP to reach OPEN, then runs the mandatory startup sequence.
 */
export function provideNetnodeInit() {
  return () => {
    const stomp = inject(StompService);
    const messages = inject(MessageService);

    return new Promise<void>((resolve) => {
      stomp.connectionState$
        .pipe(
          filter((s) => s === RxStompState.OPEN),
          take(1),
        )
        .subscribe(async () => {
          await messages.initialize();
          resolve();
        });
    });
  };
}
