export interface SseEvent { event: string; data: string; id?: string }

/** Incremental Server-Sent Events parser. Feed decoded text chunks; events are emitted as they complete. */
export class SseParser {
  private buf = ''; private event = ''; private id: string | undefined; private data: string[] = [];
  constructor(private onEvent: (e: SseEvent) => boolean | void) {}
  /** Returns false when the consumer asked to stop. */
  push(chunk: string): boolean {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.search(/\r\n|\n|\r/)) >= 0) {
      const nl = this.buf.slice(i).startsWith('\r\n') ? 2 : 1;
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + nl);
      if (line === '') { if (!this.flush()) return false; continue; }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':'); const field = c < 0 ? line : line.slice(0, c); let value = c < 0 ? '' : line.slice(c + 1); if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') this.id = value; else if (field === 'event') this.event = value; else if (field === 'data') this.data.push(value);
    }
    return true;
  }
  private flush(): boolean {
    if (!this.data.length && !this.event) return true;
    const e: SseEvent = { event: this.event || 'message', data: this.data.join('\n'), ...(this.id ? { id: this.id } : {}) }; this.event = ''; this.data = []; this.id = undefined;
    return this.onEvent(e) !== false;
  }
  end() { this.flush(); }
}
