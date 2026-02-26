/**
 * Shared avatar generation logic.
 * Used by both ProceduralAvatar (React SVG) and AvatarCanvasCache (bitmap).
 */

export interface AvatarTraits {
  palette?: string;
  shape?: string;
  complexity?: number;
  customColors?: string[];
}

// Default palettes keyed by name
export const PALETTES: Record<string, string[]> = {
  ocean: ["#0077B6", "#00B4D8", "#90E0EF", "#CAF0F8", "#023E8A"],
  sunset: ["#FF6B6B", "#FFA07A", "#FFD93D", "#6BCB77", "#4D96FF"],
  forest: ["#2D6A4F", "#40916C", "#52B788", "#74C69D", "#95D5B2"],
  neon: ["#FF006E", "#8338EC", "#3A86FF", "#FFBE0B", "#FB5607"],
  cosmic: ["#7400B8", "#6930C3", "#5390D9", "#4EA8DE", "#48BFE3"],
  earth: ["#8B5E3C", "#D4A373", "#FAEDCD", "#FEFAE0", "#CCD5AE"],
  mono: ["#212529", "#495057", "#ADB5BD", "#DEE2E6", "#F8F9FA"],
};

/**
 * Map soul schema palette names to internal palette keys.
 * Schema has "monochrome" and "pastel"; component has "mono" and no "pastel".
 */
export function resolvePaletteName(name: string): string {
  const mapping: Record<string, string> = {
    monochrome: "mono",
    pastel: "sunset", // closest warm soft palette
    custom: "",       // will use customColors instead
  };
  return mapping[name] ?? name;
}

// Simple hash function from hex address string to number
export function hashAddress(address: string): number {
  let hash = 0;
  const cleanAddr = address.toLowerCase().replace("0x", "");
  for (let i = 0; i < cleanAddr.length; i++) {
    const char = cleanAddr.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

// Seeded pseudo-random number generator
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Resolve the color palette from traits and seed.
 */
export function resolveColors(
  seed: number,
  traits?: AvatarTraits,
): string[] {
  const paletteNames = Object.keys(PALETTES);

  if (traits?.customColors && traits.customColors.length >= 3) {
    return traits.customColors;
  }

  const resolvedName = traits?.palette
    ? resolvePaletteName(traits.palette)
    : "";

  return (
    PALETTES[resolvedName] ?? PALETTES[paletteNames[seed % paletteNames.length]]
  );
}

/**
 * Generate a self-contained SVG string for a procedural avatar.
 * Same algorithm as the React ProceduralAvatar component.
 */
export function generateAvatarSvgString(
  address: string,
  size: number,
  traits?: AvatarTraits,
): string {
  const seed = hashAddress(address);
  const rand = seededRandom(seed);

  const colors = resolveColors(seed, traits);
  const complexity = traits?.complexity ?? (Math.floor(rand() * 5) + 1);
  const shapeType =
    traits?.shape ?? ["circle", "hexagon", "diamond", "square"][seed % 4];

  const bgColor1 = colors[0];
  const bgColor2 = colors[1];
  const gradientId = `grad-${address.slice(2, 10)}`;
  const clipId = `clip-${address.slice(2, 10)}`;

  const shapeCount = complexity + 2;
  const shapesSvg: string[] = [];

  for (let i = 0; i < shapeCount; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = rand() * (size * 0.3) + size * 0.05;
    const color = colors[Math.floor(rand() * colors.length)];
    const opacity = (rand() * 0.6 + 0.2).toFixed(3);
    const rotation = rand() * 360;

    switch (shapeType) {
      case "hexagon": {
        const points = Array.from({ length: 6 }, (_, j) => {
          const angle = (Math.PI / 3) * j + (rotation * Math.PI) / 180;
          return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
        }).join(" ");
        shapesSvg.push(
          `<polygon points="${points}" fill="${color}" opacity="${opacity}" />`,
        );
        break;
      }
      case "diamond":
        shapesSvg.push(
          `<rect x="${cx - r * 0.7}" y="${cy - r * 0.7}" width="${r * 1.4}" height="${r * 1.4}" fill="${color}" opacity="${opacity}" transform="rotate(45 ${cx} ${cy})" />`,
        );
        break;
      case "square":
        shapesSvg.push(
          `<rect x="${cx - r * 0.7}" y="${cy - r * 0.7}" width="${r * 1.4}" height="${r * 1.4}" fill="${color}" opacity="${opacity}" rx="${r * 0.15}" transform="rotate(${rotation} ${cx} ${cy})" />`,
        );
        break;
      default:
        // circle (also catches unknown shapes like shield/star/organic)
        shapesSvg.push(
          `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${opacity}" />`,
        );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<defs>`,
    `<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="${bgColor1}" />`,
    `<stop offset="100%" stop-color="${bgColor2}" />`,
    `</linearGradient>`,
    `<clipPath id="${clipId}">`,
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" />`,
    `</clipPath>`,
    `</defs>`,
    `<g clip-path="url(#${clipId})">`,
    `<rect width="${size}" height="${size}" fill="url(#${gradientId})" />`,
    ...shapesSvg,
    `</g>`,
    `</svg>`,
  ].join("");
}
