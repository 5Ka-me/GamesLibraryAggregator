import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, openExternal } from '@app/shared';

// Steam-like screenshot lightbox: arrows on the sides, a scrollable filmstrip
// of thumbnails below, close / open-in-browser at the top right. All chrome
// fades out after a couple of seconds without mouse movement. A single click
// zooms into the clicked point (magnifier-style — the zoomed image pans with
// the cursor); clicking again zooms back out. Esc closes, ←/→ navigate.

export interface ViewerShot {
  thumb: string;
  full: string;
}

const CHROME_HIDE_MS = 2200;
const ZOOM = 2.5;

const ctlBtn: React.CSSProperties = {
  border: 'none',
  borderRadius: 8,
  background: 'rgba(15, 15, 15, 0.65)',
  color: '#fff',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18,
  width: 40,
  height: 40,
};

const ScreenshotViewer: React.FC<{
  shots: ViewerShot[];
  initialIndex: number;
  onClose: () => void;
}> = ({ shots, initialIndex, onClose }) => {
  const { t } = useI18n();
  const [index, setIndex] = useState(initialIndex);
  const [chrome, setChrome] = useState(true);
  // Zoom anchor (0..1 relative to the stage) or null when fitted.
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const hideTimer = useRef<number | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const shot = shots[index];

  // Show the chrome and (re)arm the auto-hide timer.
  const poke = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), CHROME_HIDE_MS);
  }, []);

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [poke]);

  const prev = useCallback(() => {
    setZoom(null);
    setIndex((i) => (i - 1 + shots.length) % shots.length);
  }, [shots.length]);
  const next = useCallback(() => {
    setZoom(null);
    setIndex((i) => (i + 1) % shots.length);
  }, [shots.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') {
        prev();
        poke();
      } else if (e.key === 'ArrowRight') {
        next();
        poke();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next, poke]);

  // Keep the active thumbnail visible in the strip.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [index]);

  const stageAnchor = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onStageMouseMove = (e: React.MouseEvent) => {
    poke();
    // Magnifier feel: while zoomed the image pans to follow the cursor.
    if (zoom) setZoom(stageAnchor(e));
  };

  const chromeStyle = (base: React.CSSProperties): React.CSSProperties => ({
    ...base,
    opacity: chrome ? 1 : 0,
    pointerEvents: chrome ? 'auto' : 'none',
    transition: 'opacity 0.25s ease',
  });

  return createPortal(
    <div
      onMouseMove={onStageMouseMove}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0, 0, 0, 0.93)',
        display: 'flex',
        flexDirection: 'column',
        cursor: chrome ? 'default' : 'none',
        userSelect: 'none',
      }}
    >
      {/* Stage: click on the backdrop closes; click on the image toggles zoom */}
      <div
        ref={stageRef}
        onClick={(e) => {
          if (e.target === stageRef.current) onClose();
        }}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <img
          src={shot.full}
          alt=""
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            setZoom(zoom ? null : stageAnchor(e));
          }}
          style={{
            maxWidth: '96%',
            maxHeight: '96%',
            objectFit: 'contain',
            cursor: zoom ? 'zoom-out' : 'zoom-in',
            transform: zoom ? `scale(${ZOOM})` : 'none',
            transformOrigin: zoom ? `${zoom.x * 100}% ${zoom.y * 100}%` : 'center',
            transition: zoom ? 'transform-origin 0.05s linear' : 'transform 0.15s ease',
          }}
        />

        {/* Arrows */}
        {shots.length > 1 && (
          <>
            <button
              onClick={prev}
              aria-label="previous"
              style={chromeStyle({
                ...ctlBtn,
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 46,
                height: 72,
                fontSize: 26,
              })}
            >
              ‹
            </button>
            <button
              onClick={next}
              aria-label="next"
              style={chromeStyle({
                ...ctlBtn,
                position: 'absolute',
                right: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 46,
                height: 72,
                fontSize: 26,
              })}
            >
              ›
            </button>
          </>
        )}

        {/* Top-right controls */}
        <div style={chromeStyle({ position: 'absolute', top: 12, right: 14, display: 'flex', gap: 8 })}>
          <button onClick={() => openExternal(shot.full)} title={t('viewer.openBrowser')} style={ctlBtn}>
            ↗
          </button>
          <button onClick={onClose} title={t('viewer.close')} style={ctlBtn}>
            ✕
          </button>
        </div>

        {/* Counter */}
        <div
          style={chromeStyle({
            position: 'absolute',
            top: 16,
            left: 16,
            color: 'rgba(255,255,255,0.75)',
            fontSize: 13,
            fontWeight: 600,
          })}
        >
          {index + 1} / {shots.length}
        </div>
      </div>

      {/* Filmstrip */}
      <div
        ref={stripRef}
        style={chromeStyle({
          display: 'flex',
          gap: 8,
          padding: '10px 14px',
          overflowX: 'auto',
          background: 'rgba(0, 0, 0, 0.55)',
        })}
      >
        {shots.map((s, i) => (
          <img
            key={i}
            data-idx={i}
            src={s.thumb}
            alt=""
            draggable={false}
            onClick={() => {
              setZoom(null);
              setIndex(i);
            }}
            style={{
              height: 58,
              borderRadius: 4,
              cursor: 'pointer',
              flex: '0 0 auto',
              outline: i === index ? '2px solid var(--accent)' : '2px solid transparent',
              opacity: i === index ? 1 : 0.6,
            }}
          />
        ))}
      </div>
    </div>,
    document.body
  );
};

export default ScreenshotViewer;
