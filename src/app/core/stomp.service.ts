import { Injectable } from '@angular/core';
import { RxStomp, RxStompConfig, RxStompState } from '@stomp/rx-stomp';
import { filter } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { CryptoService } from './crypto.service';
import { KeyRegistration, NodeIdentity } from './netnode.types';

@Injectable({ providedIn: 'root' })
export class StompService extends RxStomp {
  /** Hostname resolved by /api/me before each connection attempt. */
  private pendingHostname: string | null = null;

  constructor(private cryptoService: CryptoService) {
    super();
    const cfg: RxStompConfig = {
      brokerURL: environment.wsUrl,
      connectHeaders: {
        'heart-beat': '10000,10000',
      },
      webSocketFactory: () => new WebSocket(environment.wsUrl),
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      reconnectDelay: 5000,
      debug: (msg) => (environment.production ? undefined : console.debug('[STOMP]', msg)),

      // Fetch the server-stamped identity before each STOMP connect attempt.
      // /api/me uses the same resolution logic as HostnameHandshakeInterceptor
      // (reverse DNS → X-Hostname header → raw IP), so the hostname here will
      // always match what the server stores for this session.
      beforeConnect: async () => {
        try {
          const identity = (await fetch(`${environment.apiUrl}/api/me`).then((r) => r.json())) as NodeIdentity;
          this.pendingHostname = identity.hostname;
          console.debug('[StompService] resolved identity:', identity);
        } catch (err) {
          this.pendingHostname = null;
          console.error('[StompService] /api/me failed — key registration will be skipped:', err);
        }
      },
    };
    this.configure(cfg);
    this.activate();

    // After each STOMP CONNECTED: sign the pre-fetched hostname and register the key.
    // Fires on reconnect too, which re-establishes the server-side mapping after a drop.
    this.connectionState$
      .pipe(filter((s) => s === RxStompState.OPEN))
      .subscribe(async () => {
        const hostname = this.pendingHostname;
        if (!hostname) {
          console.error('[StompService] key registration aborted — hostname not resolved');
          return;
        }
        try {
          // Guard: ensure keys are ready even if APP_INITIALIZER races with STOMP connect.
          await this.cryptoService.init();
          console.debug('[StompService] registering key for hostname:', hostname);
          const publicKey = await this.cryptoService.getPublicKeyB64();
          const signature = await this.cryptoService.sign(hostname);
          this.publish({
            destination: '/app/keys.register',
            body: JSON.stringify({
              publicKey,
              keyAlgorithm: 'RSA',
              signature,
            } satisfies KeyRegistration),
          });
        } catch (err) {
          console.error('[StompService] key registration failed:', err);
        }
      });
  }
}
