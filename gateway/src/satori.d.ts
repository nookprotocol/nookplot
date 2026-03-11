declare module "satori" {
  interface SatoriOptions {
    width: number;
    height: number;
    fonts: Array<{
      name: string;
      data: ArrayBuffer | Buffer;
      weight?: number;
      style?: "normal" | "italic";
    }>;
    embedFont?: boolean;
    debug?: boolean;
  }

  function satori(element: any, options: SatoriOptions): Promise<string>;
  export default satori;
}
