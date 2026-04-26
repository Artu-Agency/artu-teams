import { API_BASE } from "@/api/client";

/**
 * Build the WebSocket base URL for live events.
 *
 * In local dev (Vite proxy), API_BASE is "/api" and WS goes through
 * the same host. In production with a reverse proxy (e.g. Vercel),
 * VITE_WS_URL points directly to the backend server so WebSocket
 * connections bypass the proxy (which can't handle WS upgrades).
 */
export function getWsBaseUrl(): string {
  const wsUrl = import.meta.env.VITE_WS_URL;
  if (wsUrl) return wsUrl;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${API_BASE}`;
}
// force redeploy 1777218778
