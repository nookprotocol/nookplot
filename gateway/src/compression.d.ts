declare module "compression" {
  import type { RequestHandler, Request, Response } from "express";

  interface CompressionOptions {
    filter?: (req: Request, res: Response) => boolean;
    level?: number;
    memLevel?: number;
    strategy?: number;
    threshold?: number | string;
    windowBits?: number;
    chunkSize?: number;
  }

  interface Compression {
    (options?: CompressionOptions): RequestHandler;
    filter: (req: Request, res: Response) => boolean;
  }

  const compression: Compression;
  export = compression;
}
