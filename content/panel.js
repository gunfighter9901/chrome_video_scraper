// content/panel.js
// Lightweight, generalized in-page download progress panel.
// Public API on window.__uvPanel: add / update / complete / error / remove.
// Styles are provided by content/panel.css (injected via chrome.scripting.insertCSS).
(function () {
  if (window.__uvPanel) return;

  function formatBytes(b){ if(!b||b<=0) return '0 B'; const k=1024,s=['B','KB','MB','GB'],i=Math.min(3,Math.floor(Math.log(b)/Math.log(k))); return (b/Math.pow(k,i)).toFixed(2)+' '+s[i]; }

  const state = { root: null, list: null, items: new Map() };

  function ensure() {
    if (state.root && document.documentElement.contains(state.root)) return;
    const root = document.createElement('div');
    root.id = 'uv-panel';
    root.innerHTML = '<div class="uv-head"><span>Universal Video Downloader</span>' +
      '<button type="button" title="Hide" data-uv-hide>&times;</button></div><div class="uv-body"></div>';
    (document.body || document.documentElement).appendChild(root);
    root.querySelector('[data-uv-hide]').addEventListener('click', () => root.classList.remove('show'));
    state.root = root;
    state.list = root.querySelector('.uv-body');
  }

  function addItem(id, name) {
    ensure();
    if (state.items.has(id)) return state.items.get(id);
    const el = document.createElement('div');
    el.className = 'uv-item';
    el.dataset.id = id;
    el.innerHTML = `<div class="uv-name" title="${escapeHtml(name || 'Video')}">${escapeHtml(name || 'Video')}</div>
      <div class="uv-status">Starting…</div>
      <div class="uv-bar"><i></i></div>
      <div class="uv-meta"><span class="uv-speed"></span><span class="uv-text">0%</span></div>`;
    el.querySelector('.uv-cancel')?.remove();
    const cancel = document.createElement('button');
    cancel.className = 'uv-cancel';
    cancel.type = 'button';
    cancel.textContent = 'cancel';
    cancel.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'UV_CANCEL', downloadId: id }, () => void chrome.runtime.lastError); } catch {}
      removeItem(id);
    });
    el.querySelector('.uv-name').appendChild(cancel);
    state.list.appendChild(el);
    state.root.classList.add('show');
    state.items.set(id, el);
    return el;
  }

  function updateItem(id, { progress = 0, status, downloaded, total } = {}) {
    const el = state.items.get(id) || addItem(id);
    const bar = el.querySelector('.uv-bar > i');
    const st = el.querySelector('.uv-status');
    const tx = el.querySelector('.uv-text');
    const sp = el.querySelector('.uv-speed');
    if (typeof progress === 'number') bar.style.width = Math.max(0, Math.min(100, progress)) + '%';
    if (status) st.textContent = status;
    if (typeof total === 'number' && total > 0) {
      tx.textContent = `${Math.round(progress || 0)}% · ${formatBytes(downloaded)} / ${formatBytes(total)}`;
    } else {
      tx.textContent = `${Math.round(progress || 0)}%`;
    }
    void sp;
  }

  function removeItem(id) {
    const el = state.items.get(id);
    if (el) el.remove();
    state.items.delete(id);
    if (!state.items.size && state.root) state.root.classList.remove('show');
  }

  function completeItem(id, ok, name) {
    const el = state.items.get(id) || addItem(id, name);
    el.querySelector('.uv-status').textContent = ok ? 'Complete' : 'Failed';
    el.querySelector('.uv-bar > i').style.width = '100%';
    setTimeout(() => removeItem(id), 2500);
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  window.__uvPanel = {
    add: addItem,
    update: updateItem,
    complete: completeItem,
    remove: removeItem,
    show: () => { ensure(); state.root.classList.add('show'); },
  };

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.action) return false;
      if (msg.action === 'uvAddDownload') { addItem(msg.downloadId, msg.filename); sendResponse && sendResponse({ ok: true }); return false; }
      if (msg.action === 'uvProgress') { updateItem(msg.downloadId, msg.data || {}); sendResponse && sendResponse({ ok: true }); return false; }
      if (msg.action === 'uvComplete') { completeItem(msg.downloadId, true, msg.filename); sendResponse && sendResponse({ ok: true }); return false; }
      if (msg.action === 'uvError') { completeItem(msg.downloadId, false); sendResponse && sendResponse({ ok: true }); return false; }
      return false;
    });
  } catch {}
})();
