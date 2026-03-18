# NetNode — Angular Client Integration Guide

Everything you need to build the Angular + Tauri frontend against the NetNode backend.

---

## 1. Dependencies

```bash
npm install @stomp/rx-stomp rxjs
```

> No SockJS needed — the backend exposes a native WebSocket endpoint.

---

## 2. Types

Copy `netnode.types.ts` (project root) into your Angular project, e.g. `src/app/core/netnode.types.ts`.
All interfaces described in this guide come from that file.

---

## 3. Connection

### 3.1 Endpoint

```
ws://<host>:8080/ws        (dev)
ws://<host>:9090/ws        (prod / Docker)
```

### 3.2 Hostname resolution — how the server identifies you

The server identifies each peer by **hostname**. It tries three strategies in order:

| Priority | Source | What you need to do |
|----------|--------|---------------------|
| 1 | Reverse DNS on your IP | Nothing — automatic if your OS has a PTR record |
| 2 | HTTP header `X-Hostname` | Send this header on the WebSocket upgrade request |
| 3 | STOMP `login` header | Send your hostname in the CONNECT frame |

In a Tauri desktop app, reverse DNS will usually work on the LAN. As a safe fallback, **always send both** — the HTTP header and the STOMP login header.

### 3.3 RxStomp service setup

```typescript
// stomp.service.ts
import { Injectable } from '@angular/core';
import { RxStomp, RxStompConfig } from '@stomp/rx-stomp';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class StompService extends RxStomp {

  constructor() {
    super();
    const hostname = window.location.hostname; // or read from Tauri os-plugin

    const config: RxStompConfig = {
      brokerURL: environment.wsUrl,          // 'ws://192.168.1.x:8080/ws'
      connectHeaders: {
        login: hostname,                     // hostname fallback (priority 3)
        'heart-beat': '10000,10000',
      },
      webSocketFactory: () => {
        // Send X-Hostname header on the HTTP upgrade (priority 2)
        // Native browser WebSocket doesn't support custom headers,
        // but Tauri's HTTP client does — wire it here if using Tauri's websocket plugin.
        // For plain browser context this is a no-op; reverse DNS covers it.
        return new WebSocket(environment.wsUrl);
      },
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      reconnectDelay: 5000,
      debug: (msg) => environment.production ? undefined : console.debug('[STOMP]', msg),
    };

    this.configure(config);
    this.activate();
  }
}
```

> **Tauri note:** To send the `X-Hostname` header, use `@tauri-apps/plugin-websocket` instead of the browser WebSocket, which allows custom headers. Pass `{ headers: { 'X-Hostname': hostname } }` in the connect call.

---

## 4. Startup sequence (mandatory order)

```
1. STOMP CONNECTED received
       ↓
2. Subscribe to  /topic/presence                    ← broadcast peer list
3. Subscribe to  /user/{myHostname}/queue/messages  ← incoming messages
4. Subscribe to  /user/{myHostname}/queue/presence  ← on-demand presence reply
       ↓
5. SEND /app/keys.register  { publicKey: "..." }
       ← server drains your offline queue here and broadcasts updated presence
       ↓
6. SEND /app/presence.request  (no body)
       ← initial peer list arrives on /user/{myHostname}/queue/presence
```

**Why this order matters:**
- Steps 2–4 must come before step 5. The server drains your offline message queue the moment it receives `keys.register`. If you haven't subscribed to your queue yet, those messages are delivered to nobody and lost.
- Step 6 is optional if you are content to wait for the next `/topic/presence` broadcast.

---

## 5. Subscribing

```typescript
// presence.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { StompService } from './stomp.service';
import { PresenceAnnouncement, NodeInfo } from '../core/netnode.types';

@Injectable({ providedIn: 'root' })
export class PresenceService {
  private _peers$ = new BehaviorSubject<NodeInfo[]>([]);
  readonly peers$ = this._peers$.asObservable();

  constructor(private stomp: StompService) {
    // Broadcast updates
    this.stomp.watch('/topic/presence').pipe(
      map(frame => JSON.parse(frame.body) as PresenceAnnouncement)
    ).subscribe(ann => this._peers$.next(ann.nodes));

    // On-demand reply
    this.stomp.watch(`/user/${myHostname}/queue/presence`).pipe(
      map(frame => JSON.parse(frame.body) as PresenceAnnouncement)
    ).subscribe(ann => this._peers$.next(ann.nodes));
  }
}
```

---

## 6. Sending an encrypted message

The server is **zero-knowledge** — it never decrypts anything. You must encrypt before sending.

### 6.1 Encryption protocol

```
Recipient's publicKey  (Base64 DER, from PresenceAnnouncement.NodeInfo.publicKey)
       ↓
1. Generate ephemeral AES-256-GCM key  K  (32 bytes random)
2. Encrypt plaintext with K              → payload     (Base64)
3. Encrypt K with recipient RSA-OAEP     → encryptedKey (Base64)
4. Send EncryptedMessage with payload + encryptedKey
```

### 6.2 Key format

The server stores keys exactly as the client sends them in `KeyRegistration.publicKey`.
Use **SubjectPublicKeyInfo DER encoded, then Base64** (standard Web Crypto export format).

```typescript
// Generate your own key pair (run once, persist in secure storage)
const keyPair = await crypto.subtle.generateKey(
  { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]),
    hash: 'SHA-256' },
  true,
  ['encrypt', 'decrypt']
);

// Export public key → Base64 (this is what you register)
const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
```

### 6.3 Encrypting a message

```typescript
async function encryptMessage(
  plaintext: string,
  recipientPublicKeyB64: string
): Promise<{ payload: string; encryptedKey: string }> {

  // Decode recipient's public key
  const spki = Uint8Array.from(atob(recipientPublicKeyB64), c => c.charCodeAt(0));
  const recipientKey = await crypto.subtle.importKey(
    'spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']
  );

  // Step 1 — ephemeral AES-256-GCM key
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt']
  );

  // Step 2 — encrypt plaintext
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);

  // Combine IV + ciphertext
  const payloadBytes = new Uint8Array(iv.length + ciphertext.byteLength);
  payloadBytes.set(iv);
  payloadBytes.set(new Uint8Array(ciphertext), iv.length);
  const payload = btoa(String.fromCharCode(...payloadBytes));

  // Step 3 — encrypt AES key with recipient RSA-OAEP
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' }, recipientKey, rawAesKey
  );
  const encryptedKey = btoa(String.fromCharCode(...new Uint8Array(wrappedKey)));

  return { payload, encryptedKey };
}
```

### 6.4 Sending

```typescript
// message.service.ts
async sendMessage(recipientHostname: string, plaintext: string) {
  const peer = this.presenceService.getPeer(recipientHostname);
  if (!peer?.publicKey) throw new Error('Recipient public key not available');

  const { payload, encryptedKey } = await encryptMessage(plaintext, peer.publicKey);

  const msg: Partial<EncryptedMessage> = {
    senderHostname: '',        // server overwrites this — value ignored
    recipientHostname,
    payload,
    encryptedKey,
    timestamp: new Date().toISOString(),
  };

  this.stomp.publish({
    destination: '/app/message.send',
    body: JSON.stringify(msg),
  });
}
```

---

## 7. Receiving and decrypting

```typescript
// Subscribe in your message service
this.stomp.watch(`/user/${myHostname}/queue/messages`).pipe(
  map(frame => JSON.parse(frame.body) as EncryptedMessage)
).subscribe(msg => this.decryptAndEmit(msg));

async decryptAndEmit(msg: EncryptedMessage) {
  // Step 1 — decrypt AES key with your private key
  const wrappedKeyBytes = Uint8Array.from(atob(msg.encryptedKey), c => c.charCodeAt(0));
  const rawAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' }, myPrivateKey, wrappedKeyBytes
  );
  const aesKey = await crypto.subtle.importKey(
    'raw', rawAesKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );

  // Step 2 — split IV and ciphertext, decrypt
  const payloadBytes = Uint8Array.from(atob(msg.payload), c => c.charCodeAt(0));
  const iv = payloadBytes.slice(0, 12);
  const ciphertext = payloadBytes.slice(12);
  const plainBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);

  const plaintext = new TextDecoder().decode(plainBytes);
  // emit to your chat stream...
}
```

---

## 8. Registering your public key

Call this immediately after subscribing (step 5 of the startup sequence):

```typescript
this.stomp.publish({
  destination: '/app/keys.register',
  body: JSON.stringify({ publicKey: myPublicKeyB64 } satisfies KeyRegistration),
});
```

The server will:
1. Store your key and broadcast a `PresenceAnnouncement` to all peers with your new key.
2. Drain any messages that arrived while you were offline and push them to `/user/{hostname}/queue/messages`.

---

## 9. Requesting the peer list

```typescript
this.stomp.publish({
  destination: '/app/presence.request',
  body: '',
});
// Response arrives on /user/{myHostname}/queue/presence
```

---

## 10. Peer status

`NodeInfo.status` can be `'ONLINE'`, `'AWAY'`, or `'BUSY'`. The server sets `ONLINE` on connect. Status changes (AWAY / BUSY) are not yet driven server-side — you can send them as part of a future extension, or handle them locally in the UI.

---

## 11. Tauri-specific notes

| Topic | Detail |
|-------|--------|
| Hostname | Use `@tauri-apps/plugin-os` (`hostname()`) to read the real machine hostname instead of `window.location.hostname` |
| WebSocket header | Use `@tauri-apps/plugin-websocket` to send `X-Hostname` on the HTTP upgrade; pass it to `StompService.webSocketFactory` |
| Key storage | Store the private key in `@tauri-apps/plugin-stronghold` or the OS keychain via `@tauri-apps/plugin-keychain` — never in `localStorage` |
| Secure context | Tauri `tauri://localhost` is already a secure context; Web Crypto API works as-is |

---

## 12. Environment files

```typescript
// environment.ts (dev)
export const environment = {
  production: false,
  wsUrl: 'ws://localhost:8080/ws',
};

// environment.prod.ts
export const environment = {
  production: true,
  wsUrl: 'ws://192.168.1.x:9090/ws',   // replace with your server LAN IP
};
```

---

## 13. Error / edge cases

| Situation | What happens | What to do |
|-----------|-------------|------------|
| Recipient offline when you send | Server queues message in Redis (72h TTL) | Nothing — delivered automatically on their next `keys.register` |
| You reconnect after being offline | Offline messages delivered after your `keys.register` | Ensure subscription is active before publishing `keys.register` |
| Recipient has no public key yet | `NodeInfo.publicKey` is `null` | Disable send button until key is non-null |
| Ghost session purge (25s silence) | Server evicts session; next STOMP heartbeat will reconnect | RxStomp auto-reconnects; re-run startup sequence on reconnect |
| `senderHostname` from server | Always trust the received value, not what you sent | Read `msg.senderHostname` from the received frame for display |