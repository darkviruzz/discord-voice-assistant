import { EventEmitter } from 'events';

export const State = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING:   'CONNECTING',
  REGISTERING:  'REGISTERING',
  READY:        'READY',
  BACKOFF:      'BACKOFF',
});

export class TransportState extends EventEmitter {
  constructor() {
    super();
    this.value = State.DISCONNECTED;
  }
  set(next) {
    if (next === this.value) return;
    const prev = this.value;
    this.value = next;
    this.emit('change', next, prev);
  }
  is(s) { return this.value === s; }
}
