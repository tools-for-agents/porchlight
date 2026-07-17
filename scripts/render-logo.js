// Render docs/logo.svg → a PNG at any size, using the Electron we already depend on.
// (No rsvg/imagemagick on this machine, and adding a toolchain to draw one icon is worse
// than borrowing the browser that is already in the room.)
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const size = Number(process.env.SIZE || 1024);
const out = process.env.OUT || path.join(__dirname, '..', 'build', `icon-${size}.png`);
const svg = fs.readFileSync(path.join(__dirname, '..', 'docs', 'logo.svg'), 'utf8');

app.whenReady().then(async () => {
  // 🔑 capturePage() BAKES THE WINDOW'S BACKGROUND IN. A BrowserWindow is white by
  // default, so a transparent SVG came out with white behind it and the Dock showed a
  // white card instead of a squircle. transparent + a fully transparent backgroundColor
  // is what keeps the alpha.
  const win = new BrowserWindow({
    width: size, height: size, show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><style>
      html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
      svg{width:${size}px;height:${size}px;display:block}
    </style>${svg}`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out);
  app.exit(0);
});
