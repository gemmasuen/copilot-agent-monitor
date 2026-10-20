import * as fs from "fs";
import { RawEvent, isRelevantType, parseEventLine, peekEventType } from "../model/events";

export interface TailOptions {
  /** Return false to skip a line without decoding/parsing it. Defaults to the relevant event types. */
  filter?: (type: string | undefined) => boolean;
  chunkSize?: number;
  /** Lines larger than this are dropped (e.g. embedded binary assets). */
  maxLineBytes?: number;
}

export interface TailResult {
  events: RawEvent[];
  /** The file shrank or was replaced; callers should rebuild state from scratch. */
  reset: boolean;
  bytesRead: number;
}

const PEEK_BYTES = 96;
const NEWLINE = 0x0a;

type LineState = "unknown" | "keep" | "skip";

/**
 * Incrementally reads appended JSONL lines from a file that is being written to.
 * Irrelevant lines are skipped by peeking at their first bytes, so very large
 * logs (GBs) can be scanned without decoding every line.
 */
export class JsonlTailer {
  private offset = 0;
  private parts: Buffer[] = [];
  private partLen = 0;
  private state: LineState = "unknown";
  private reading = false;
  private readonly filter: (type: string | undefined) => boolean;
  private readonly chunkSize: number;
  private readonly maxLineBytes: number;

  constructor(
    readonly file: string,
    options: TailOptions = {},
  ) {
    this.filter = options.filter ?? isRelevantType;
    this.chunkSize = options.chunkSize ?? 1024 * 1024;
    this.maxLineBytes = options.maxLineBytes ?? 64 * 1024 * 1024;
  }

  get position(): number {
    return this.offset;
  }

  /**
   * Reads everything appended since the last call.
   * `onChunk` is invoked as events become available so large initial loads can report progress.
   */
  async readNew(
    onChunk?: (events: RawEvent[], position: number, size: number) => void,
    shouldStop?: () => boolean,
  ): Promise<TailResult> {
    if (this.reading) {
      return { events: [], reset: false, bytesRead: 0 };
    }
    this.reading = true;
    const events: RawEvent[] = [];
    let reset = false;
    let bytesRead = 0;
    let handle: fs.promises.FileHandle | undefined;
    try {
      let size: number;
      try {
        size = (await fs.promises.stat(this.file)).size;
      } catch {
        return { events, reset, bytesRead };
      }
      if (size < this.offset) {
        this.resetState();
        reset = true;
      }
      if (size === this.offset) {
        return { events, reset, bytesRead };
      }
      handle = await fs.promises.open(this.file, "r");
      while (this.offset < size) {
        if (shouldStop?.()) {
          break;
        }
        const length = Math.min(this.chunkSize, size - this.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead: n } = await handle.read(buffer, 0, length, this.offset);
        if (n <= 0) {
          break;
        }
        this.offset += n;
        bytesRead += n;
        const chunkEvents: RawEvent[] = [];
        this.consume(buffer.subarray(0, n), chunkEvents);
        if (chunkEvents.length > 0) {
          events.push(...chunkEvents);
        }
        onChunk?.(chunkEvents, this.offset, size);
      }
      this.flushCompletePartial(events);
      return { events, reset, bytesRead };
    } finally {
      await handle?.close();
      this.reading = false;
    }
  }

  private consume(chunk: Buffer, out: RawEvent[]): void {
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, pos);
      const end = nl === -1 ? chunk.length : nl;
      if (this.state !== "skip" && end > pos) {
        this.parts.push(chunk.subarray(pos, end));
        this.partLen += end - pos;
        if (this.state === "unknown" && (this.partLen >= PEEK_BYTES || nl !== -1)) {
          this.decide();
        }
        if (this.state === "keep" && this.partLen > this.maxLineBytes) {
          this.dropParts("skip");
        }
      }
      if (nl === -1) {
        return;
      }
      if (this.state !== "skip" && this.partLen > 0) {
        if (this.state === "unknown") {
          this.decide();
        }
        if (this.state === "keep") {
          const event = parseEventLine(Buffer.concat(this.parts, this.partLen).toString("utf8"));
          if (event) {
            out.push(event);
          }
        }
      }
      this.dropParts("unknown");
      pos = nl + 1;
    }
  }

  private decide(): void {
    const head = Buffer.concat(this.parts, this.partLen).subarray(0, PEEK_BYTES).toString("utf8");
    if (this.filter(peekEventType(head))) {
      this.state = "keep";
    } else {
      this.dropParts("skip");
    }
  }

  /**
   * Writers normally terminate every line with "\n". If the file currently ends
   * with a complete JSON object, emit it now and ignore the rest of that line.
   */
  private flushCompletePartial(out: RawEvent[]): void {
    if (this.state === "skip" || this.partLen === 0) {
      return;
    }
    const text = Buffer.concat(this.parts, this.partLen).toString("utf8");
    const event = parseEventLine(text);
    if (!event) {
      return;
    }
    if (this.state === "keep" || this.filter(event.type)) {
      out.push(event);
    }
    this.dropParts("skip");
  }

  private dropParts(next: LineState): void {
    this.parts = [];
    this.partLen = 0;
    this.state = next;
  }

  private resetState(): void {
    this.offset = 0;
    this.dropParts("unknown");
  }
}
