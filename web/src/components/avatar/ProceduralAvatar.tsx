/**
 * Deterministic procedural avatar rendered as inline SVG.
 * Uses keccak256(address) as seed for shapes/colors,
 * with optional soul avatar traits for palette/shape/complexity overrides.
 */

import type React from "react";
import {
  type AvatarTraits,
  hashAddress,
  seededRandom,
  resolveColors,
} from "./avatarCore";

export type { AvatarTraits };

interface ProceduralAvatarProps {
  address: string;
  traits?: AvatarTraits;
  size?: number;
  className?: string;
}

export function ProceduralAvatar({
  address,
  traits,
  size = 64,
  className = "",
}: ProceduralAvatarProps) {
  const seed = hashAddress(address);
  const rand = seededRandom(seed);

  const colors = resolveColors(seed, traits);
  const complexity = traits?.complexity ?? (Math.floor(rand() * 5) + 1);
  const shapeType = traits?.shape ?? ["circle", "hexagon", "diamond", "square"][seed % 4];

  // Generate background gradient
  const bgColor1 = colors[0];
  const bgColor2 = colors[1];
  const gradientId = `grad-${address.slice(2, 10)}`;

  // Generate shapes based on complexity
  const shapes: React.ReactElement[] = [];
  const shapeCount = complexity + 2;

  for (let i = 0; i < shapeCount; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = rand() * (size * 0.3) + size * 0.05;
    const color = colors[Math.floor(rand() * colors.length)];
    const opacity = rand() * 0.6 + 0.2;
    const rotation = rand() * 360;

    switch (shapeType) {
      case "hexagon": {
        const points = Array.from({ length: 6 }, (_, j) => {
          const angle = (Math.PI / 3) * j + (rotation * Math.PI) / 180;
          return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
        }).join(" ");
        shapes.push(
          <polygon
            key={i}
            points={points}
            fill={color}
            opacity={opacity}
          />,
        );
        break;
      }
      case "diamond":
        shapes.push(
          <rect
            key={i}
            x={cx - r * 0.7}
            y={cy - r * 0.7}
            width={r * 1.4}
            height={r * 1.4}
            fill={color}
            opacity={opacity}
            transform={`rotate(45 ${cx} ${cy})`}
          />,
        );
        break;
      case "square":
        shapes.push(
          <rect
            key={i}
            x={cx - r * 0.7}
            y={cy - r * 0.7}
            width={r * 1.4}
            height={r * 1.4}
            fill={color}
            opacity={opacity}
            rx={r * 0.15}
            transform={`rotate(${rotation} ${cx} ${cy})`}
          />,
        );
        break;
      default:
        shapes.push(
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill={color}
            opacity={opacity}
          />,
        );
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={{ borderRadius: "50%" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={bgColor1} />
          <stop offset="100%" stopColor={bgColor2} />
        </linearGradient>
        <clipPath id={`clip-${address.slice(2, 10)}`}>
          <circle cx={size / 2} cy={size / 2} r={size / 2} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-${address.slice(2, 10)})`}>
        <rect width={size} height={size} fill={`url(#${gradientId})`} />
        {shapes}
      </g>
    </svg>
  );
}
