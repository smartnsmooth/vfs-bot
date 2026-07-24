/**
 * "Monitor bots" tab markup + client script for the setup page.
 *
 * The client connects to `/api/monitor/events` (SSE), renders one tile per
 * instance, and focuses Chrome on tile click via `/api/monitor/focus`.
 */
export function buildMonitorTabHtml(): string {
  return `
<style>
  .mon-wrap { color: #e7e9ea; }
  .mon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 0.1rem; }
  .mon-tile { background: #15202b; border: 1px solid #38444d; border-top: 1px solid #55606b; border-radius: 6px; padding: 0.28rem 0.35rem; font-size: 0.62rem; min-width: 0; cursor: pointer; transition: background .12s, border-color .12s; line-height: 1.25; }
  .mon-tile:hover { background: #1b2836; border-color: #4a5a68; }
  .mon-tile .id { font-weight: 700; color: #fff; font-size: 0.68rem; }
  .mon-tile .phase { float: right; font-size: 0.52rem; text-transform: uppercase; letter-spacing: 0.02em; padding: 0.05rem 0.22rem; border-radius: 3px; background: #253341; color: #cdd7df; }
  .mon-tile .page { color: #7fd1ff; margin-top: 0.15rem; font-size: 0.58rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mon-tile .detail { color: #c4cdd4; margin-top: 0.12rem; min-height: 0.95em; font-size: 0.58rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mon-tile .cap { margin-top: 0.12rem; font-size: 0.55rem; color: #8b98a5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mon-tile .actions { margin-top: 0.22rem; display: flex; gap: 0.2rem; }
  .mon-tile .mon-btn { flex: 1; border: 1px solid #38444d; background: #1c2732; color: #e7e9ea; border-radius: 4px; padding: 0.12rem 0.2rem; font-size: 0.55rem; cursor: pointer; line-height: 1.15; }
  .mon-tile .mon-btn:hover { background: #253341; border-color: #4a5a68; }
  .mon-tile .mon-btn.restart { color: #ffb347; border-color: #5a4630; }
  .mon-tile .mon-btn.restart:hover { background: #2a2218; border-color: #8a6a3a; }
  .mon-tile.attn { border-color: #f4212e; border-top-color: #f4212e; box-shadow: 0 0 0 1px #f4212e55; animation: monPulse 1.1s ease-in-out infinite; }
  @keyframes monPulse { 0%,100% { box-shadow: 0 0 0 1px #f4212e55; } 50% { box-shadow: 0 0 8px 1px #f4212eaa; } }
  @media (prefers-reduced-motion: reduce) { .mon-tile.attn { animation: none; } }
  .mon-toast { position: fixed; right: 1rem; bottom: 1rem; background: #1c2732; border: 1px solid #38444d; color: #e7e9ea; padding: 0.6rem 0.85rem; border-radius: 8px; font-size: 0.85rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 50; max-width: 22rem; }
  .mon-toast.show { opacity: 1; }
</style>
<div class="mon-wrap">
  <div class="mon-grid" id="monGrid"></div>
</div>
<div class="mon-toast" id="monToast"></div>
<script>
(function(){
  if (window.__monitorInit) return;
  var started = false;
  var instances = {};
  var prevAttn = {};
  var rafPending = false;
  var warmupUntil = 0;

  var PHASE_COLORS = {
    idle: '#8b98a5', launching: '#5aa9ff', login: '#f5a623', otp: '#f5a623',
    turnstile: '#f5a623', polling: '#1d9bf0', booking: '#a48bec', payment: '#00ba7c',
    recovering: '#ff8a3d', stopped: '#f4212e', needs_attention: '#f4212e', unresponsive: '#6b7686'
  };

  function el(id){ return document.getElementById(id); }

  function toast(msg){
    var t = el('monToast'); if(!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t.__timer); t.__timer = setTimeout(function(){ t.classList.remove('show'); }, 3200);
  }

  var audioCtx = null;
  function beep(){
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
      o.start(); o.stop(audioCtx.currentTime + 0.42);
    } catch(e){ /* ignore */ }
  }

  function post(action, body){
    return fetch('/api/monitor/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function(r){ return r.json(); }).catch(function(e){ return { ok:false, error: String(e) }; });
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]); }); }

  function shortPage(u){
    if (!u) return '';
    try {
      var url = new URL(u);
      var segs = url.pathname.split('/').filter(Boolean);
      return segs.length ? segs[segs.length - 1] : (url.hostname || String(u));
    } catch(e){
      var parts = String(u).split(/[?#]/)[0].split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : String(u);
    }
  }

  function tileHtml(s){
    var color = PHASE_COLORS[s.phase] || '#55606b';
    var attn = (s.phase === 'needs_attention' || s.attention) ? ' attn' : '';
    var cap = s.captcha || {};
    var capBadge = '';
    if (cap.last === 'passed') capBadge = '<span style="color:#00ba7c">captcha ok</span>';
    else if (cap.last === 'failed') capBadge = '<span style="color:#f4212e">captcha FAIL</span>';
    else if (cap.last === 'waiting') capBadge = '<span style="color:#f5a623">captcha wait</span>';
    var capCounts = ' <span style="color:#6b7686">(' + (cap.solved||0) + '/' + (cap.attempts||0) + ')</span>';
    var detail = s.detail || '';
    if (s.lastError && (s.phase === 'stopped' || s.attention)) detail = s.lastError.message || detail;
    var pageShort = shortPage(s.page);
    var tip = [];
    if (s.egressIp) tip.push('ip:' + s.egressIp);
    if (s.account) tip.push(s.account);
    if (s.center) tip.push('c:' + s.center);
    tip.push('polls:' + (s.pollCount||0));
    if (s.lastCode) tip.push('code:' + s.lastCode);

    return '<div class="mon-tile' + attn + '" data-id="' + s.instanceId + '" title="' + esc(tip.join(' · ') || ('Focus bot #' + s.instanceId)) + '" style="border-top-color:' + color + '">' +
      '<span class="phase" style="color:' + color + '">' + esc(s.phase) + '</span>' +
      '<span class="id">' + s.instanceId + '</span>' +
      '<div class="page" title="' + esc(s.page || '') + '">' + (pageShort ? esc(pageShort) : '<span style="color:#55606b">page —</span>') + '</div>' +
      '<div class="detail" title="' + esc(detail) + '">' + esc(detail) + '</div>' +
      '<div class="cap">' + (capBadge || '<span style="color:#6b7686">captcha —</span>') + capCounts + '</div>' +
      '<div class="actions">' +
        '<button type="button" class="mon-btn restart" data-action="restart" title="Restart this bot">Restart</button>' +
      '</div>' +
    '</div>';
  }

  var PROBLEM = { needs_attention:1, stopped:1, unresponsive:1, recovering:1 };

  function render(){
    rafPending = false;
    var list = Object.keys(instances).map(function(k){ return instances[k]; });
    list.sort(function(a,b){
      var pa = PROBLEM[a.phase] ? 0 : 1, pb = PROBLEM[b.phase] ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.instanceId - b.instanceId;
    });
    var html = ''; for (var j=0;j<list.length;j++){ html += tileHtml(list[j]); }
    el('monGrid').innerHTML = html;
  }

  function scheduleRender(){ if (rafPending) return; rafPending = true; requestAnimationFrame(render); }

  function onStatus(s){
    var wasAttn = prevAttn[s.instanceId];
    var isAttn = (s.phase === 'needs_attention' || !!s.attention);
    if (isAttn && !wasAttn && Date.now() > warmupUntil){
      var reason = (s.attention && s.attention.reason) || 'issue';
      toast('Bot #' + s.instanceId + ' needs attention: ' + reason);
      beep();
    }
    prevAttn[s.instanceId] = isAttn;
    instances[s.instanceId] = s;
    scheduleRender();
  }

  function connect(){
    warmupUntil = Date.now() + 2500;
    var es = new EventSource('/api/monitor/events');
    es.onmessage = function(ev){ try { onStatus(JSON.parse(ev.data)); } catch(e){} };
  }

  document.addEventListener('click', function(ev){
    var btn = ev.target.closest ? ev.target.closest('.mon-btn') : null;
    if (btn) {
      ev.preventDefault();
      ev.stopPropagation();
      var tileBtn = btn.closest('.mon-tile');
      if (!tileBtn) return;
      var btnId = parseInt(tileBtn.getAttribute('data-id'), 10);
      if (!btnId) return;
      var action = btn.getAttribute('data-action');
      if (action === 'restart') {
        toast('Restarting bot #' + btnId + '…');
        post('restart', { instanceId: btnId }).then(function(r){
          toast('#' + btnId + (r.ok ? ' restarting' : ': ' + (r.error || 'restart failed')));
        });
      }
      return;
    }
    var tile = ev.target.closest ? ev.target.closest('.mon-tile') : null;
    if (!tile) return;
    var id = parseInt(tile.getAttribute('data-id'), 10);
    if (!id) return;
    toast('Focusing bot #' + id + '…');
    post('focus', { instanceId: id }).then(function(r){
      toast('#' + id + (r.ok ? ' focused' : ': ' + (r.error || 'focus failed')));
    });
  });

  window.__monitorInit = function(){
    if (started) return; started = true;
    warmupUntil = Date.now() + 2500;
    fetch('/api/monitor/snapshot').then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok && Array.isArray(d.instances)){
        for (var i = 0; i < d.instances.length; i++){
          var s = d.instances[i];
          instances[s.instanceId] = s;
          prevAttn[s.instanceId] = (s.phase === 'needs_attention' || !!s.attention);
        }
        render();
      }
    }).catch(function(){});
    connect();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ window.__monitorInit(); });
  } else {
    window.__monitorInit();
  }
})();
</script>`;
}
