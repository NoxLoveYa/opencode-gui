import React from 'react';
import { desktopWindowMaterialOpacitySchema, desktopWindowMaterialSchema, isDesktopLocalOriginActive, isWindowsDesktopShell } from '@/lib/desktop';
import { setDesktopWindowMaterial } from '@/lib/desktopNative';
import { useUIStore } from '@/stores/useUIStore';

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
    const root = document.documentElement;
    const normalized = desktopWindowMaterialSchema.parse(material);
    const clamped = desktopWindowMaterialOpacitySchema.parse(opacity);
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
