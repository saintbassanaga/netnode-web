import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { StompService } from './stomp.service';
import { NodeInfo, PresenceAnnouncement } from './netnode.types';

@Injectable({ providedIn: 'root' })
export class PresenceService {
  private _peers$ = new BehaviorSubject<NodeInfo[]>([]);
  readonly peers$ = this._peers$.asObservable();

  constructor(private stomp: StompService) {
    // Broadcast: every peer join / leave / key registration
    this.stomp
      .watch('/topic/presence')
      .pipe(map((f) => JSON.parse(f.body) as PresenceAnnouncement))
      .subscribe((ann) => this._peers$.next(ann.nodes));

    // On-demand reply: Spring routes /user/queue/… to the authenticated principal
    // automatically — no need to embed our hostname in the path.
    this.stomp
      .watch('/user/queue/presence')
      .pipe(map((f) => JSON.parse(f.body) as PresenceAnnouncement))
      .subscribe((ann) => this._peers$.next(ann.nodes));
  }

  getPeer(hostname: string): NodeInfo | undefined {
    return this._peers$.getValue().find((p) => p.hostname === hostname);
  }

  get peers(): NodeInfo[] {
    return this._peers$.getValue();
  }

  reset(): void {
    this._peers$.next([]);
  }
}
