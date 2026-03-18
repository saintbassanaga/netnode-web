import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
import { StompService } from './stomp.service';
import { PresenceService } from './presence.service';
import { CryptoService } from './crypto.service';
import { EncryptedMessage, KeyRegistration } from './netnode.types';

export interface DecryptedMessage {
  senderHostname: string;
  recipientHostname: string;
  plaintext: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class MessageService implements OnDestroy {
  private _messages$ = new Subject<DecryptedMessage>();
  readonly messages$ = this._messages$.asObservable();

  /** Set after initialize() — reactive signal so computed() dependants update automatically. */
  private _myPublicKeyB64 = signal<string | null>(null);
  readonly myPublicKeyB64 = this._myPublicKeyB64.asReadonly();

  private subscription?: Subscription;
  private privateKey?: CryptoKey;
  private initialized = false;

  constructor(
    private stomp: StompService,
    private presenceService: PresenceService,
    private cryptoService: CryptoService,
  ) {}

  /**
   * Mandatory startup sequence (called after STOMP OPEN):
   *   1. Presence subscriptions already live (PresenceService constructor)
   *   2. Subscribe to /user/queue/messages  ← Spring routes to us automatically
   *   3. Send keys.register                 ← server drains offline queue
   *   4. Send presence.request
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const keyPair = await this.cryptoService.getOrCreateKeyPair();
    this._myPublicKeyB64.set(keyPair.publicKeyB64);
    this.privateKey = keyPair.privateKey;

    // Spring resolves /user/queue/messages to the authenticated principal — no hostname needed.
    this.subscription = this.stomp
      .watch('/user/queue/messages')
      .pipe(map((f) => JSON.parse(f.body) as EncryptedMessage))
      .subscribe((msg) => this.decryptAndEmit(msg));

    this.stomp.publish({
      destination: '/app/keys.register',
      body: JSON.stringify({ publicKey: keyPair.publicKeyB64 } satisfies KeyRegistration),
    });

    this.stomp.publish({
      destination: '/app/presence.request',
      body: '',
    });
  }

  reset(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.initialized = false;
    this._myPublicKeyB64.set(null);
  }

  async sendMessage(recipientHostname: string, plaintext: string): Promise<void> {
    const peer = this.presenceService.getPeer(recipientHostname);
    if (!peer?.publicKey) {
      throw new Error(`Recipient "${recipientHostname}" has no public key registered yet`);
    }

    const { payload, encryptedKey } = await this.cryptoService.encryptMessage(
      plaintext,
      peer.publicKey,
    );

    this.stomp.publish({
      destination: '/app/message.send',
      body: JSON.stringify({
        senderHostname: '',
        recipientHostname,
        payload,
        encryptedKey,
        timestamp: new Date().toISOString(),
      } satisfies EncryptedMessage),
    });
  }

  private async decryptAndEmit(msg: EncryptedMessage): Promise<void> {
    if (!this.privateKey) return;
    try {
      const plaintext = await this.cryptoService.decryptMessage(
        msg.payload,
        msg.encryptedKey,
        this.privateKey,
      );
      this._messages$.next({
        senderHostname: msg.senderHostname,
        recipientHostname: msg.recipientHostname,
        plaintext,
        timestamp: msg.timestamp,
      });
    } catch (err) {
      console.error('[MessageService] decrypt failed from', msg.senderHostname, err);
    }
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
