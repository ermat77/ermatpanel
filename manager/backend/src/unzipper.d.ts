declare module 'unzipper' {
  import { Readable } from 'stream';

  export interface ZipEntry {
    path: string;
    type: 'File' | 'Directory';
    stream(password?: string): Readable;
  }

  export interface CentralDirectory {
    files: ZipEntry[];
    extract(options: { path: string; concurrency?: number }): Promise<void>;
  }

  export const Open: {
    file(path: string, options?: Record<string, unknown>): Promise<CentralDirectory>;
  };
}
