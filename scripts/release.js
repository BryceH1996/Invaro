// Publishes the freshly built installer to <data folder>/updates so installed
// copies of Invoicer offer it as an update.
//   npm run release -- "Short note about what changed"
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkg = require('../package.json');
const notes = process.argv.slice(2).join(' ').trim();

// Same lookup as the app: chosen folder from config.json, else Documents\Invoicer
// (Documents may be redirected to OneDrive, so ask Windows where it really is).
function dataDir() {
  if (process.env.INVOICER_DATA) return process.env.INVOICER_DATA;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Invoicer', 'config.json'), 'utf8'));
    if (cfg.dataDir) return cfg.dataDir;
  } catch (e) {}
  const docs = execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'MyDocuments\')"').toString().trim();
  return path.join(docs, 'Invoicer');
}

const file = `${pkg.build.productName} Setup ${pkg.version}.exe`;
const src = path.join(__dirname, '..', 'dist', file);
if (!fs.existsSync(src)) { console.error(`Missing ${src}. Run the build first.`); process.exit(1); }

const dir = path.join(dataDir(), 'updates');
fs.mkdirSync(dir, { recursive: true });

// Keep only the newest installer in the updates folder.
for (const f of fs.readdirSync(dir)) if (f.endsWith('.exe') && f !== file) fs.unlinkSync(path.join(dir, f));

fs.copyFileSync(src, path.join(dir, file));
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
  version: pkg.version, file, notes, releasedAt: new Date().toISOString(),
}, null, 2));
console.log(`Published Invoicer ${pkg.version} to ${dir}`);
