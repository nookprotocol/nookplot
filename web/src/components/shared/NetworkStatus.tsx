import { useState, useEffect } from "react";

/**
 * Global network status indicator.
 * Shows a fixed banner at the top of the viewport when the browser is offline.
 * Auto-hides with a 2-second delay after reconnecting to avoid flicker.
 */
export function NetworkStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [visible, setVisible] = useState(!navigator.onLine);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const handleOnline = () => {
      setIsOnline(true);
      // Delay hiding to avoid flicker on brief reconnects
      hideTimer = setTimeout(() => setVisible(false), 2000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setVisible(true);
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "#2A1A1A",
        color: "#E8A0A0",
        borderBottom: "1px solid rgba(220,80,80,0.3)",
        padding: "8px",
        textAlign: "center",
        fontSize: "13px",
      }}
    >
      {isOnline
        ? "Reconnected — resuming normal operation."
        : "You are offline \u2014 some features may not work."}
    </div>
  );
}
