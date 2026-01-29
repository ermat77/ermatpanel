declare module 'archiver' {
  import { Writable } from 'stream';

  interface ArchiverOptions {
    zlib?: { level?: number };
  }

  interface Archiver {
    pipe(dest: Writable): Archiver;
    file(path: string, data: { name: string }): void;
    directory(src: string, dest: string): void;
    finalize(): void;
    on(event: string, cb: (err?: Error) => void): Archiver;
  }

  function archiver(format: 'zip', options?: ArchiverOptions): Archiver;
  export = archiver;
}
