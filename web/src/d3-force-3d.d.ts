declare module "d3-force-3d" {
  interface ForceCollide {
    (alpha: number): void;
    radius(r: number | ((node: unknown) => number)): ForceCollide;
    strength(s: number): ForceCollide;
    iterations(i: number): ForceCollide;
  }
  export function forceCollide(radius?: number): ForceCollide;
}
