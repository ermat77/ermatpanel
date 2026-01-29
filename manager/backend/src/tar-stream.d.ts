declare module 'tar-stream' {
  import { Readable } from 'stream';

  export interface PackEntryHeader {
    name: string;
    size?: number;
    mode?: number;
    mtime?: Date;
    type?: string;
  }

  export interface Pack extends Readable {
    entry(header: PackEntryHeader, callback?: (err: Error | null) => void): NodeJS.WritableStream;
    entry(header: PackEntryHeader, buffer: Buffer | string, callback?: (err: Error | null) => void): NodeJS.WritableStream;
    finalize(): void;
  }

  export function pack(opts?: Record<string, unknown>): Pack;
  export function extract(opts?: Record<string, unknown>): NodeJS.WritableStream;
}
