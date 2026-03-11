declare module "cookie-parser" {
  import type { RequestHandler } from "express";

  function cookieParser(secret?: string | string[], options?: {
    decode?: (val: string) => string;
  }): RequestHandler;

  export = cookieParser;
}
