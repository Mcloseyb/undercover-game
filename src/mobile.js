// Keep touch play at the requested 1:1 scale while allowing normal page scrolling.
export function initMobile() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let fullHeight = window.innerHeight, width = window.innerWidth;
  function resize() {
    const height = viewport?.height || window.innerHeight;
    if (Math.abs(window.innerWidth - width) > 80) { fullHeight = window.innerHeight; width = window.innerWidth; }
    fullHeight = Math.max(fullHeight, window.innerHeight);
    root.style.setProperty('--viewport-height', `${Math.round(height)}px`);
    const editing = document.activeElement?.matches('input,textarea');
    document.body.classList.toggle('keyboard-open', !!editing && fullHeight - height > 120);
  }
  const preventZoom = event => { if (event.cancelable) event.preventDefault(); };
  document.addEventListener('gesturestart', preventZoom, { passive: false });
  document.addEventListener('gesturechange', preventZoom, { passive: false });
  document.addEventListener('touchmove', event => {
    if (event.touches.length > 1) preventZoom(event);
  }, { passive: false });
  window.addEventListener('resize', resize);
  document.addEventListener('focusin', resize);
  document.addEventListener('focusout', resize);
  viewport?.addEventListener('resize', resize);
  resize();
}
