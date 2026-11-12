// Releases a new version of Invoicer:
//   1. checks this version hasn't been released already (git tag v<version>)
//   2. builds the installer (electron-builder)
//   3. publishes it to <data folder>/updates so installed copies offer the update
//   4. commits any changes, tags v<version> and pushes both to GitHub: the private repo
//      (remote "origin") and the public copy (remote "public")
//   5. creates a GitHub Release for v<version> on the public repo (package.json "updateRepo")
//      with the installer attached. Anyone can download it there, and every copy updates from it.
//      The release notes get the installer's SHA-256 and, with VIRUSTOTAL_API_KEY set, its VirusTotal result
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
const REPO = process.env.RELEASE_REPO || pkg.updateRepo; // "owner/name"

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
    git('push -q public main', { stdio: ['ignore', 'pipe', 'pipe'] });
    git(`push -q public ${tag}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`✔ Pushed main and ${tag} to GitHub (private and public repos)`);
    return true;
  } catch (e) {
    console.warn(`\n⚠ The update is published, but pushing to GitHub failed:\n${(e.stderr || e.message).toString().trim()}`);
    console.warn(`  When you're back online, run:  git push origin main ${tag} && git push public main ${tag}`);
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
  const bytes = fs.readFileSync(src);
  if (release.assets.some(a => a.name === assetName)) {
    console.log(`✔ ${assetName} is already attached to ${tag}`);
  } else {
    console.log(`Uploading ${assetName} (${(bytes.length / 1048576).toFixed(1)} MB)…`);
    await gh(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    console.log(`✔ Attached the installer to ${tag}`);
  }

  // Release notes: what changed, then the download's SHA-256 and its VirusTotal result.
  const sha256 = require('crypto').createHash('sha256').update(bytes).digest('hex');
  const scan = await virusTotal(bytes, sha256, assetName).catch(e => { console.warn(`⚠ VirusTotal check failed: ${e.message}`); return null; });
  const intro = (release.body || '').split('\n\n### Download')[0].trim() || notes || `Invoicer ${pkg.version}`;
  const body = [
    intro, '', '### Download',
    `**${assetName}** (${(bytes.length / 1048576).toFixed(1)} MB). Windows may warn that it's from an unknown publisher, because the app isn't code-signed yet: click **More info → Run anyway**.`,
    '', `SHA-256: \`${sha256}\``,
    '', 'To check your download matches, run this in PowerShell in the folder you saved it to, and compare:',
    '```powershell', `Get-FileHash .\\${assetName}`, '```',
    ...(scan ? ['', `VirusTotal: ${scan.flagged} of ${scan.engines} security vendors flagged this file. [See the report](${scan.url})`] : []),
  ].join('\n');
  if (body !== release.body) {
    await gh(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
    console.log(`✔ Release notes updated (SHA-256${scan ? ', VirusTotal' : ''})`);
  }
  console.log(`  ${release.html_url}`);
}

// ---- VirusTotal scan of the installer ----
// Needs a free VirusTotal API key in VIRUSTOTAL_API_KEY. Uploads the installer unless
// VirusTotal already knows it, waits for the scan (usually a few minutes), and returns
// { flagged, engines, url }, or null when there's no key.
async function virusTotal(bytes, sha256, name) {
  const key = process.env.VIRUSTOTAL_API_KEY;
  if (!key) { console.warn('⚠ VIRUSTOTAL_API_KEY isn\'t set, so the installer wasn\'t scanned on VirusTotal.'); return null; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vt = async (url, opts = {}) => {
    const res = await fetch(url.startsWith('http') ? url : `https://www.virustotal.com/api/v3${url}`, { ...opts, headers: { 'x-apikey': key, ...(opts.headers || {}) } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`VirusTotal ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  let report = await vt(`/files/${sha256}`);
  if (!report || !report.data.attributes.last_analysis_date) {
    console.log(`Uploading ${name} to VirusTotal…`);
    const { data: uploadUrl } = await vt('/files/upload_url'); // needed for files over 32 MB
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    const { data: analysis } = await vt(uploadUrl, { method: 'POST', body: form });
    process.stdout.write('Waiting for the VirusTotal scan');
    for (let i = 0; i < 40; i++) { // free API: 4 requests a minute, so check every 30 seconds (20 minutes max)
      await sleep(30000); process.stdout.write('.');
      const a = await vt(`/analyses/${analysis.id}`);
      if (a && a.data.attributes.status === 'completed') break;
    }
    console.log('');
    report = await vt(`/files/${sha256}`);
  }
  const s = (report && report.data.attributes.last_analysis_stats) || {};
  if (!report || !s.undetected && !s.harmless && !s.malicious) throw new Error('the scan hasn\'t finished yet. Run the release again with --github-only later.');
  const flagged = (s.malicious || 0) + (s.suspicious || 0);
  const engines = flagged + (s.undetected || 0) + (s.harmless || 0);
  const result = { flagged, engines, url: `https://www.virustotal.com/gui/file/${sha256}` };
  console.log(`${flagged ? '⚠' : '✔'} VirusTotal: ${flagged} of ${engines} vendors flagged it. ${result.url}`);
  return result;
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
