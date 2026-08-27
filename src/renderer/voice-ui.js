'use strict';

/* The orb — jarvis's face in the footer — plus the transcript toast and the three-phrase
 * enrollment dialog. This file renders STATE; it decides nothing. Click toggles the ears,
 * right-click arms one wake-word-free utterance, and every colour the orb turns is an
 * event main sent. Loads after app.js; talks to it only through window.hangar.voice. */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const orb = $('#orb'), orbLabel = $('#orb .orb-label'), toast = $('#voice-toast');
  const dlg = $('#enroll'), steps = [...document.querySelectorAll('#enroll .phrase')];

  let phase = 'off';
  let enrolled = false;

  const LABEL = {
    off: 'jarvis', boot: 'waking…', listening: 'listening', hearing: 'hearing',
    thinking: 'thinking…', speaking: 'speaking', enroll: 'learning you',
  };

  function paint() {
    orb.dataset.phase = phase;
    orbLabel.textContent = LABEL[phase] || 'jarvis';
    orb.classList.toggle('needs-enroll', phase !== 'off' && !enrolled);
    orb.title = phase === 'off'
      ? 'jarvis — talk to your agents (⌘⇧J)'
      : enrolled ? 'jarvis is listening for your voice — click to stop · right-click to talk without the wake word'
                 : 'jarvis hears, but obeys nobody until it learns your voice — click the amber dot';
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
    paint();
  }

  orb.addEventListener('click', async () => applyStatus(await window.hangar.voice.toggle()));
  orb.addEventListener('contextmenu', (e) => { e.preventDefault(); window.hangar.voice.ptt(); });

  // ── enrollment ─────────────────────────────────────────────────────────────
  async function openEnroll() {
    if (dlg.open) return;
    // Enrollment needs ears: if jarvis is off, this click is also the on-switch.
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
  $('#voice-enroll-open')?.addEventListener('click', openEnroll);

  // ── events from main ───────────────────────────────────────────────────────
  window.hangar.voice.onEvent((ev) => {
    switch (ev.t) {
      case 'status': applyStatus(ev); break;
      case 'phase': phase = ev.phase; paint(); break;
      case 'heard':
        if (ev.acted) showToast(`“${ev.text}”`);
        break;
      case 'reject':
        orb.classList.add('rejected');
        setTimeout(() => orb.classList.remove('rejected'), 900);
        break;
      case 'say': showToast(`jarvis: ${ev.text}`); break;
      case 'ptt': showToast('go ahead — no wake word needed'); break;
      case 'toast': showToast(ev.text); break;
      case 'need':
        if (ev.what === 'models') showToast('voice models are not downloaded — run: npm run voice-models', true);
        if (ev.what === 'mic') showToast('hangar has no microphone permission — System Settings → Privacy → Microphone');
        if (ev.what === 'profile') { showToast('jarvis heard a voice, but has not learned yours yet'); openEnroll(); }
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
        showToast('voiceprint saved — jarvis now answers to you alone');
        paint();
        break;
    }
  });

  (async () => { paint(); applyStatus(await window.hangar.voice.status()); })();
})();
