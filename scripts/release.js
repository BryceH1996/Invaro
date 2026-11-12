// Releases a new version of Invoicer:
//   1. checks this version hasn't been released already (git tag v<version>)
//   2. builds the installer (electron-builder)
//   3. publishes it to <data folder>/updates so installed copies offer the update
//   4. commits any changes, tags v<version> and pushes both to GitHub
//
//   npm run release -- "Short note about what changed"
//   npm run release -- --no-build "note"   (reuse the installer already in dist/)
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const notes = args.filter(a => a !== '--no-build').join(' ').trim();
const tag = `v${pkg.version}`;

const git = (cmd, opts = {}) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', ...opts }).trim();
function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }

// ---- 1. guard: never release the same version twice ----
if (git(`tag --list ${tag}`)) {
  fail(`${tag} has already been released. Bump "version" in package.json first.`);
}
const branch = git('rev-parse --abbrev-ref HEAD');
if (branch !== 'main') fail(`Releases are made from the main branch (you're on "${branch}").`);

// ---- 2. build ----
if (!noBuild) {
  console.log(`Building Invoicer ${pkg.version}…`);
  const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'], { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('Build failed. Nothing was published or pushed.');
}

// ---- 3. publish to the updates folder ----
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
const src = path.join(root, 'dist', file);
if (!fs.existsSync(src)) fail(`Missing ${src}. Run without --no-build.`);

const dir = path.join(dataDir(), 'updates');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.exe') && f !== file) fs.unlinkSync(path.join(dir, f)); // keep only the newest
fs.copyFileSync(src, path.join(dir, file));
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
  version: pkg.version, file, notes, releasedAt: new Date().toISOString(),
}, null, 2));
console.log(`✔ Published Invoicer ${pkg.version} to ${dir}`);

// ---- 4. commit, tag and push to GitHub ----
git('add -A');
const staged = git('diff --cached --name-only');
if (staged) {
  const msgFile = path.join(root, '.git', 'RELEASE_MSG');
  fs.writeFileSync(msgFile, `Release ${tag}${notes ? ': ' + notes : ''}\n`);
  git(`commit -q -F "${msgFile}"`);
  fs.unlinkSync(msgFile);
  console.log(`✔ Committed: ${staged.split('\n').length} changed file(s)`);
}
git(`tag -a ${tag} -m "Invoicer ${pkg.version}${notes ? ' - ' + notes.replace(/"/g, "'") : ''}"`);
console.log(`✔ Tagged ${tag}`);

try {
  git('push -q origin main', { stdio: ['ignore', 'pipe', 'pipe'] });
  git(`push -q origin ${tag}`, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`✔ Pushed main and ${tag} to GitHub`);
} catch (e) {
  console.warn(`\n⚠ The update is published, but pushing to GitHub failed:\n${(e.stderr || e.message).toString().trim()}`);
  console.warn(`  When you're back online, run:  git push origin main ${tag}`);
}
