'use strict';

// The wake word, as whisper actually hears it. "Jarvis" spoken by a Turkish speaker and
// transcribed by a multilingual model comes back as jarvis, Jarvis!, carvis, Çarvis,
// jarvıs, cervis... — an exact string match would make the wake word work one time in
// three. So: fold case and diacritics, take the first few tokens, and accept anything
// within edit distance 2 of the wake word. Pure functions, tested in test/voice.test.js.

// Turkish 'ı' upper-cases to 'I' and 'i' to 'İ'; toLowerCase('İ') is 'i̇' (i + combining
// dot). Normalize + strip combining marks first, so turkish text folds predictably.
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Does this transcript start with one of the wake words?
 * Returns { command } (the text after the wake word, '' if it was alone) or null.
 * Only the first TWO tokens are searched ("Hey Mira" still works): a call comes first;
 * "bay üçte mira kelimesi geçiyor" is a sentence ABOUT mira, not a call to it.
 *
 * Fuzz is earned, not given: any fuzzy match REQUIRES the token to start like the wake
 * word (whisper mangles the tail of a name, almost never its first phoneme — measured:
 * "Hüma" came back "Yuma"/"Buma", which is why hüma-style names were rejected, and why
 * a start-letter miss is a hard no). So "çarvis"→carvis passes for jarvis (the one j↔c
 * alias), "bira" can never summon mira, and "servis" — a real Turkish word two edits
 * from jarvis — commands nobody's agents. Short names get distance 1, long ones 2.
 */
function matchWake(transcript, wake = 'jarvis') {
  const cleaned = fold(transcript).replace(/[^\p{L}\p{N}\s']/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const targets = (Array.isArray(wake) ? wake : [wake]).map(fold);
  for (let i = 0; i < Math.min(2, tokens.length); i++) {
    // "mira'ya" / "miracım" — a suffixed call is still a call
    const tok = tokens[i].replace(/'.*$/, '');
    for (const target of targets) {
      const trimmed = tok.length > target.length + 2 ? tok.slice(0, target.length + 1) : tok;
      const sameStart = trimmed[0] === target[0] || (target[0] === 'j' && trimmed[0] === 'c');
      if (!sameStart) continue;
      const maxDist = target.length >= 5 ? 2 : 1;
      if (levenshtein(trimmed, target) <= maxDist) {
        // The command is the ORIGINAL text after this token — whisper's own casing and
        // punctuation carry meaning for the brain ("Mira, dur." vs "mira durum").
        const rest = originalAfterToken(transcript, i);
        return { command: rest.trim() };
      }
    }
  }
  return null;
}

// Walk the original transcript to the end of the i-th word, return what follows.
function originalAfterToken(original, i) {
  const re = /[\p{L}\p{N}']+/gu;
  let m, k = -1;
  while ((m = re.exec(original)) !== null) {
    k++;
    if (k === i) return original.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '');
  }
  return '';
}

// A cheap "which language is this" for picking the TTS voice when the brain forgot to
// say. Turkish-specific letters or a couple of very common Turkish words → tr.
function guessLang(text) {
  const s = String(text || '');
  if (/[çğıöşüÇĞİÖŞÜ]/.test(s)) return 'tr';
  if (/\b(bir|ve|için|değil|evet|hayır|tamam|çalışıyor|bitti|var|yok)\b/i.test(fold(s))) return 'tr';
  return 'en';
}

module.exports = { matchWake, fold, levenshtein, guessLang };
