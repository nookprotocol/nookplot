/**
 * Shareable revenue card — renders agent earnings as a downloadable PNG.
 *
 * Opens as a modal overlay triggered by a small share icon.
 * Uses HTML5 Canvas for pixel-perfect rendering and image export.
 * Two themes: dark (brand bark) and light (brand jasmine).
 * Typography: Libre Baskerville for headline + wordmark, DM Sans for body,
 * IBM Plex Mono for stat values.
 * Renders at 2x resolution for retina crispness.
 *
 * Logo handling: Processes nookplot.png at runtime to remove the white
 * background via luminance-based alpha masking, preserving the original
 * green ginkgo leaf pixels. Uses an off-screen canvas for processing.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { Download, Sun, Moon, Share2, X } from "lucide-react";
import { formatUnits, formatEther } from "viem";

// ── Brand palette ────────────────────────────────────────────

const THEMES = {
  dark: {
    bg: "#1A1A18",
    text: "#EFEAD8",
    textMuted: "#8A8A82",
    textSecondary: "#A5A59C",
    accent: "#6DB874",
    border: "rgba(109,184,116,0.12)",
    glow: [109, 184, 116] as const,
    divider: "rgba(109,184,116,0.08)",
    watermarkAlpha: 0.035,
  },
  light: {
    bg: "#EFEAD8",
    text: "#1A1A18",
    textMuted: "#5C5C55",
    textSecondary: "#8A8A82",
    accent: "#4A8B52",
    border: "rgba(26,26,24,0.08)",
    glow: [74, 139, 82] as const,
    divider: "rgba(26,26,24,0.06)",
    watermarkAlpha: 0.05,
  },
} as const;

type Theme = keyof typeof THEMES;

// ── Canvas dimensions (social share-friendly) ────────────────

const W = 1200;
const H = 630;
const SCALE = 2;
const PAD = 72;

// ── Props ────────────────────────────────────────────────────

export interface ShareCardProps {
  agentName: string | null;
  nookRewardsWei: string | null;   // raw 18-decimal
  nookPriceUsd: number | null;
  ethEarningsWei: bigint;          // raw wei
  creditsEarned: number;
}

// ── Helpers ──────────────────────────────────────────────────

function fmtNook(raw: string): string {
  try {
    const n = Number(formatUnits(BigInt(raw), 18));
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch {
    return "0";
  }
}

function fmtEth(raw: bigint): string {
  try {
    const n = Number(formatEther(raw));
    if (n === 0) return "0";
    return n.toFixed(4);
  } catch {
    return "0";
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Process logo PNG: center-crop to square, then remove white background
 * via luminance-based alpha masking. The source nookplot.png is 1920×1080
 * (landscape) with the ginkgo leaf centered — we crop to the center
 * square (1080×1080) to match the CSS `object-cover` behavior used
 * elsewhere on the site. Returns an off-screen canvas for drawImage().
 */
function processLogo(img: HTMLImageElement): HTMLCanvasElement {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  // Center-crop to square (like CSS object-fit: cover on a square box)
  const side = Math.min(iw, ih);
  const sx = (iw - side) / 2;
  const sy = (ih - side) / 2;

  const c = document.createElement("canvas");
  c.width = side;
  c.height = side;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side);

  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    // Luminance (perceived brightness)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum > 0.92) {
      // White/near-white → fully transparent
      px[i + 3] = 0;
    } else if (lum > 0.82) {
      // Transition zone → fade out smoothly
      px[i + 3] = Math.round(255 * ((0.92 - lum) / 0.10));
    }
    // else: keep original alpha (fully opaque colored pixels)
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

// ── Canvas draw ──────────────────────────────────────────────

function drawCard(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  props: ShareCardProps,
  logoCanvas: HTMLCanvasElement | null,
) {
  const c = THEMES[theme];
  const [gr, gg, gb] = c.glow;

  // ── Background fill
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Subtle radial glow (bottom-left, large and diffuse)
  const glow = ctx.createRadialGradient(
    W * 0.15, H * 0.85, 0,
    W * 0.15, H * 0.85, W * 0.6,
  );
  glow.addColorStop(0, `rgba(${gr},${gg},${gb},0.05)`);
  glow.addColorStop(0.4, `rgba(${gr},${gg},${gb},0.02)`);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ── Large ginkgo watermark — editorial decorative element
  if (logoCanvas) {
    ctx.save();
    ctx.globalAlpha = c.watermarkAlpha;
    const wmSize = 420;
    ctx.drawImage(
      logoCanvas,
      W - wmSize - 20, H / 2 - wmSize / 2,
      wmSize, wmSize,
    );
    ctx.restore();
  }

  // ── Outer card border
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 16);
  ctx.stroke();

  // ── Logo (small, processed) + wordmark — top left
  const logoY = PAD;
  const logoSize = 32;
  if (logoCanvas) {
    ctx.drawImage(logoCanvas, PAD, logoY, logoSize, logoSize);
  }

  // Wordmark — Libre Baskerville 400 (matches site nav)
  const wordmarkX = PAD + logoSize + 14;
  ctx.textBaseline = "middle";
  ctx.font = '400 20px "Libre Baskerville", Georgia, serif';
  ctx.fillStyle = c.textMuted;
  ctx.fillText("nookplot", wordmarkX, logoY + logoSize / 2);
  ctx.textBaseline = "alphabetic";

  // ── "{Name} has earned" — Libre Baskerville 400 (regular)
  const name = props.agentName || "Agent";
  ctx.font = '400 28px "Libre Baskerville", Georgia, serif';
  ctx.fillStyle = c.textSecondary;
  ctx.fillText(`${name} has earned`, PAD, 178);

  // ── Hero: USD value — DM Sans bold, large, accent colored
  let heroText = "$0.00";
  if (props.nookRewardsWei && props.nookPriceUsd) {
    try {
      const nookFloat = Number(formatUnits(BigInt(props.nookRewardsWei), 18));
      const usd = nookFloat * props.nookPriceUsd;
      heroText =
        usd < 0.01
          ? "<$0.01"
          : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } catch { /* keep $0.00 */ }
  }
  ctx.font = 'bold 96px "DM Sans", system-ui, sans-serif';
  ctx.fillStyle = c.accent;
  ctx.fillText(heroText, PAD, 302);

  // ── Subtext: "Total Revenue" label
  ctx.font = '400 15px "DM Sans", system-ui, sans-serif';
  ctx.fillStyle = c.textMuted;
  ctx.fillText("Total Revenue", PAD, 336);

  // ── Horizontal divider — gradient fade
  const divY = 380;
  const grad = ctx.createLinearGradient(PAD, divY, W - PAD, divY);
  grad.addColorStop(0, `rgba(${gr},${gg},${gb},0.15)`);
  grad.addColorStop(0.6, `rgba(${gr},${gg},${gb},0.04)`);
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(PAD, divY, W - PAD * 2, 1);

  // ── Stat row (3 columns) — IBM Plex Mono for values
  const statY = 418;
  const colW = (W - PAD * 2) / 3;

  const stats = [
    { value: props.nookRewardsWei ? fmtNook(props.nookRewardsWei) : "0", label: "NOOK earned" },
    { value: fmtEth(props.ethEarningsWei), label: "ETH earned" },
    { value: props.creditsEarned.toFixed(2), label: "Credits earned" },
  ];

  stats.forEach((stat, i) => {
    const x = PAD + i * colW;

    // Value — IBM Plex Mono
    ctx.font = '500 28px "IBM Plex Mono", "SF Mono", monospace';
    ctx.fillStyle = c.text;
    ctx.fillText(stat.value, x, statY + 32);

    // Label — DM Sans
    ctx.font = '400 13px "DM Sans", system-ui, sans-serif';
    ctx.fillStyle = c.textMuted;
    ctx.fillText(stat.label, x, statY + 58);

    // Column divider
    if (i < stats.length - 1) {
      ctx.fillStyle = c.divider;
      ctx.fillRect(x + colW - 1, statY + 8, 1, 56);
    }
  });

  // ── Footer — right aligned URL
  ctx.textAlign = "right";
  ctx.font = '400 13px "DM Sans", system-ui, sans-serif';
  ctx.fillStyle = c.textMuted;
  ctx.fillText("www.nookplot.com", W - PAD, H - 36);
  ctx.textAlign = "left";
}

// ── Share button (tiny icon, goes inside a stat card) ────────

export function ShareRevenueButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-accent/70 hover:text-accent hover:bg-accent/10 transition-colors"
      title="Share revenue card"
    >
      <Share2 className="h-3.5 w-3.5" />
      Revenue Card
    </button>
  );
}

// ── Modal overlay ────────────────────────────────────────────

export function ShareRevenueModal({
  open,
  onClose,
  ...props
}: ShareCardProps & { open: boolean; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [logoLoaded, setLogoLoaded] = useState(false);

  // Load and process logo PNG once
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      logoCanvasRef.current = processLogo(img);
      setLogoLoaded(true);
    };
    img.src = "/nookplot.png";
  }, []);

  // Redraw canvas at 2x when deps change
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    document.fonts.ready.then(() => {
      canvas.width = W * SCALE;
      canvas.height = H * SCALE;
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      drawCard(ctx, theme, props, logoCanvasRef.current);
    });
  }, [
    open,
    theme,
    props.agentName,
    props.nookRewardsWei,
    props.nookPriceUsd,
    props.ethEarningsWei,
    props.creditsEarned,
    logoLoaded,
  ]);

  // Download as PNG
  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nookplot-revenue-${(props.agentName || "agent").replace(/\s+/g, "-")}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [props.agentName]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal content */}
      <div
        className="relative z-10 w-full max-w-4xl mx-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-6 w-6" />
        </button>

        {/* Card preview */}
        <div className="overflow-hidden rounded-xl border border-border shadow-2xl">
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
        </div>

        {/* Actions bar below card */}
        <div className="flex items-center justify-center gap-3 mt-4">
          {/* Theme toggle */}
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
            {theme === "dark" ? "Light" : "Dark"}
          </button>

          {/* Save Image */}
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 transition-colors"
          >
            <Download className="h-4 w-4" />
            Save Image
          </button>
        </div>
      </div>
    </div>
  );
}
