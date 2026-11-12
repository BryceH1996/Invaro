// Releases a new version of Invoicer:
//   1. checks this version hasn't been released already (git tag v<version>)
//   2. builds the installer (electron-builder)
//   3. publishes it to <data folder>/updates so installed copies offer the update
//   4. commits any changes, tags v<version> and pushes both to GitHub
//   5. creates a GitHub Release for v<version> with the installer attached; collaborators
//      download it there, and their copies update from it (see "Updates" in the README)
//
//   npm run release -- "Short note about what changed"
//   npm run release -- --no-build "note"      (reuse the installer already in dist/)
//   npm run release -- --github-only "note"   (only step 5, for a version that's already tagged)
//
// Step 5 uses $GITHUB_TOKEN if set, otherwise the GitHub login git already uses (Git Credential Manager).
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const githubOnly = args.includes('--github-only');
const notes = args.filter(a => !a.startsWith('--')).join(' ').trim();
const tag = `v${pkg.version}`;
const REPO = pkg.updateRepo; // "owner/name", in package.json

const git = (cmd, opts = {}) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', ...opts }).trim();
function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }

const file = `${pkg.build.productName} Setup ${pkg.version}.exe`;
const src = path.join(root, 'dist', file);

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

function releaseLocally() {
  // ---- 1. guard: never release the same version twice ----
  if (git(`tag --list ${tag}`)) fail(`${tag} has already been released. Bump "version" in package.json first.`);
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') fail(`Releases are made from the main branch (you're on "${branch}").`);

  // ---- 2. build ----
  if (!noBuild) {
    console.log(`Building Invoicer ${pkg.version}…`);
    const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'], { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) fail('Build failed. Nothing was published or pushed.');
  }

  // ---- 3. publish to the updates folder ----
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
    return true;
  } catch (e) {
    console.warn(`\n⚠ The update is published, but pushing to GitHub failed:\n${(e.stderr || e.message).toString().trim()}`);
    console.warn(`  When you're back online, run:  git push origin main ${tag}`);
    console.warn(`  and then:                      npm run release -- --github-only`);
    return false;
  }
}

// ---- 5. GitHub Release with the installer ----
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const owner = REPO.split('/')[0];
  const out = execSync('git credential fill', { cwd: root, input: `protocol=https\nhost=github.com\nusername=${owner}\n\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('No GitHub login found. Set GITHUB_TOKEN, or push once with git so it remembers you.');
  return m[1].trim();
}
async function publishGithubRelease() {
  if (!fs.existsSync(src)) fail(`Missing ${src}. Build it first (npm run dist).`);
  const token = githubToken();
  const gh = async (url, opts = {}) => {
    const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${REPO}${url}`, {
      ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'invoicer-release', ...(opts.headers || {}) },
    });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 404 ? null : res.json();
  };
  let release = await gh(`/releases/tags/${tag}`);
  if (!release) {
    release = await gh('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      tag_name: tag, name: `Invoicer ${pkg.version}`, body: notes || `Invoicer ${pkg.version}`,
    }) });
    console.log(`✔ Created GitHub release ${tag}`);
  }
  const assetName = file.replace(/ /g, '-'); // GitHub turns spaces into dots, so pick the name ourselves
  if (release.assets.some(a => a.name === assetName)) {
    console.log(`✔ ${assetName} is already attached to ${tag}`);
  } else {
    const bytes = fs.readFileSync(src);
    console.log(`Uploading ${assetName} (${(bytes.length / 1048576).toFixed(1)} MB)…`);
    await gh(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    console.log(`✔ Attached the installer to ${tag}`);
  }
  console.log(`  ${release.html_url}`);
}

(async () => {
  if (!githubOnly) {
    if (!releaseLocally()) return;
  } else if (!git(`tag --list ${tag}`)) {
    fail(`${tag} isn't tagged yet. Run a normal release first.`);
  }
  try { await publishGithubRelease(); }
  catch (e) {
    console.warn(`\n⚠ Couldn't publish the GitHub release: ${e.message}`);
    console.warn('  Try again with:  npm run release -- --github-only');
  }
})();
