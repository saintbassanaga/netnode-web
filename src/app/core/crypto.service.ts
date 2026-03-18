import { Injectable } from '@angular/core';

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
}

@Injectable({ providedIn: 'root' })
export class CryptoService {
  private static readonly KEY_PAIR_STORAGE_KEY = 'netnode_key_pair';

  async getOrCreateKeyPair(): Promise<KeyPair> {
    const stored = sessionStorage.getItem(CryptoService.KEY_PAIR_STORAGE_KEY);
    if (stored) {
      return this.importStoredKeyPair(JSON.parse(stored));
    }
    return this.generateAndStoreKeyPair();
  }

  private async generateAndStoreKeyPair(): Promise<KeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt'],
    );

    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
    const privateKeyB64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));

    // NOTE: In production (Tauri), store privateKeyB64 in plugin-stronghold or OS keychain.
    sessionStorage.setItem(
      CryptoService.KEY_PAIR_STORAGE_KEY,
      JSON.stringify({ publicKeyB64, privateKeyB64 }),
    );

    return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicKeyB64 };
  }

  private async importStoredKeyPair(stored: {
    publicKeyB64: string;
    privateKeyB64: string;
  }): Promise<KeyPair> {
    const spki = Uint8Array.from(atob(stored.publicKeyB64), (c) => c.charCodeAt(0));
    const pkcs8 = Uint8Array.from(atob(stored.privateKeyB64), (c) => c.charCodeAt(0));

    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
        'encrypt',
      ]),
      crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
        'decrypt',
      ]),
    ]);

    return { publicKey, privateKey, publicKeyB64: stored.publicKeyB64 };
  }

  async encryptMessage(
    plaintext: string,
    recipientPublicKeyB64: string,
  ): Promise<{ payload: string; encryptedKey: string }> {
    const spki = Uint8Array.from(atob(recipientPublicKeyB64), (c) => c.charCodeAt(0));
    const recipientKey = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );

    // Step 1 — ephemeral AES-256-GCM key
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
    ]);

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
    const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientKey, rawAesKey);
    const encryptedKey = btoa(String.fromCharCode(...new Uint8Array(wrappedKey)));

    return { payload, encryptedKey };
  }

  async decryptMessage(
    payload: string,
    encryptedKey: string,
    privateKey: CryptoKey,
  ): Promise<string> {
    // Step 1 — decrypt AES key with our private key
    const wrappedKeyBytes = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
    const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrappedKeyBytes);
    const aesKey = await crypto.subtle.importKey(
      'raw',
      rawAesKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    // Step 2 — split IV and ciphertext, then decrypt
    const payloadBytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const iv = payloadBytes.slice(0, 12);
    const ciphertext = payloadBytes.slice(12);
    const plainBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);

    return new TextDecoder().decode(plainBytes);
  }
}
