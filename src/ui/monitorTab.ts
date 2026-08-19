/**
 * "Monitor bots" tab markup + client script for the setup page.
 *
 * Per-card Stop/Resume polling + Restart. Cards needing manual action
 * (captcha / OTP / hard stop that still needs the operator) blink their background.
 * Auto-recovery (401/403/CF/IP rotate) uses phase "recovering" and does not blink.
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
  .mon-tile .mon-btn.restart { color: #6b7686; background: #1a2228; border-color: #2a3238; }
  .mon-tile .mon-btn.restart:hover { background: #222a32; border-color: #3a4349; color: #8b98a5; }
  .mon-tile .mon-btn.stop { color: #6b7686; background: #1a2228; border-color: #2a3238; }
  .mon-tile .mon-btn.stop:hover { background: #222a32; border-color: #3a4349; color: #8b98a5; }
  .mon-tile .mon-btn.resume { color: #69f0ae; border-color: #2a5040; }
  .mon-tile .mon-btn.resume:hover { background: #1a2e24; }
  .mon-tile.paused { opacity: 0.92; border-color: #5a4630; }
  .mon-tile.dead {
    background: #0f1419;
    border-color: #2a3238;
    border-top-color: #3a4349 !important;
    color: #5c6770;
    opacity: 0.55;
    cursor: default;
    animation: none !important;
    box-shadow: none !important;
  }
  .mon-tile.dead:hover { background: #0f1419; border-color: #2a3238; }
  .mon-tile.dead .id { color: #6b7686; }
  .mon-tile.dead .phase { background: #1a2228; color: #6b7686; }
  .mon-tile.dead .page,
  .mon-tile.dead .detail,
  .mon-tile.dead .cap { color: #55606b; }
  .mon-tile.dead .mon-btn.stop,
  .mon-tile.dead .mon-btn.resume { opacity: 0.4; pointer-events: none; }
  .mon-tile.attn {
    border-color: #f4212e;
    border-top-color: #f4212e;
    animation: monBlinkBg 0.9s ease-in-out infinite;
  }
  @keyframes monBlinkBg {
    0%, 100% { background: #15202b; box-shadow: 0 0 0 1px #f4212e55; }
    50% { background: #5a1520; box-shadow: 0 0 10px 1px #f4212eaa; }
  }
  /* Sticky card background after API activity (survives after blink ends). */
  .mon-tile.bg-polling:not(.attn):not(.dead) {
    background: #1c2838;
    border-color: #3d5368;
    border-top-color: #5aa9ff;
  }
  .mon-tile.bg-applicants:not(.attn):not(.dead) {
    background: #2a2440;
    border-color: #6b5b95;
    border-top-color: #a48bec;
  }
  .mon-tile.bg-calendar:not(.attn):not(.dead) {
    background: #163a52;
    border-color: #2a6a94;
    border-top-color: #1d9bf0;
  }
  .mon-tile.bg-fees:not(.attn):not(.dead) {
    background: #3a2a14;
    border-color: #a67c2a;
    border-top-color: #f5a623;
  }
  .mon-tile.bg-timeslot:not(.attn):not(.dead) {
    background: #143528;
    border-color: #2d6a4f;
    border-top-color: #00ba7c;
  }
  .mon-tile.bg-schedule:not(.attn):not(.dead) {
    background: #1a4030;
    border-color: #2f9e6f;
    border-top-color: #69f0ae;
  }
  .mon-tile.bg-fetch-fail:not(.attn):not(.dead),
  .mon-tile.bg-err-401:not(.attn):not(.dead),
  .mon-tile.bg-recovering:not(.attn):not(.dead) {
    background: #3a2418;
    border-color: #a35a2a;
    border-top-color: #ff8a3d;
  }
  .mon-tile.bg-err-401:not(.attn):not(.dead) {
    background: #3a1820;
    border-color: #a33a4a;
    border-top-color: #f4212e;
  }
  /* Short activity flash (API call) — color by endpoint kind. */
  .mon-tile.flash-polling:not(.attn) {
    animation: monFlashPolling 0.4s ease-in-out 1;
  }
  .mon-tile.flash-applicants:not(.attn) {
    animation: monFlashApplicants 0.4s ease-in-out 3;
  }
  .mon-tile.flash-calendar:not(.attn) {
    animation: monFlashCalendar 0.4s ease-in-out 3;
  }
  .mon-tile.flash-fees:not(.attn) {
    animation: monFlashFees 0.4s ease-in-out 3;
  }
  .mon-tile.flash-timeslot:not(.attn) {
    animation: monFlashTimeslot 0.4s ease-in-out 3;
  }
  .mon-tile.flash-schedule:not(.attn) {
    animation: monFlashSchedule 0.4s ease-in-out 3;
  }
  .mon-tile.attn.flash-polling {
    animation: monBlinkBg 0.9s ease-in-out infinite, monApiFlashAttn 0.4s ease-in-out 1;
  }
  .mon-tile.attn.flash-applicants,
  .mon-tile.attn.flash-calendar,
  .mon-tile.attn.flash-fees,
  .mon-tile.attn.flash-timeslot,
  .mon-tile.attn.flash-schedule {
    animation: monBlinkBg 0.9s ease-in-out infinite, monApiFlashAttn 0.4s ease-in-out 3;
  }
  @keyframes monFlashPolling {
    0%, 100% { background: #1c2838; box-shadow: 0 0 0 1px transparent; }
    50% { background: #243044; box-shadow: 0 0 8px 1px #6b8fbc66; border-color: #5a7a9a; }
  }
  @keyframes monFlashApplicants {
    0%, 100% { background: #2a2440; box-shadow: 0 0 0 1px transparent; }
    50% { background: #3a3360; box-shadow: 0 0 8px 1px #a48bec66; border-color: #a48bec; }
  }
  @keyframes monFlashCalendar {
    0%, 100% { background: #163a52; box-shadow: 0 0 0 1px transparent; }
    50% { background: #1a4a6a; box-shadow: 0 0 10px 1px #1d9bf0aa; border-color: #1d9bf0; }
  }
  @keyframes monFlashFees {
    0%, 100% { background: #3a2a14; box-shadow: 0 0 0 1px transparent; }
    50% { background: #4a3818; box-shadow: 0 0 10px 1px #f5a62399; border-color: #f5a623; }
  }
  @keyframes monFlashTimeslot {
    0%, 100% { background: #143528; box-shadow: 0 0 0 1px transparent; }
    50% { background: #1a4532; box-shadow: 0 0 10px 1px #2d6a4f99; border-color: #2d6a4f; }
  }
  @keyframes monFlashSchedule {
    0%, 100% { background: #1a4030; box-shadow: 0 0 0 1px transparent; }
    50% { background: #1f5040; box-shadow: 0 0 10px 1px #00ba7caa; border-color: #00ba7c; }
  }
  @keyframes monApiFlashAttn {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(1.35); }
  }
  @media (prefers-reduced-motion: reduce) {
    .mon-tile.attn { animation: none; background: #3d1520; box-shadow: 0 0 0 1px #f4212e88; }
    .mon-tile.flash-polling,
    .mon-tile.flash-applicants,
    .mon-tile.flash-calendar,
    .mon-tile.flash-fees,
    .mon-tile.flash-timeslot,
    .mon-tile.flash-schedule { animation: none; }
    .mon-tile.bg-polling:not(.attn):not(.dead) { background: #1c2838; border-color: #3d5368; }
    .mon-tile.bg-applicants:not(.attn):not(.dead) { background: #2a2440; border-color: #6b5b95; }
    .mon-tile.bg-calendar:not(.attn):not(.dead) { background: #163a52; border-color: #2a6a94; }
    .mon-tile.bg-fees:not(.attn):not(.dead) { background: #3a2a14; border-color: #a67c2a; }
    .mon-tile.bg-timeslot:not(.attn):not(.dead) { background: #143528; border-color: #2d6a4f; }
    .mon-tile.bg-schedule:not(.attn):not(.dead) { background: #1a4030; border-color: #2f9e6f; }
  }
  .mon-toolbar label { display: inline; margin: 0; }
  .mon-toolbar input { width: auto; margin: 0; }
  .mon-toolbar button { width: auto; padding: 0.15rem 0.4rem; font-size: 0.65rem; min-width: 0; flex: none; }
  .mon-proxy-btn { width: auto; padding: 0.15rem 0.5rem; font-size: 0.65rem; min-width: 0; flex: none; border: 1px solid #38444d; background: #1c2732; color: #c4cdd4; border-radius: 4px; cursor: pointer; }
  .mon-proxy-btn:hover { background: #253341; border-color: #4a5a68; color: #e7e9ea; }
  .mon-proxy-btn.active { background: #1d9bf0; border-color: #1d9bf0; color: #fff; }
  .mon-proxy-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .mon-toast { position: fixed; right: 1rem; bottom: 1rem; background: #1c2732; border: 1px solid #38444d; color: #e7e9ea; padding: 0.6rem 0.85rem; border-radius: 8px; font-size: 0.85rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 50; max-width: 22rem; }
  .mon-toast.show { opacity: 1; }
</style>
<div class="mon-wrap">
  <div class="mon-toolbar" style="margin-bottom:0.5rem;display:flex;gap:0.4rem;align-items:center;justify-content:center;font-size:0.72rem;">
    <label for="monPollInterval">Poll (s)</label>
    <input type="number" id="monPollInterval" min="1" max="600" value="60" step="1" style="width:3.5rem;padding:0.15rem 0.25rem;border:1px solid #38444d;border-radius:4px;background:#15202b;color:#e7e9ea;font-size:0.72rem;" />
    <button type="button" id="monPollIntervalApply">Apply</button>
    <span style="color:#38444d;margin:0 0.1rem;">|</span>
    <label for="monApplicantsJoinStagger">Join stagger (s)</label>
    <input type="number" id="monApplicantsJoinStagger" min="0.1" max="30" value="0.5" step="0.1" style="width:3.5rem;padding:0.15rem 0.25rem;border:1px solid #38444d;border-radius:4px;background:#15202b;color:#e7e9ea;font-size:0.72rem;" />
    <button type="button" id="monApplicantsJoinStaggerApply">Apply</button>
    <span style="color:#38444d;margin:0 0.1rem;">|</span>
    <label for="monCalendarPollingInterval">Calendar re-poll (s)</label>
    <input type="number" id="monCalendarPollingInterval" min="1" max="600" value="60" step="1" style="width:3.5rem;padding:0.15rem 0.25rem;border:1px solid #38444d;border-radius:4px;background:#15202b;color:#e7e9ea;font-size:0.72rem;" />
    <button type="button" id="monCalendarPollingIntervalApply">Apply</button>
    <span style="color:#38444d;margin:0 0.1rem;">|</span>
    <label for="monApologiesInterval">Apologies (s)</label>
    <input type="number" id="monApologiesInterval" min="1" max="120" value="2" style="width:3.5rem;padding:0.15rem 0.25rem;border:1px solid #38444d;border-radius:4px;background:#15202b;color:#e7e9ea;font-size:0.72rem;" />
    <button type="button" id="monApologiesApply">Apply</button>
    <span style="color:#38444d;margin:0 0.1rem;">|</span>
    <label for="monApiDelay">API delay (s)</label>
    <input type="number" id="monApiDelay" min="0" max="60" value="0" step="0.1" style="width:3.5rem;padding:0.15rem 0.25rem;border:1px solid #38444d;border-radius:4px;background:#15202b;color:#e7e9ea;font-size:0.72rem;" />
    <button type="button" id="monApiDelayApply">Apply</button>
    <span style="color:#38444d;margin:0 0.1rem;">|</span>
    <label for="monRepeatedDelay">409 delay (s)</label>
    <input type="number" id="monRepeatedDelay" min="1" max="600" value="35" step="1" style="width:3.5rem;padding:0.15rem 0.25rem;border:1px solid #38444d;border-radius:4px;background:#15202b;color:#e7e9ea;font-size:0.72rem;" />
    <button type="button" id="monRepeatedDelayApply">Apply</button>
  </div>
  <div class="mon-toolbar" style="margin-bottom:0.5rem;display:flex;gap:0.4rem;align-items:center;justify-content:center;font-size:0.72rem;">
    <span style="color:#8b98a5;">Proxy</span>
    <button type="button" class="mon-proxy-btn active" id="monProxyBright" data-provider="brightdata" title="Bright Data (default) — all bots switch on the next API request">Bright Data</button>
    <button type="button" class="mon-proxy-btn" id="monProxyThor" data-provider="thordata" title="Thordata — all bots switch on the next API request">Thordata</button>
    <span id="monProxyHint" style="color:#8b98a5;font-size:0.62rem;"></span>
  </div>
  <div class="mon-grid" id="monGrid"></div>
</div>
<div class="mon-toast" id="monToast"></div>
<script>
(function(){
  if (window.__monitorInit) return;
  var started = false;
  var instances = {};
  var prevAttn = {};
  var lastFlashSeq = {};
  var pendingFlash = {};
  var rafPending = false;
  var warmupUntil = 0;

  var PHASE_COLORS = {
    idle: '#8b98a5', launching: '#5aa9ff', login: '#f5a623', otp: '#f5a623',
    turnstile: '#f5a623', polling: '#1d9bf0', booking: '#a48bec', payment: '#00ba7c',
    recovering: '#ff8a3d', stopped: '#f4212e', already_booked: '#8b98a5',
    needs_attention: '#f4212e', unresponsive: '#6b7686',
    applicants: '#a48bec', calendar: '#1d9bf0', fees: '#f5a623', timeslot: '#00ba7c', schedule: '#69f0ae',
    'fetch fail': '#ff8a3d', '401': '#f4212e'
  };

  function bookingKind(step){
    var s = String(step || '').toLowerCase();
    if (s.indexOf('applicant') >= 0) return 'applicants';
    if (s.indexOf('calendar') >= 0) return 'calendar';
    if (s.indexOf('fee') >= 0) return 'fees';
    if (s.indexOf('timeslot') >= 0 || s.indexOf('time slot') >= 0) return 'timeslot';
    if (s.indexOf('schedule') >= 0) return 'schedule';
    return null;
  }

  function recoverLabel(detail, lastErr){
    var d = String(detail || '') + ' ' + String((lastErr && lastErr.message) || '');
    var low = d.toLowerCase();
    if (low.indexOf('failed to fetch') >= 0 || low.indexOf('fetch fail') >= 0) return 'fetch fail';
    if (/\b401\b/.test(low) || low.indexOf('unauthorized') >= 0) return '401';
    if (/\b403\b/.test(low) || low.indexOf('forbidden') >= 0) return '403';
    if (low.indexOf('cloudflare') >= 0) return 'cloudflare';
    if (/\b429\b/.test(low) || low.indexOf('rate-limit') >= 0 || low.indexOf('rate limit') >= 0) return '429';
    if (low.indexOf('504') >= 0 || low.indexOf('gateway') >= 0) return '504';
    return 'recovering';
  }

  function recoverBgClass(label){
    if (label === 'fetch fail') return 'fetch-fail';
    if (label === '401') return 'err-401';
    return 'recovering';
  }

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

  function isAlreadyBooked(s){
    return !!(s && (s.alreadyBooked || s.phase === 'already_booked'));
  }

  /** Chrome kill/relaunch is expected — do not grey-out / dead-blink the card. */
  function isTransientRecoverPhase(s){
    if (!s) return false;
    var p = s.phase;
    return p === 'recovering' || p === 'launching' || p === 'login' || p === 'turnstile' || p === 'otp';
  }

  function isClosed(s){
    if (!s) return false;
    if (isAlreadyBooked(s)) return true;
    // During hard relogin Chrome is intentionally killed — keep the card stable.
    if (isTransientRecoverPhase(s)) return false;
    if (s.chromeAlive === false) return true;
    if (s.processAlive === false && (s.phase === 'stopped' || s.phase === 'unresponsive')) return true;
    return false;
  }

  /** Errors that need the operator — only while Chrome is still open so they can act. */
  function needsManual(s){
    if (!s) return false;
    if (isAlreadyBooked(s)) return false;
    if (isTransientRecoverPhase(s)) return false;
    if (isClosed(s)) return false;
    // Auto-recovery must not blink — only true operator attention.
    if (s.phase === 'idle') return false;
    if (s.attention) return true;
    if (s.captcha && s.captcha.last === 'waiting') return true;
    return false;
  }

  function tileHtml(s){
    var booked = isAlreadyBooked(s);
    var paused = !!s.pollingPaused;
    var closed = isClosed(s);
    var step = s.bookingStep || '';
    var bKind = (!closed && !booked && s.phase === 'booking') ? (bookingKind(step) || bookingKind(s.detail) || s.cardApiBg) : null;
    var recoverLbl = (!closed && !booked && s.phase === 'recovering') ? recoverLabel(s.detail, s.lastError) : null;
    var color = PHASE_COLORS[booked ? 'already_booked' : (recoverLbl || bKind || s.phase)] || '#55606b';
    var attn = (!closed && needsManual(s)) ? ' attn' : '';
    var cap = s.captcha || {};
    var capBadge = '';
    if (cap.last === 'passed') capBadge = '<span style="color:#00ba7c">captcha ok</span>';
    else if (cap.last === 'failed') capBadge = '<span style="color:#f4212e">captcha FAIL</span>';
    else if (cap.last === 'waiting') capBadge = '<span style="color:#f5a623">captcha wait</span>';
    var capCounts = ' <span style="color:#6b7686">(' + (cap.solved||0) + '/' + (cap.attempts||0) + ')</span>';
    var detail = s.detail || '';
    if (booked) detail = detail || 'already booked';
    else if (recoverLbl) detail = (s.lastError && s.lastError.message) || detail || recoverLbl;
    else if (s.phase === 'booking' && step) detail = step;
    else if (s.lastError && (s.phase === 'stopped' || s.attention || needsManual(s) || closed)) detail = s.lastError.message || detail;
    // Once slot polling has started, prefer the live poll count in this slot.
    if (!closed && !booked && !recoverLbl && s.phase !== 'booking' && (s.phase === 'polling' || (paused && (s.pollCount || 0) > 0))) {
      detail = 'poll #' + (s.pollCount || 0);
      if (s.center) detail += ' · ' + s.center;
    }
    var pageShort =
      isTransientRecoverPhase(s) && s.chromeAlive === false
        ? "relaunching"
        : shortPage(s.page);
    var tip = [];
    if (s.egressIp) tip.push('ip:' + s.egressIp);
    if (s.account) tip.push(s.account);
    if (s.center) tip.push('c:' + s.center);
    tip.push('polls:' + (s.pollCount||0));
    if (s.lastCode) tip.push('code:' + s.lastCode);
    if (paused) tip.push('polling paused');
    if (booked) tip.push('already booked');
    else if (recoverLbl) tip.push(recoverLbl);
    else if (bKind) tip.push(bKind);
    else if (closed) tip.push('bot closed');
    if (s.chromeAlive === false) tip.push('Chrome closed');
    else if (s.chromeAlive === true) tip.push('Chrome up');
    if (s.processAlive === false) tip.push('process dead');
    if (needsManual(s)) tip.push('needs manual action');

    var chromeDot;
    if (isTransientRecoverPhase(s)) {
      // Freeze liveness dot during hard relogin — DevTools probe flaps false→true and was blinking the card.
      chromeDot = '<span style="color:#f5a623" title="Recovering / relaunching">●</span> ';
    } else if (closed) {
      chromeDot = '<span style="color:#55606b" title="' + (booked ? 'Already booked' : 'Bot closed') + '">●</span> ';
    } else if (s.chromeAlive === true) {
      chromeDot = '<span style="color:#00ba7c" title="Chrome DevTools up">●</span> ';
    } else {
      chromeDot = '<span style="color:#55606b" title="Chrome status unknown">●</span> ';
    }

    var pollBtn = (closed || booked)
      ? ''
      : (paused
        ? '<button type="button" class="mon-btn resume" data-action="resume-polling" title="Resume polling (fleet poll-interval stagger)">Resume</button>'
        : '<button type="button" class="mon-btn stop" data-action="pause-polling" title="Stop polling (keep Chrome/session)">Stop</button>');

    var restartBtn = booked
      ? ''
      : '<button type="button" class="mon-btn restart" data-action="restart" title="Clear session, rotate IP, restart Chrome + bot">Restart</button>';

    var phaseLabel = booked ? 'already booked' : (recoverLbl ? recoverLbl : (closed ? 'closed' : (paused ? 'paused' : (bKind || s.phase))));
    if (!closed && !booked && !recoverLbl && !bKind && needsManual(s) && !paused) phaseLabel = s.phase === 'stopped' ? 'stopped' : (s.attention && s.attention.reason) || s.phase;

    var apiBgKind = null;
    if (!closed && !booked) {
      if (recoverLbl) apiBgKind = recoverBgClass(recoverLbl);
      else if (bKind) apiBgKind = bKind;
      else if (s.cardApiBg) apiBgKind = s.cardApiBg;
    }
    var apiBg = apiBgKind ? (' bg-' + apiBgKind) : '';
    var topColor = booked ? '#6b7686' : (recoverLbl ? color : (closed ? '#3a4349' : (needsManual(s) ? '#f4212e' : color)));
    var phaseColor = booked ? '#8b98a5' : (recoverLbl ? color : (closed ? '#6b7686' : (needsManual(s) ? '#f4212e' : color)));

    return '<div class="mon-tile' + attn + apiBg + (paused && !closed ? ' paused' : '') + (closed ? ' dead' : '') + '" data-id="' + s.instanceId + '" title="' + esc(tip.join(' · ') || ('Focus bot #' + s.instanceId)) + '" style="border-top-color:' + topColor + '">' +
      '<span class="phase" style="color:' + phaseColor + '">' + esc(phaseLabel) + '</span>' +
      '<span class="id">' + chromeDot + s.instanceId + '</span>' +
      '<div class="page" title="' + esc(s.page || '') + '">' + (pageShort ? esc(pageShort) : '<span style="color:#55606b">page —</span>') + '</div>' +
      '<div class="detail" title="' + esc(detail) + '">' + esc(detail) + '</div>' +
      '<div class="cap">' + (capBadge || '<span style="color:#6b7686">captcha —</span>') + capCounts + '</div>' +
      '<div class="actions">' +
        pollBtn +
        restartBtn +
      '</div>' +
    '</div>';
  }

  var lastTileHtml = {};

  function render(){
    rafPending = false;
    var list = Object.keys(instances).map(function(k){ return instances[k]; });
    list.sort(function(a,b){ return a.instanceId - b.instanceId; });
    var grid = el('monGrid');
    if (!list.length) {
      grid.innerHTML = '<div class="mon-empty" style="grid-column:1/-1;color:#8b98a5;padding:1.5rem;text-align:center;">No bots yet — Submit &amp; Run from Configure.</div>';
      lastTileHtml = {};
      return;
    }

    // Incremental tile updates — rewriting the whole grid on heartbeats/Chrome probes
    // destroys nodes mid-animation and makes text look like it is blinking.
    var orderChanged = false;
    var existing = grid.querySelectorAll('.mon-tile');
    if (existing.length !== list.length) orderChanged = true;
    else {
      for (var oi = 0; oi < list.length; oi++) {
        if (String(existing[oi].getAttribute('data-id')) !== String(list[oi].instanceId)) {
          orderChanged = true;
          break;
        }
      }
    }

    if (orderChanged) {
      var frag = document.createDocumentFragment();
      var keepFlash = {};
      for (var fi0 = 0; fi0 < existing.length; fi0++) {
        var oldT = existing[fi0];
        var oid = oldT.getAttribute('data-id');
        var flashCls = '';
        var cn = oldT.className || '';
        if (cn.indexOf('flash-') >= 0) {
          var parts = cn.split(/\s+/);
          for (var pi = 0; pi < parts.length; pi++) {
            if (parts[pi].indexOf('flash-') === 0) flashCls = parts[pi];
          }
        }
        if (flashCls) keepFlash[oid] = flashCls;
      }
      lastTileHtml = {};
      for (var j = 0; j < list.length; j++) {
        var s0 = list[j];
        var html0 = tileHtml(s0);
        lastTileHtml[s0.instanceId] = html0;
        var wrap0 = document.createElement('div');
        wrap0.innerHTML = html0;
        var node0 = wrap0.firstElementChild;
        if (node0 && keepFlash[s0.instanceId]) node0.classList.add(keepFlash[s0.instanceId]);
        if (node0) frag.appendChild(node0);
      }
      grid.innerHTML = '';
      grid.appendChild(frag);
    } else {
      for (var j2 = 0; j2 < list.length; j2++) {
        var s1 = list[j2];
        var id1 = s1.instanceId;
        var html1 = tileHtml(s1);
        if (lastTileHtml[id1] === html1) continue;
        lastTileHtml[id1] = html1;
        var tile1 = grid.querySelector('.mon-tile[data-id="' + id1 + '"]');
        if (!tile1) continue;
        // Preserve in-progress activity flash class across content patch.
        var flashKeep = '';
        var cls1 = tile1.className || '';
        if (cls1.indexOf('flash-') >= 0) {
          var parts1 = cls1.split(/\s+/);
          for (var p1 = 0; p1 < parts1.length; p1++) {
            if (parts1[p1].indexOf('flash-') === 0) flashKeep = parts1[p1];
          }
        }
        var wrap1 = document.createElement('div');
        wrap1.innerHTML = html1;
        var next1 = wrap1.firstElementChild;
        if (!next1) continue;
        if (flashKeep) next1.classList.add(flashKeep);
        tile1.replaceWith(next1);
      }
    }

    var flashIds = Object.keys(pendingFlash);
    var FLASH_KINDS = { polling:1, applicants:1, calendar:1, fees:1, timeslot:1, schedule:1 };
    for (var fi = 0; fi < flashIds.length; fi++) {
      var fid = flashIds[fi];
      var flashInfo = pendingFlash[fid];
      delete pendingFlash[fid];
      var stFlash = instances[fid];
      // Skip flash during hard relogin / login — it fights recover UI and looks like blink.
      if (stFlash && isTransientRecoverPhase(stFlash)) continue;
      var tile = grid.querySelector('.mon-tile[data-id="' + fid + '"]');
      if (!tile || tile.classList.contains('dead')) continue;
      tile.classList.remove('flash-polling', 'flash-applicants', 'flash-calendar', 'flash-fees', 'flash-timeslot', 'flash-schedule');
      void tile.offsetWidth;
      var kind = (flashInfo && FLASH_KINDS[flashInfo.kind]) ? flashInfo.kind : 'polling';
      var cls = 'flash-' + kind;
      tile.classList.add(cls);
      (function(t, c){
        function onEnd(ev){
          if (ev && ev.target !== t) return;
          t.classList.remove(c);
          t.removeEventListener('animationend', onEnd);
        }
        t.addEventListener('animationend', onEnd);
      })(tile, cls);
    }
  }

  function scheduleRender(){ if (rafPending) return; rafPending = true; requestAnimationFrame(render); }

  function onStatus(s){
    var wasAttn = prevAttn[s.instanceId];
    var isAttn = needsManual(s);
    if (isAttn && !wasAttn && Date.now() > warmupUntil){
      var reason = (s.attention && s.attention.reason) || s.phase || 'issue';
      toast('Bot #' + s.instanceId + ' needs attention: ' + reason);
      beep();
    }
    prevAttn[s.instanceId] = isAttn;

    var flash = s.apiFlash;
    if (flash && typeof flash.seq === 'number') {
      var prevSeq = lastFlashSeq[s.instanceId] || 0;
      if (flash.seq > prevSeq) {
        lastFlashSeq[s.instanceId] = flash.seq;
        pendingFlash[s.instanceId] = {
          times: flash.times >= 3 ? 3 : 1,
          kind: flash.kind || 'polling'
        };
      }
    }

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
      } else if (action === 'pause-polling') {
        toast('Stopping polling on bot #' + btnId + '…');
        post('pause-polling', { instanceId: btnId }).then(function(r){
          if (r.ok && instances[btnId]) {
            instances[btnId].pollingPaused = true;
            scheduleRender();
          }
          toast('#' + btnId + (r.ok ? ' polling stopped' : ': ' + (r.error || 'stop failed')));
        });
      } else if (action === 'resume-polling') {
        toast('Resuming polling on bot #' + btnId + '…');
        post('resume-polling', { instanceId: btnId }).then(function(r){
          if (r.ok && instances[btnId]) {
            instances[btnId].pollingPaused = false;
            scheduleRender();
          }
          toast('#' + btnId + (r.ok ? ' polling resumed' : ': ' + (r.error || 'resume failed')));
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
    fetch('/api/monitor/control').then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok && d.control) {
        var c = d.control;
        if (c.apologiesIntervalSec != null) {
          var ai = document.getElementById('monApologiesInterval');
          if (ai) ai.value = String(c.apologiesIntervalSec);
        }
        if (c.pollIntervalSec != null) {
          var pi = document.getElementById('monPollInterval');
          if (pi) pi.value = String(c.pollIntervalSec);
        }
        if (c.applicantsJoinStaggerSec != null) {
          var js = document.getElementById('monApplicantsJoinStagger');
          if (js) js.value = String(c.applicantsJoinStaggerSec);
        }
        if (c.calendarPollingIntervalSec != null) {
          var cp = document.getElementById('monCalendarPollingInterval');
          if (cp) cp.value = String(c.calendarPollingIntervalSec);
        }
        if (c.apiDelaySec != null) {
          var ad = document.getElementById('monApiDelay');
          if (ad) ad.value = String(c.apiDelaySec);
        }
        if (c.repeatedDelaySec != null) {
          var rd = document.getElementById('monRepeatedDelay');
          if (rd) rd.value = String(c.repeatedDelaySec);
        }
        setProxyUi(c.proxyProvider || 'brightdata', !!c.thordataReady);
      }
    }).catch(function(){});

    function bindApply(btnId, inputId, action, label, minVal, isFloat) {
      var btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', function(){
        var inp = document.getElementById(inputId);
        var val = isFloat ? parseFloat(String(inp && inp.value)) : parseInt(String(inp && inp.value), 10);
        if (!Number.isFinite(val) || val < minVal) {
          toast(label + ' must be at least ' + minVal + (minVal < 1 ? 's' : ' second(s)'));
          return;
        }
        toast('Applying ' + label + ' ' + val + 's…');
        post(action, { intervalSec: val }).then(function(r){
          toast(r.ok ? label + ' set to ' + val + 's' : (r.error || 'apply failed'));
        });
      });
    }
    bindApply('monApologiesApply', 'monApologiesInterval', 'apologies-interval', 'Apologies interval', 1, false);
    bindApply('monPollIntervalApply', 'monPollInterval', 'poll-interval', 'Poll interval', 1, false);
    bindApply('monApplicantsJoinStaggerApply', 'monApplicantsJoinStagger', 'applicants-join-stagger', 'Join stagger', 0.1, true);
    bindApply('monCalendarPollingIntervalApply', 'monCalendarPollingInterval', 'calendar-polling-interval', 'Calendar re-poll', 1, false);
    bindApply('monApiDelayApply', 'monApiDelay', 'api-delay', 'API delay', 0, true);
    bindApply('monRepeatedDelayApply', 'monRepeatedDelay', 'repeated-delay', '409 delay', 1, false);

    function setProxyUi(provider, thordataReady) {
      var bright = document.getElementById('monProxyBright');
      var thor = document.getElementById('monProxyThor');
      var hint = document.getElementById('monProxyHint');
      var isThor = provider === 'thordata';
      if (bright) bright.classList.toggle('active', !isThor);
      if (thor) thor.classList.toggle('active', isThor);
      if (hint) {
        hint.textContent = thordataReady ? '' : 'Thordata credentials still placeholders in .env';
      }
    }
    window.__syncMonitorProxyUi = setProxyUi;

    function bindProxy(btnId) {
      var btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', function(){
        var provider = btn.getAttribute('data-provider');
        if (!provider) return;
        var label = provider === 'thordata' ? 'Thordata' : 'Bright Data';
        toast('Switching all bots to ' + label + '…');
        post('proxy-provider', { provider: provider }).then(function(r){
          if (r.ok) {
            toast('All bots now use ' + label + ' from the next API request');
            fetch('/api/monitor/control').then(function(res){ return res.json(); }).then(function(d){
              if (d && d.ok && d.control) {
                setProxyUi(d.control.proxyProvider || provider, !!d.control.thordataReady);
                if (window.__syncConfigureProxyUi) {
                  window.__syncConfigureProxyUi(d.control.proxyProvider || provider, !!d.control.thordataReady);
                }
              }
            }).catch(function(){});
          } else {
            toast(r.error || 'proxy switch failed');
          }
        });
      });
    }
    bindProxy('monProxyBright');
    bindProxy('monProxyThor');
    fetch('/api/monitor/snapshot').then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok && Array.isArray(d.instances)){
        for (var i = 0; i < d.instances.length; i++){
          var s = d.instances[i];
          instances[s.instanceId] = s;
          prevAttn[s.instanceId] = needsManual(s);
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
