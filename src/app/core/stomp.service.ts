import { Injectable } from '@angular/core';
import { RxStomp, RxStompConfig } from '@stomp/rx-stomp';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class StompService extends RxStomp {
  constructor() {
    super();
    const cfg: RxStompConfig = {
      brokerURL: environment.wsUrl,
      connectHeaders: {
        // Server resolves the real hostname via reverse DNS (priority 1).
        // This login header is only a fallback hint (priority 3) — sending
        // window.location.hostname is fine; the server will override it with
        // the PTR-record result when available.
        login: window.location.hostname,
        'heart-beat': '10000,10000',
      },
      webSocketFactory: () => new WebSocket(environment.wsUrl),
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      reconnectDelay: 5000,
      debug: (msg) => (environment.production ? undefined : console.debug('[STOMP]', msg)),
    };
    this.configure(cfg);
    this.activate();
  }
}
