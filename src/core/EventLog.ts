/**
 * In-memory scientific log. Readout only. No disk. No world writes.
 *
 * Cap 8. Oldest drops. Sequence + T+seconds from boot.
 * Kinds: ASM success, REJ reject, CPL cascade emission.
 */

export type LogKind = "ASM" | "REJ" | "CPL";

export interface LogEntry {
  seq: number;
  t: number;
  kind: LogKind;
  text: string;
}

const CAP = 8;
const TEXT_MAX = 40;

export class EventLog {
  private seq = 0;
  private readonly t0 = performance.now();
  private readonly buf: LogEntry[] = [];

  push(kind: LogKind, text: string): void {
    this.seq += 1;
    this.buf.push({
      seq: this.seq,
      t: (performance.now() - this.t0) / 1000,
      kind,
      text: text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX),
    });
    if (this.buf.length > CAP) this.buf.shift();
  }

  entries(): readonly LogEntry[] {
    return this.buf;
  }
}
