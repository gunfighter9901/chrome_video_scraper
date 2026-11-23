// content/button.js
// Adds a "Download" button to the largest <video> on the page. Clicking it asks the background
// to detect the best media and start a download (quick action, no popup needed).
(function () {
  if (window.__uvButtonLoaded) return;
  window.__uvButtonLoaded = true;

  const BTN_ID = 'uv-download-button';
  let observer = null;
  let lastVideo = null;

  function pickVideo() {
    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      const area = (r.width || v.videoWidth || 0) * (r.height || v.videoHeight || 0);
      if (area > bestArea) { bestArea = area; best = v; }
    });
    return best;
  }

  function attach() {
    const existing = document.getElementById(BTN_ID);
    // Cheap idempotence: the button is still attached to a live video — nothing to do.
    if (existing && lastVideo && lastVideo.isConnected) return true;
    if (existing) existing.remove();

    const video = pickVideo();
    if (!video) return false;
    lastVideo = video;

    let host = video.parentElement;
    if (!host) return false;
    const cs = getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '⬇ Download';
    btn.title = 'Download this video';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.dataset.busy = '1';
      btn.textContent = 'Detecting…';
      try {
        chrome.runtime.sendMessage({ type: 'UV_QUICK_DOWNLOAD', pageUrl: location.href, title: document.title }, (resp) => {
          btn.dataset.busy = '0';
          if (resp && resp.ok) {
            btn.textContent = '✓ Started';
          } else {
            btn.textContent = '⚠ ' + ((resp && resp.error) || 'No media found');
          }
          setTimeout(() => { btn.textContent = '⬇ Download'; }, 2500);
        });
      } catch {
        btn.dataset.busy = '0';
        btn.textContent = '⬇ Download';
      }
    });
    host.appendChild(btn);
    return true;
  }

  let attachTimer = null;
  function scheduleAttach() {
    if (attachTimer) return;
    attachTimer = setTimeout(() => { attachTimer = null; attach(); }, 250);
  }

  function start() {
    attach();
    try {
      observer = new MutationObserver(scheduleAttach);
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
