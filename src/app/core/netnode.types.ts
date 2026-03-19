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
 *    /app/history.request       (no body)             request last 100 messages (oldest first)
 *
 *  Server → Client  (SUBSCRIBE to …)
 *    /topic/presence                                  PresenceAnnouncement broadcasts
 *    /user/{hostname}/queue/messages                  incoming EncryptedMessage frames
 *    /user/{hostname}/queue/presence                  PresenceAnnouncement (on-demand)
 *    /user/{hostname}/queue/history                   HistoryResponse (on-demand)
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
 *
 * The server verifies the signature before storing the key:
 *   signature = Base64(Sign(privateKey, TextEncoder().encode(serverHostname)))
 */
export interface KeyRegistration {
  /** Base64-encoded SubjectPublicKeyInfo (DER) of your RSA/ECC public key. */
  publicKey: string;
  /** Algorithm family used to reconstruct the key server-side ("RSA" or "EC"). */
  keyAlgorithm: 'RSA' | 'EC';
  /** Base64(RSASSA-PKCS1-v1_5 or ECDSA signature of the server-stamped hostname bytes). */
  signature: string;
}

/**
 * Response from /app/history.request
 * Delivered to /user/{hostname}/queue/history
 * Contains the last 100 messages addressed to you, oldest first.
 */
export interface HistoryResponse {
  messages: EncryptedMessage[];
  retrievedAt: string;
}

// ── REST types ────────────────────────────────────────────────────────────────

/**
 * Response from GET /api/me
 * Returns the server-stamped identity for the calling machine.
 * Fetch this before opening the WebSocket so the client knows exactly
 * what hostname to sign for KeyRegistration.
 */
export interface NodeIdentity {
  hostname: string;
  ip: string;
}

// ── STOMP helper types ────────────────────────────────────────────────────────

/** STOMP CONNECT headers — hostname fallback when reverse DNS is unavailable. */
export interface StompConnectHeaders {
  /** Your machine hostname. Used if the server's reverse DNS lookup fails. */
  login: string;
  /** Must match the server's heartbeat config (default 10000). */
  'heart-beat'?: string;
}

/**
 * Headers present in the STOMP CONNECTED frame sent by the server.
 *
 * The server resolves the authoritative hostname (reverse DNS → X-Hostname header → raw IP)
 * and echoes it back here via StompOutboundInterceptor. Read this value, sign it, then
 * send /app/keys.register — this guarantees the client signs exactly what the server stored.
 *
 * @example
 * // in StompService, after connectionState$ emits OPEN:
 * const hostname = (serverHeaders as StompConnectedHeaders).hostname;
 * const signature = await cryptoService.sign(hostname);
 */
export interface StompConnectedHeaders {
  /** Server-stamped hostname for this connection (reverse DNS → X-Hostname → raw IP). */
  hostname: string;
  'heart-beat': string;
  version: string;
}