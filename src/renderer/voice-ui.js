'use strict';

/* mira's face. Three surfaces, one truth:
 *
 *   the ORB in the footer   — a canvas ring that draws the REAL microphone signal
 *                             (window.hangarMic.level, not a looping gif of one):
 *                             breathing green at rest, a circular equalizer while she
 *                             hears you, an amber comet while the brain runs, expanding
 *                             rings while she speaks, one red flare for a stranger.
 *   the COMM strip          — what was said, both ways: your words land at once, hers
 *                             type themselves out; fades when the exchange is over.
 *   the tile flash          — an order lands in a bay, the bay flares in its own hue.
 *
 * This file renders STATE; it decides nothing. Every colour is an event main sent.
 * Click toggles the ears, right-click arms one wake-word-free utterance.
 * HANGAR_VOICE_DEMO=hearing|thinking|speaking|enroll poses it for the screenshot rig. */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const orb = $('#orb'), orbLabel = $('#orb .orb-label'), toast = $('#voice-toast');
  const comm = $('#comm'), commYou = $('#comm .you .txt'), commMira = $('#comm .mira .txt');
  const dlg = $('#enroll'), steps = [...document.querySelectorAll('#enroll .phrase')];

  let phase = 'off';
  let enrolled = false;
  let rejectedAt = 0;
  let lastActivity = 0;
  let demoLevel = 0;     // stands in for the mic when she speaks (afplay's output is not ours to tap)

  const LABEL = {
    off: 'mira', boot: 'waking…', listening: 'listening', hearing: 'hearing',
    thinking: 'thinking…', speaking: 'speaking', enroll: 'learning you',
  };

  function paintChrome() {
    orb.dataset.phase = phase;
    orbLabel.textContent = LABEL[phase] || 'mira';
    orb.classList.toggle('needs-enroll', phase !== 'off' && phase !== 'enroll' && !enrolled);
    orb.title = phase === 'off'
      ? 'mira — talk to your agents (⌘⇧J)'
      : enrolled ? 'mira is listening for your voice — click to stop · right-click to talk without the wake word'
                 : 'mira hears, but obeys nobody until she learns your voice — click the amber ring';
  }

  // ── the orb, drawn from the signal ────────────────────────────────────────
  const CY = { accent: '#4ade80', cyan: '#5eead4', amber: '#fbbf24', red: '#f87171', muted: '#7d9188' };
  const BARS = 28;
  const hist = new Float32Array(BARS);   // the last BARS level samples, a ring
  let hi = 0, lastSample = 0;

  function setupCanvas(canvas) {
    // Size from the width= attribute, NOT clientWidth: the comm strip boots [hidden],
    // where clientWidth is 0, and a 0×0 canvas draws exactly nothing forever.
    const dpr = window.devicePixelRatio || 1;
    const s = canvas.width;
    canvas.style.width = `${s}px`; canvas.style.height = `${s}px`;
    canvas.width = s * dpr; canvas.height = s * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, s };
  }
  const surfaces = [setupCanvas($('#orb-c')), setupCanvas($('#comm-c'))];

  function drawOrb(ctx, s, t) {
    ctx.clearRect(0, 0, s, s);
    const c = s / 2, r = c - 4;
    const lvl = phase === 'speaking' ? demoLevel : (window.hangarMic.live ? window.hangarMic.level : 0);
    ctx.lineCap = 'round';

    const ring = (radius, color, alpha, width = 1.5, glow = 0) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.shadowColor = color;
      ctx.shadowBlur = glow;
      ctx.beginPath();
      ctx.arc(c, c, Math.max(1, radius), 0, Math.PI * 2);
      ctx.stroke();
    };
    const dot = (radius, color, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = radius * 2;
      ctx.beginPath();
      ctx.arc(c, c, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.fill();
    };

    switch (phase) {
      case 'off':
        ring(r * 0.8, CY.muted, 0.45, 1);
        dot(1.5, CY.muted, 0.6);
        break;
      case 'boot':
        ring(r * 0.8, CY.muted, 0.35 + 0.3 * Math.sin(t * 4), 1.5, 4);
        break;
      case 'listening': {
        // Mira the star: brightens and dims. The radius leans into the room's sound.
        const breathe = 0.55 + 0.35 * Math.sin(t * 2.1);
        ring(r * (0.82 + lvl * 0.1), CY.accent, breathe, 1.5, 7);
        dot(1.5 + lvl * 3.5, CY.accent, 0.9);
        break;
      }
      case 'enroll': {
        const breathe = 0.5 + 0.4 * Math.sin(t * 3);
        ring(r * (0.8 + lvl * 0.14), CY.cyan, breathe, 1.5, 8);
        dot(1.5 + lvl * 4, CY.cyan, 0.9);
        break;
      }
      case 'hearing': {
        // a circular equalizer: each spoke is one real level sample, newest at 12 o'clock
        ctx.shadowColor = CY.cyan; ctx.shadowBlur = 5;
        ctx.strokeStyle = CY.cyan; ctx.lineWidth = Math.max(1.2, s / 30);
        for (let i = 0; i < BARS; i++) {
          const v = hist[(hi + i) % BARS];
          const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
          const r0 = r * 0.55, r1 = r0 + 1.5 + v * r * 0.42;
          ctx.globalAlpha = 0.35 + v * 0.65;
          ctx.beginPath();
          ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
          ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
          ctx.stroke();
        }
        dot(1.5 + lvl * 3, CY.cyan, 0.9);
        break;
      }
      case 'thinking': {
        ring(r * 0.8, CY.amber, 0.16, 1.5);
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = CY.amber; ctx.lineWidth = 2.2;
        ctx.shadowColor = CY.amber; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(c, c, r * 0.8, t * 2.8, t * 2.8 + Math.PI * 0.45); ctx.stroke();
        ctx.globalAlpha = 0.5; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(c, c, r * 0.56, -t * 1.9, -t * 1.9 + Math.PI * 0.3); ctx.stroke();
        break;
      }
      case 'speaking': {
        for (let k = 0; k < 2; k++) {
          const p = (t * 0.75 + k * 0.5) % 1;
          ring(r * (0.3 + p * 0.7), CY.accent, (1 - p) * 0.75, 1.5, 6);
        }
        dot(2 + demoLevel * 3.5, CY.accent, 0.95);
        break;
      }
    }
    // a stranger spoke: one red flare over whatever else is true
    const flare = (performance.now() - rejectedAt) / 900;
    if (flare < 1) ring(r * (0.8 + flare * 0.2), CY.red, (1 - flare) * 0.9, 2, 8);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  let demoMode = null;
  (function loop() {
    const now = performance.now(), t = now / 1000;
    if (now - lastSample > 33) {          // ~30Hz into the equalizer's ring buffer
      lastSample = now;
      hist[hi = (hi + 1) % BARS] = demoMode
        ? 0.15 + 0.65 * Math.abs(Math.sin(t * 5.1 + hi * 0.9))   // posed for the camera
        : (window.hangarMic.live ? window.hangarMic.level : 0);
    }
    // her "voice level" while speaking: smoothed wander, since afplay's samples are not ours
    demoLevel += ((0.35 + 0.3 * Math.sin(t * 7.3) + 0.25 * Math.sin(t * 13.7)) - demoLevel) * 0.2;
    for (const { ctx, s } of surfaces) drawOrb(ctx, s, t);
    if (!comm.hidden && now - lastActivity > 9000 && (phase === 'listening' || phase === 'off')) comm.hidden = true;
    requestAnimationFrame(loop);
  })();

  // ── the comm strip ────────────────────────────────────────────────────────
  let typeTimer = 0, thinkTimer = 0;
  const activity = () => { lastActivity = performance.now(); comm.hidden = false; };

  function youSaid(text) {
    activity();
    commYou.textContent = text;
    commMira.textContent = '';
  }
  function miraThinks() {
    activity();
    clearInterval(thinkTimer);
    let n = 0;
    commMira.classList.add('dim');
    thinkTimer = setInterval(() => { commMira.textContent = '·'.repeat(1 + (n++ % 3)); }, 350);
  }
  function miraSays(text) {
    activity();
    clearInterval(thinkTimer);
    clearInterval(typeTimer);
    commMira.classList.remove('dim');
    commMira.textContent = '';
    let i = 0;
    typeTimer = setInterval(() => {         // she types at speaking pace; done = done
      commMira.textContent = text.slice(0, ++i);
      activity();
      if (i >= text.length) clearInterval(typeTimer);
    }, 24);
  }

  let toastTimer = 0;
  function showToast(text, sticky = false) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  async function applyStatus(st) {
    enrolled = !!st.enrolled;
    phase = st.phase || (st.enabled ? 'listening' : 'off');
    if (st.enabled && !window.hangarMic.live) {
      const ok = await window.hangarMic.start();
      if (!ok) {
        showToast('microphone unavailable — check System Settings → Privacy → Microphone');
        window.hangar.voice.toggle();   // roll the switch back rather than pretend to listen
        return;
      }
    }
    if (!st.enabled && window.hangarMic.live) window.hangarMic.stop();
    paintChrome();
  }

  orb.addEventListener('click', async () => applyStatus(await window.hangar.voice.toggle()));
  orb.addEventListener('contextmenu', (e) => { e.preventDefault(); window.hangar.voice.ptt(); });

  // ── enrollment: three sentences → a voiceprint ────────────────────────────
  async function openEnroll() {
    if (dlg.open) return;
    // Enrollment needs ears: if mira is off, this click is also the on-switch.
    if (!window.hangarMic.live) {
      const st = await window.hangar.voice.toggle();
      if (!st.enabled) return;   // no mic permission / no models — the toast already said so
      await applyStatus(st);
      if (!window.hangarMic.live) return;
    }
    steps.forEach((p, i) => p.classList.toggle('current', i === 0));
    steps.forEach((p) => p.classList.remove('done'));
    const cap = $('#enroll .capture');
    cap.disabled = false;
    cap.textContent = 'record line 1';
    dlg.showModal();
    window.hangar.voice.enrollStart();
  }
  $('#enroll .capture').addEventListener('click', () => {
    $('#enroll .capture').disabled = true;
    $('#enroll .capture').textContent = 'listening — read the highlighted line…';
    window.hangar.voice.enrollCapture();
  });
  $('#enroll .cancel').addEventListener('click', () => { window.hangar.voice.enrollCancel(); dlg.close(); });

  // the meter in the dialog: proof her ears are on, drawn from the same real level
  (function meterLoop() {
    if (dlg.open) {
      const m = $('#enroll-meter');
      const dpr = window.devicePixelRatio || 1;
      if (m.width !== m.clientWidth * dpr) { m.width = m.clientWidth * dpr; m.height = m.clientHeight * dpr; }
      const g = m.getContext('2d');
      g.clearRect(0, 0, m.width, m.height);
      g.fillStyle = CY.cyan;
      g.globalAlpha = 0.9;
      g.fillRect(0, 0, m.width * Math.min(1, window.hangarMic.level * 1.4), m.height);
    }
    requestAnimationFrame(meterLoop);
  })();

  // ── events from main ──────────────────────────────────────────────────────
  window.hangar.voice.onEvent((ev) => {
    switch (ev.t) {
      case 'status': applyStatus(ev); break;
      case 'phase':
        phase = ev.phase;
        if (phase === 'thinking') miraThinks();
        paintChrome();
        break;
      case 'heard':
        if (ev.acted) youSaid(ev.text);
        break;
      case 'reject': rejectedAt = performance.now(); break;
      case 'say':
        miraSays(ev.text);
        (ev.bays || []).forEach((id) => window.hangarBayFlash?.(id));
        break;
      case 'ptt': showToast('go ahead — no wake word needed'); break;
      case 'toast': showToast(ev.text); break;
      case 'need':
        if (ev.what === 'models') showToast('voice models are not downloaded — run: npm run voice-models', true);
        if (ev.what === 'mic') showToast('hangar has no microphone permission — System Settings → Privacy → Microphone');
        if (ev.what === 'profile') { showToast('mira heard a voice, but has not learned yours yet'); openEnroll(); }
        break;
      case 'enroll-got':
        steps[ev.n - 1]?.classList.add('done');
        steps[ev.n - 1]?.classList.remove('current');
        steps[ev.n]?.classList.add('current');
        $('#enroll .capture').disabled = false;
        $('#enroll .capture').textContent = ev.n < 3 ? `record line ${ev.n + 1}` : 'finishing…';
        break;
      case 'enroll-done':
        enrolled = true;
        dlg.close();
        showToast('voiceprint saved — mira now answers to you alone');
        paintChrome();
        break;
    }
  });

  // ── the pose for the screenshot rig ───────────────────────────────────────
  function demo(mode) {
    demoMode = mode;
    enrolled = true;
    // 'start': drive a real fleet action through main's armed test hook — the grid must
    // grow a live session, exactly as if the brain had ordered it.
    if (mode === 'start' && window.hangar.voice.demoStart) {
      phase = 'listening';
      youSaid('Mira, yeni bir proje başlat.');
      miraSays('Açıyorum efendim — yeni session hazır.');
      lastActivity = Infinity;
      window.hangar.voice.testAct({ actions: [{ type: 'start', path: window.hangar.voice.demoStart, create: true, text: 'Reply with exactly: MIRA WAS HERE' }] });
      paintChrome();
      return;
    }
    phase = mode === 'enroll' ? 'enroll' : mode;
    if (mode === 'enroll') { dlg.showModal(); steps[0].classList.add('done'); steps[0].classList.remove('current'); steps[1].classList.add('current'); }
    else {
      youSaid('Mira, bay üç nasıl gidiyor?');
      if (mode === 'thinking') miraThinks();
      else miraSays('Bay üç testleri geçti; ajan şimdi ses arayüzünü parlatıyor efendim.');
      lastActivity = Infinity;   // hold the strip open for the camera
      for (let i = 0; i < BARS; i++) hist[i] = Math.abs(Math.sin(i * 1.7)) * 0.8;
    }
    paintChrome();
  }

  (async () => {
    paintChrome();
    if (window.hangar.voice.demo) demo(window.hangar.voice.demo);
    else applyStatus(await window.hangar.voice.status());
  })();
})();
