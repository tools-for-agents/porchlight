'use strict';

/* Edge neural TTS — the same wss endpoint the Edge browser's "Read Aloud" uses. No key,
 * no account, just the network; the voices (tr-TR-EmelNeural and friends) are the
 * realistic ones, which is why this is jarvis's first-choice mouth and piper only the
 * offline fallback. Unofficial, so it WILL break some day — every failure here must
 * resolve into "use piper instead", never into silence.
 *
 * Protocol, as the browser speaks it: connect with a TrustedClientToken plus a
 * Sec-MS-GEC proof (sha256 of windows-epoch ticks rounded to 5 minutes + the token —
 * their anti-scripting speed bump), send one speech.config, one SSML request, then
 * collect binary frames whose header says Path:audio until a turn.end text frame.
 */

const crypto = require('node:crypto');

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
// The server checks this for FRESHNESS: a stale build string is a plain 403 with nothing
// else wrong. When jarvis's voice one day goes piper-only, bump this to whatever the
// python edge-tts package currently ships as CHROMIUM_FULL_VERSION.
const CHROMIUM = '143.0.3650.75';
const MAJOR = CHROMIUM.split('.')[0];

function gecToken() {
  const WIN_EPOCH = 11644473600n;                                   // 1601 → 1970, in seconds
  let ticks = (BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH) * 10_000_000n;
  ticks -= ticks % 3_000_000_000n;                                  // round down to 5min of 100ns ticks
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED}`).digest('hex').toUpperCase();
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Prosody values travel from voice.json into SSML — accept only the shapes the
// service understands ("-5%", "+3Hz") so a typo degrades to neutral, not to XML.
const prosodyOk = (v, unit) => (typeof v === 'string' && new RegExp(`^[+-]?\\d+${unit}$`).test(v) ? v : null);

/**
 * @param {{rate?:string, pitch?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<Buffer>} mp3 bytes (audio-24khz-48kbitrate-mono-mp3)
 */
function synth(text, voice, opts = {}) {
  const timeoutMs = opts.timeoutMs || 12_000;
  const rate = prosodyOk(opts.rate, '%') || '+0%';
  const pitch = prosodyOk(opts.pitch, 'Hz') || '+0Hz';
  return new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = require('ws'); } catch (e) { return reject(new Error(`ws not installed: ${e.message}`)); }
    const reqId = crypto.randomUUID().replace(/-/g, '');
    const url = `${WSS}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gecToken()}&Sec-MS-GEC-Version=1-${CHROMIUM}&ConnectionId=${reqId}`;
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const chunks = [];
    let settled = false;
    const finish = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve(buf);
    };
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } finish(new Error('edge-tts timeout')); }, timeoutMs);

    ws.on('error', (e) => finish(e));
    ws.on('close', () => finish(new Error('edge-tts closed early')));
    ws.on('open', () => {
      const stamp = new Date().toString();
      ws.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          } } } }));
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
        + `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        if (buf.toString('utf8', 2, 2 + headerLen).includes('Path:audio')) {
          chunks.push(buf.subarray(2 + headerLen));
        }
      } else if (String(data).includes('Path:turn.end')) {
        chunks.length ? finish(null, Buffer.concat(chunks)) : finish(new Error('edge-tts: turn ended with no audio'));
      }
    });
  });
}

module.exports = { synth };
