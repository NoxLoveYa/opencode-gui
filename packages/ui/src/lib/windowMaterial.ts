import React from 'react';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { DEFAULT_DESKTOP_WINDOW_MATERIAL, DEFAULT_DESKTOP_WINDOW_MATERIAL_OPACITY, type DesktopWindowMaterial, isDesktopLocalOriginActive, isWindowsDesktopShell, normalizeDesktopWindowMaterial, normalizeDesktopWindowMaterialOpacity } from '@/lib/desktop';
import { setDesktopWindowMaterial } from '@/lib/desktopNative';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Applies the material tokens to an embedded session-chat frame (the
 * subtask session viewer). The iframe has no shell preload or IPC, so the
 * shell gate below never passes inside it and the frame would keep solid
 * tokens while the main window tints. The top-level window owns the DWM
 * backdrop, so no native call is made here — only the tokens, which the
 * frame's fills resolve exactly like the main window's.
 *
 * Consumes already-normalized values: callers parse untrusted input with
 * normalizeDesktopWindowMaterial / normalizeDesktopWindowMaterialOpacity
 * at their boundary before calling.
 */
export function applyEmbeddedWindowMaterial(material: DesktopWindowMaterial, opacity: number): void {
  const root = document.documentElement;
  if (material === 'off') {
    delete root.dataset.windowMaterial;
    root.style.removeProperty('--oc-window-material-opacity');
    return;
  }
  root.dataset.windowMaterial = material;
  root.style.setProperty('--oc-window-material-opacity', String(opacity / 100));
}

/**
 * Native Mica/Acrylic backdrop for the main desktop window (Windows only).
 *
 * Two halves move together: the shell paints the DWM backdrop behind the
 * window, and CSS makes the app background translucent so it shows through.
 * Every other runtime is an explicit no-op, and the mini-chat window never
 * mounts this hook so it stays opaque.
 */
export function useWindowMaterialEffect(): void {
  const material = useUIStore((state) => state.desktopWindowMaterial);
  const opacity = useUIStore((state) => state.desktopWindowMaterialOpacity);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    const normalized = normalizeDesktopWindowMaterial(material) ?? DEFAULT_DESKTOP_WINDOW_MATERIAL;
    const clamped = normalizeDesktopWindowMaterialOpacity(opacity) ?? DEFAULT_DESKTOP_WINDOW_MATERIAL_OPACITY;
    // Subtask viewer iframes share the main window's backdrop: apply the
    // tokens from the store without the shell gate or native call, both
    // unavailable inside the frame (see applyEmbeddedWindowMaterial).
    if (isEmbeddedSessionChat()) {
      applyEmbeddedWindowMaterial(normalized, clamped);
      return;
    }
    const active = isWindowsDesktopShell() && isDesktopLocalOriginActive() && normalized !== 'off';

    if (!active) {
      delete root.dataset.windowMaterial;
      root.style.removeProperty('--oc-window-material-opacity');
      if (isWindowsDesktopShell() && isDesktopLocalOriginActive()) {
        void setDesktopWindowMaterial('off');
      }
      return;
    }

    root.dataset.windowMaterial = normalized;
    root.style.setProperty('--oc-window-material-opacity', String(clamped / 100));
    void setDesktopWindowMaterial(normalized);
  }, [material, opacity]);
}
