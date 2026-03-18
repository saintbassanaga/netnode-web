import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { RxStompState } from '@stomp/rx-stomp';

import { StompService } from '../core/stomp.service';
import { PresenceService } from '../core/presence.service';
import { MessageService, DecryptedMessage } from '../core/message.service';
import { NodeInfo, NodeStatus } from '../core/netnode.types';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent {
  private stomp = inject(StompService);
  protected presence = inject(PresenceService);
  private messages = inject(MessageService);

  // ── Connection state ──────────────────────────────────────────────────────
  protected connectionState = toSignal(this.stomp.connectionState$, {
    initialValue: RxStompState.CLOSED,
  });
  protected isConnected = computed(() => this.connectionState() === RxStompState.OPEN);
  protected connectionLabel = computed(() => {
    switch (this.connectionState()) {
      case RxStompState.OPEN:      return 'Connected';
      case RxStompState.CONNECTING: return 'Connecting…';
      case RxStompState.CLOSING:   return 'Closing…';
      default:                      return 'Disconnected';
    }
  });

  // ── Peers ─────────────────────────────────────────────────────────────────
  protected peers = toSignal(this.presence.peers$, { initialValue: [] as NodeInfo[] });

  /**
   * Identify our own node by matching the public key we registered.
   * The server is the authoritative source of our hostname — we learn it
   * from the PresenceAnnouncement that arrives after keys.register.
   */
  /**
   * Identify our own node by matching the public key we registered.
   * myPublicKeyB64 is a signal — this computed re-runs reactively when the
   * key is set (after initialize()) and when the peer list updates.
   */
  protected myNode = computed(() => {
    const myKey = this.messages.myPublicKeyB64();
    if (!myKey) return null;
    return this.peers().find((p) => p.publicKey === myKey) ?? null;
  });

  protected myHostname = computed(() => this.myNode()?.hostname ?? '');

  protected otherPeers = computed(() => {
    const myKey = this.messages.myPublicKeyB64();
    const myHost = this.myHostname();
    return this.peers().filter((p) => {
      if (myHost && p.hostname === myHost) return false;
      if (myKey && p.publicKey === myKey) return false;
      return true;
    });
  });

  protected onlineCount = computed(
    () => this.otherPeers().filter((p) => p.status === 'ONLINE').length,
  );

  // ── Chat state ────────────────────────────────────────────────────────────
  protected selectedPeer = signal<string | null>(null);
  protected conversations = signal<Map<string, DecryptedMessage[]>>(new Map());
  protected inputText = signal('');
  protected sendError = signal<string | null>(null);
  protected isSending = signal(false);

  protected activePeer = computed(() => {
    const h = this.selectedPeer();
    return h ? (this.peers().find((p) => p.hostname === h) ?? null) : null;
  });

  protected activeMessages = computed(() => {
    const h = this.selectedPeer();
    return h ? (this.conversations().get(h) ?? []) : [];
  });

  private msgContainer = viewChild<ElementRef<HTMLElement>>('msgContainer');

  constructor() {
    this.messages.messages$.pipe(takeUntilDestroyed()).subscribe((msg) => {
      const key =
        msg.senderHostname === this.myHostname() ? msg.recipientHostname : msg.senderHostname;
      this.conversations.update((m) => {
        const next = new Map(m);
        next.set(key, [...(next.get(key) ?? []), msg]);
        return next;
      });
    });

    effect(() => {
      this.activeMessages();
      setTimeout(() => {
        const el = this.msgContainer()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      }, 0);
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  protected selectPeer(hostname: string): void {
    this.selectedPeer.set(hostname);
    this.sendError.set(null);
  }

  protected async send(): Promise<void> {
    const text = this.inputText().trim();
    const peer = this.selectedPeer();
    if (!text || !peer || this.isSending()) return;

    this.isSending.set(true);
    this.sendError.set(null);
    try {
      await this.messages.sendMessage(peer, text);
      const sent: DecryptedMessage = {
        senderHostname: this.myHostname(),
        recipientHostname: peer,
        plaintext: text,
        timestamp: new Date().toISOString(),
      };
      this.conversations.update((m) => {
        const next = new Map(m);
        next.set(peer, [...(next.get(peer) ?? []), sent]);
        return next;
      });
      this.inputText.set('');
    } catch (err) {
      this.sendError.set(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      this.isSending.set(false);
    }
  }

  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  protected initials(hostname: string): string {
    return hostname.slice(0, 2).toUpperCase();
  }

  protected statusClass(status: NodeStatus): string {
    return status.toLowerCase();
  }

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  protected formatDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  protected canSend = computed(
    () => this.isConnected() && !!this.activePeer()?.publicKey && !!this.inputText().trim(),
  );

  protected hasNoKey = computed(() => {
    const p = this.activePeer();
    return p !== null && !p.publicKey;
  });

  protected trackByHostname(_: number, peer: NodeInfo): string {
    return peer.hostname;
  }

  protected trackByMsg(_: number, msg: DecryptedMessage): string {
    return `${msg.senderHostname}-${msg.timestamp}`;
  }
}
