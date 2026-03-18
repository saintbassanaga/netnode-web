/**
 * NetNode — TypeScript contract types
 *
 * Mirror of the Java records in tech.bytesmind.netnode.
 * Keep in sync whenever server-side DTOs change.
 *
 * STOMP destinations quick reference
 * ────────────────────────────────────────────────────────────────────────
 *  Connect endpoint  ws://<host>/ws
 *
 *  Client → Server  (SEND to /app/…)
 *    /app/message.send          EncryptedMessage      send encrypted P2P message
 *    /app/keys.register         KeyRegistration       publish your public key
 *    /app/presence.request      (no body)             request current peer list
 *
 *  Server → Client  (SUBSCRIBE to …)
 *    /topic/presence                                  PresenceAnnouncement broadcasts
 *    /user/{hostname}/queue/messages                  incoming EncryptedMessage frames
 *    /user/{hostname}/queue/presence                  PresenceAnnouncement (on-demand)
 * ────────────────────────────────────────────────────────────────────────
 */

// ── Enums ─────────────────────────────────────────────────────────────────────

export type NodeStatus = 'ONLINE' | 'AWAY' | 'BUSY';

// ── DTOs (wire format) ────────────────────────────────────────────────────────

/**
 * Zero-Knowledge P2P message.
 *
 * Client-side encryption protocol:
 *   1. Generate ephemeral AES-256-GCM key K.
 *   2. Encrypt plaintext with K  → payload     (Base64)
 *   3. Encrypt K with recipient's RSA-OAEP public key → encryptedKey (Base64)
 *
 * NOTE: senderHostname is OVERWRITTEN server-side from the verified session.
 *       Never trust the inbound value — always read it from the received frame.
 */
export interface EncryptedMessage {
  /** Server-authoritative — ignored on send, verified on receive. */
  senderHostname: string;
  /** Routing target hostname. */
  recipientHostname: string;
  /** Base64(AES-256-GCM(plaintext)) */
  payload: string;
  /** Base64(RSA-OAEP(AES-key, recipientPublicKey)) */
  encryptedKey: string;
  /** ISO-8601 timestamp stamped by the server on relay. */
  timestamp: string; // Instant serialises as ISO-8601 string in JSON
}

/**
 * Published to /topic/presence on every peer join / leave / key registration.
 * Also returned to /user/{hostname}/queue/presence on an explicit request.
 */
export interface PresenceAnnouncement {
  nodes: NodeInfo[];
  /** ISO-8601 timestamp of the last change. */
  updatedAt: string;
}

/** Minimal public view of a connected peer. */
export interface NodeInfo {
  hostname: string;
  ip: string;
  /** Base64-encoded RSA/ECC SubjectPublicKeyInfo (DER). Null until key is registered. */
  publicKey: string | null;
  status: NodeStatus;
}

/**
 * Sent to /app/keys.register immediately after subscribing to your queue.
 * Triggers the server to drain any offline messages queued for this hostname.
 */
export interface KeyRegistration {
  /** Base64-encoded SubjectPublicKeyInfo (DER) of your RSA/ECC public key. */
  publicKey: string;
}

// ── STOMP helper types ────────────────────────────────────────────────────────

/** STOMP CONNECT headers — hostname fallback when reverse DNS is unavailable. */
export interface StompConnectHeaders {
  /** Your machine hostname. Used if the server's reverse DNS lookup fails. */
  login: string;
  /** Must match the server's heartbeat config (default 10000). */
  'heart-beat'?: string;
}