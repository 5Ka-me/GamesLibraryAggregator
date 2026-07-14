import { useEffect, useRef } from 'react';

// Preserves the #app-scroll position across route changes. The position is
// tracked CONTINUOUSLY via a scroll listener — reading scrollTop at unmount is
// too late (React runs effect cleanup after the DOM has been swapped, when the
// container has already collapsed/clamped to 0).
const positions = new Map<string, number>();

/**
 * @param key   storage key, unique per page (e.g. 'library', 'store')
 * @param ready pass true once the page's content is rendered tall enough —
 *              restoration happens once, on the first ready render.
 */
export function useScrollRestore(key: string, ready: boolean): void {
  const restored = useRef(false);

  useEffect(() => {
    const el = document.getElementById('app-scroll');
    if (!el) return;
    const onScroll = () => {
      // Only record after restoration so the initial 0 doesn't overwrite the
      // saved position before we've had a chance to apply it.
      if (restored.current) positions.set(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [key]);

  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    requestAnimationFrame(() => {
      document.getElementById('app-scroll')?.scrollTo(0, positions.get(key) ?? 0);
    });
  }, [ready, key]);
}
