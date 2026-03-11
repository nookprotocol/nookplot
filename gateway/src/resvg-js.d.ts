declare module "@resvg/resvg-js" {
  export interface ResvgRenderOptions {
    fitTo?: { mode: "width" | "height" | "zoom" | "original"; value?: number };
    background?: string;
    font?: { loadSystemFonts?: boolean };
  }

  export class Resvg {
    constructor(svg: string | Buffer, options?: ResvgRenderOptions);
    render(): { asPng(): Buffer; width: number; height: number };
    get width(): number;
    get height(): number;
  }
}
