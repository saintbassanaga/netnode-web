import { Injectable } from '@angular/core';

// ── IndexedDB constants (browser path) ────────────────────────────────────────
const DB_NAME = 'netnode';
const DB_VERSION = 1;
const DB_STORE = 'keys';
const DB_KEY_ID = 'rsa-identity';

// ── Stronghold constants (Tauri path) ─────────────────────────────────────────
const SH_CLIENT = 'netnode-crypto';
const SH_KEY_SPKI = 'spki';
const SH_KEY_PKCS8 = 'pkcs8';

interface StoredKeys {
  publicKeySpki: ArrayBuffer;
  privateKeyPkcs8: ArrayBuffer;
}

@Injectable({ providedIn: 'root' })
export class CryptoService {
  private publicKeySpki: ArrayBuffer | null = null;
  private privateKeyPkcs8: ArrayBuffer | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Loads or generates the RSA identity key pair.
   * - Tauri: persisted in plugin-stronghold (OS-backed encrypted vault).
   * - Browser: persisted in IndexedDB.
   * Idempotent — safe to call multiple times; only runs once.
   * Wire to APP_INITIALIZER in app.config.ts.
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const stored = this.isTauri()
      ? await this.loadFromStronghold()
      : await this.loadFromIndexedDB();

    if (stored) {
      this.publicKeySpki = stored.publicKeySpki;
      this.privateKeyPkcs8 = stored.privateKeyPkcs8;
      return;
    }

    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    this.publicKeySpki = await crypto.subtle.exportKey('spki', pair.publicKey);
    this.privateKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);

    if (this.isTauri()) {
      await this.saveToStronghold({ publicKeySpki: this.publicKeySpki, privateKeyPkcs8: this.privateKeyPkcs8 });
    } else {
      await this.saveToIndexedDB({ publicKeySpki: this.publicKeySpki, privateKeyPkcs8: this.privateKeyPkcs8 });
    }
  }

  /** Base64-encoded SPKI public key — send this in KeyRegistration. */
  async getPublicKeyB64(): Promise<string> {
    return btoa(String.fromCharCode(...new Uint8Array(this.publicKeySpki!)));
  }

  /**
   * Signs the server-stamped hostname to prove private-key ownership.
   * Used once per STOMP session during key registration.
   */
  async sign(data: string): Promise<string> {
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      this.privateKeyPkcs8!,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const bytes = new TextEncoder().encode(data);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, bytes);
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  /**
   * Hybrid encrypt: AES-256-GCM payload wrapped with recipient's RSA-OAEP public key.
   * The recipient SPKI bytes are re-imported under RSA-OAEP — same RSA key material,
   * different algorithm label.
   */
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

    // Ephemeral AES-256-GCM session key
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(plaintext),
    );

    const payloadBytes = new Uint8Array(iv.length + ciphertext.byteLength);
    payloadBytes.set(iv);
    payloadBytes.set(new Uint8Array(ciphertext), iv.length);
    const payload = btoa(String.fromCharCode(...payloadBytes));

    const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
    const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientKey, rawAesKey);
    const encryptedKey = btoa(String.fromCharCode(...new Uint8Array(wrappedKey)));

    return { payload, encryptedKey };
  }

  /**
   * Hybrid decrypt: unwraps the AES key with our RSA private key, then decrypts payload.
   * Re-imports the identity private key under RSA-OAEP for unwrapping.
   */
  async decryptMessage(payload: string, encryptedKey: string): Promise<string> {
    const decryptionKey = await crypto.subtle.importKey(
      'pkcs8',
      this.privateKeyPkcs8!,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt'],
    );

    const wrappedKeyBytes = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
    const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, decryptionKey, wrappedKeyBytes);
    const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM', length: 256 }, false, [
      'decrypt',
    ]);

    const payloadBytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const iv = payloadBytes.slice(0, 12);
    const ciphertext = payloadBytes.slice(12);
    const plainBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);

    return new TextDecoder().decode(plainBytes);
  }

  // ── Tauri detection ──────────────────────────────────────────────────────────

  private isTauri(): boolean {
    return '__TAURI_INTERNALS__' in window;
  }

  // ── Stronghold helpers (Tauri) ───────────────────────────────────────────────

  /**
   * Opens the stronghold vault using the OS hostname as the vault password seed.
   * The Rust side runs Argon2id over this value before deriving the vault key,
   * so the raw hostname never touches the encrypted store.
   */
  private async openStronghold() {
    const { Stronghold } = await import('@tauri-apps/plugin-stronghold');
    const { appDataDir } = await import('@tauri-apps/api/path');
    const { hostname } = await import('@tauri-apps/plugin-os');

    const vaultPath = `${await appDataDir()}/netnode.hold`;
    const vaultPassword = (await hostname()) ?? window.location.hostname;
    return Stronghold.load(vaultPath, vaultPassword);
  }

  private async loadFromStronghold(): Promise<StoredKeys | null> {
    try {
      const stronghold = await this.openStronghold();
      const client = await stronghold.loadClient(SH_CLIENT);
      const store = client.getStore();

      const spkiArr = await store.get(SH_KEY_SPKI);
      const pkcs8Arr = await store.get(SH_KEY_PKCS8);

      if (!spkiArr || !pkcs8Arr) return null;

      return {
        publicKeySpki: spkiArr.buffer as ArrayBuffer,
        privateKeyPkcs8: pkcs8Arr.buffer as ArrayBuffer,
      };
    } catch {
      // Client doesn't exist yet — first launch
      return null;
    }
  }

  private async saveToStronghold(keys: StoredKeys): Promise<void> {
    const stronghold = await this.openStronghold();
    const client = await stronghold.createClient(SH_CLIENT);
    const store = client.getStore();

    await store.insert(SH_KEY_SPKI, Array.from(new Uint8Array(keys.publicKeySpki)));
    await store.insert(SH_KEY_PKCS8, Array.from(new Uint8Array(keys.privateKeyPkcs8)));
    await stronghold.save();
  }

  // ── IndexedDB helpers (browser) ──────────────────────────────────────────────

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async loadFromIndexedDB(): Promise<StoredKeys | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(DB_KEY_ID);
      req.onsuccess = () => resolve((req.result as StoredKeys) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  private async saveToIndexedDB(keys: StoredKeys): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const req = tx.objectStore(DB_STORE).put(keys, DB_KEY_ID);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
