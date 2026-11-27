// Releases a new version of Invaro:
//   1. checks this version hasn't been released already (git tag v<version>), and runs the tests
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

// Same lookup as the app: chosen folder from config.json, else Documents\Invaro
// (or the Invoicer folders, for installs from before the rename to Invaro).
// Documents may be redirected to OneDrive, so ask Windows where it really is.
function dataDir() {
  if (process.env.INVOICER_DATA) return process.env.INVOICER_DATA;
  const appData = name => path.join(process.env.APPDATA, name);
  try {
    const profile = fs.existsSync(appData('Invoicer')) ? appData('Invoicer') : appData('Invaro');
    const cfg = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
    if (cfg.dataDir) return cfg.dataDir;
  } catch (e) {}
  const docs = execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'MyDocuments\')"').toString().trim();
  const old = path.join(docs, 'Invoicer'), fresh = path.join(docs, 'Invaro');
  return fs.existsSync(old) && !fs.existsSync(fresh) ? old : fresh;
}

function releaseLocally() {
  // ---- 1. guard: never release the same version twice ----
  if (git(`tag --list ${tag}`)) fail(`${tag} has already been released. Bump "version" in package.json first.`);
  const branch = git('rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') fail(`Releases are made from the main branch (you're on "${branch}").`);

  // ---- tests: totals, numbering, stock, the Dashboard and imports (test/) ----
  console.log('Running the tests…');
  const t = spawnSync('npm', ['test', '--silent'], { cwd: root, stdio: 'inherit', shell: true });
  if (t.status !== 0) fail('Tests failed. Nothing was built, published or pushed.');

  // ---- 2. build ----
  // The Google Drive OAuth client is kept out of git (see SYNC.md); without it, Connect Google Drive is hidden.
  if (!noBuild && !fs.existsSync(path.join(root, 'gdrive.config.json'))) fail('Missing gdrive.config.json (the Google Drive client). See SYNC.md.');
  if (!noBuild) {
    console.log(`Building Invaro ${pkg.version}…`);
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
  console.log(`✔ Published Invaro ${pkg.version} to ${dir}`);

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
  git(`tag -a ${tag} -m "Invaro ${pkg.version}${notes ? ' - ' + notes.replace(/"/g, "'") : ''}"`);
  console.log(`✔ Tagged ${tag}`);
  try {
    git('push -q origin main', { stdio: ['ignore', 'pipe', 'pipe'] });
    git(`push -q origin ${tag}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`✔ Pushed main and ${tag} to the private repo`);
    publishPublic();
    console.log(`✔ Published main and ${tag} to the public repo, without: ${(pkg.privateFiles || []).join(', ') || 'nothing'}`);
    return true;
  } catch (e) {
    console.warn(`\n⚠ The update is published, but pushing to GitHub failed:\n${(e.stderr || e.message).toString().trim()}`);
    console.warn(`  When you're back online, run:  git push origin main ${tag} && git push public main ${tag}`);
    console.warn(`  and then:                      npm run release -- --github-only`);
    return false;
  }
}

// ---- the public copy ----
// The public repo isn't a mirror: it gets main's files minus those listed in package.json
// "privateFiles" (notes that should stay in the private repo), as one new commit on top of the
// public repo's own history, and the release tag on that commit.
function publishPublic() {
  const quiet = { stdio: ['ignore', 'pipe', 'pipe'] };
  git('fetch -q public main', quiet);
  const parent = git('rev-parse refs/remotes/public/main');
  const index = path.join(root, '.git', 'public-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git('read-tree main', { env });
    for (const f of pkg.privateFiles || []) git(`rm -q -r --cached --ignore-unmatch -- "${f}"`, { env });
    var tree = git('write-tree', { env });
  } finally { fs.rmSync(index, { force: true }); }
  let commit = parent;
  if (tree !== git(`rev-parse "${parent}^{tree}"`)) {
    const message = git('log -1 --format=%B main');
    commit = execSync(`git commit-tree ${tree} -p ${parent} -F -`, { cwd: root, input: message, encoding: 'utf8' }).trim();
    git(`push -q public ${commit}:refs/heads/main`, quiet);
  }
  // On a rerun (--github-only) the tag is already there: leave it on the released commit.
  if (!git(`ls-remote public refs/tags/${tag}`)) git(`push -q public ${commit}:refs/tags/${tag}`, quiet);
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
    const full = url.startsWith('http') ? url : `https://api.github.com/repos/${REPO}${url}`;
    const send = to => fetch(to, {
      ...opts, redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'invaro-release', ...(opts.headers || {}) },
    });
    // GitHub sometimes answers with a 307/308 to another address; send the same request there.
    let res = await send(full);
    for (let hops = 0; [301, 302, 307, 308].includes(res.status) && hops < 3; hops++) {
      const to = res.headers.get('location') || ((await res.json().catch(() => ({}))).url);
      if (!to) break;
      res = await send(new URL(to, full).toString());
    }
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 404) return null;
    return res.status === 204 ? {} : res.json();
  };
  let release = await gh(`/releases/tags/${tag}`);
  if (!release) {
    release = await gh('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      tag_name: tag, name: `Invaro ${pkg.version}`, body: notes || `Invaro ${pkg.version}`,
    }) });
    console.log(`✔ Created GitHub release ${tag}`);
  }
  const assetName = file.replace(/ /g, '-'); // GitHub turns spaces into dots, so pick the name ourselves
  const bytes = fs.readFileSync(src);
  if (release.assets.some(a => a.name === assetName)) {
    console.log(`✔ ${assetName} is already attached to ${tag}`);
  } else {
    console.log(`Uploading ${assetName} (${(bytes.length / 1048576).toFixed(1)} MB)…`);
    // The release's own upload_url (minus its "{?name,label}" template), as GitHub recommends.
    const uploadUrl = (release.upload_url || `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets`).replace(/\{.*\}$/, '');
    await gh(`${uploadUrl}?name=${encodeURIComponent(assetName)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    console.log(`✔ Attached the installer to ${tag}`);
  }

  // The Mac version is built by GitHub Actions (.github/workflows/mac.yml) once the release exists.
  const macNames = ['dmg', 'zip'].map(ext => `${pkg.build.productName}-${pkg.version}-mac.${ext}`);
  release = await waitForMac(gh, release, macNames);

  // Release notes: what changed, then each download with its SHA-256 and VirusTotal result.
  const crypto = require('crypto');
  const files = [{ name: assetName, bytes, url: (release.assets.find(a => a.name === assetName) || {}).browser_download_url }];
  for (const name of macNames) {
    const a = release.assets.find(x => x.name === name);
    if (!a) continue;
    const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'invaro-release' } });
    if (!res.ok) { console.warn(`⚠ Couldn't download ${name} to check it (${res.status}).`); continue; }
    files.push({ name, bytes: Buffer.from(await res.arrayBuffer()), url: a.browser_download_url });
  }
  for (const f of files) f.sha256 = crypto.createHash('sha256').update(f.bytes).digest('hex');
  // Scan what people download by hand: the Windows installer and the Mac disk image.
  for (const f of files.filter(f => !f.name.endsWith('.zip'))) {
    f.scan = await virusTotal(f.bytes, f.sha256, f.name).catch(e => { console.warn(`⚠ VirusTotal check of ${f.name} failed: ${e.message}`); return null; });
  }
  const mb = f => `${(f.bytes.length / 1048576).toFixed(1)} MB`;
  const win = files[0], dmg = files.find(f => f.name.endsWith('.dmg'));
  const intro = (release.body || '').split('\n\n### Download')[0].trim() || notes || `Invaro ${pkg.version}`;
  const scanned = files.filter(f => f.scan);
  const body = [
    intro, '', '### Download',
    `- **Windows:** [${win.name}](${win.url}) (${mb(win)}). Windows may warn that it's from an unknown publisher, because the app isn't code-signed yet: click **More info → Run anyway**.`,
    ...(dmg ? [`- **Mac** (Apple silicon and Intel): [${dmg.name}](${dmg.url}) (${mb(dmg)}). Open it and drag Invaro into Applications. The first time you open it, macOS says it can't check the app for malware, because it isn't signed by Apple: open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.`] : []),
    '', '### Checksums (SHA-256)', '', '| File | SHA-256 |', '| --- | --- |',
    ...files.map(f => `| ${f.name} | \`${f.sha256}\` |`),
    '', 'To check a download, run `Get-FileHash .\\<file>` in PowerShell on Windows, or `shasum -a 256 <file>` in Terminal on a Mac, and compare it with the table. (The `.zip` is what installed Macs use to update themselves.)',
    ...(scanned.length ? ['', '### VirusTotal', ...scanned.map(f => `- ${f.name}: ${f.scan.flagged} of ${f.scan.engines} security vendors flagged it. [See the report](${f.scan.url})`)] : []),
  ].join('\n');
  if (body !== release.body) {
    await gh(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
    console.log(`✔ Release notes updated (${files.length} file${files.length === 1 ? '' : 's'}, SHA-256${scanned.length ? ', VirusTotal' : ''})`);
  }
  console.log(`  ${release.html_url}`);
}

// Waits (up to 45 minutes) for the Mac build to attach its files, and returns the refreshed release.
// If no build has started for this tag (e.g. a --github-only rerun), it starts one.
async function waitForMac(gh, release, names) {
  const has = r => names.every(n => r.assets.some(a => a.name === n));
  if (has(release)) return release;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const started = Date.now();
  let dispatched = false;
  process.stdout.write('Waiting for the Mac build on GitHub');
  while (Date.now() - started < 45 * 60 * 1000) {
    await sleep(30000); process.stdout.write('.');
    release = await gh(`/releases/${release.id}`);
    if (has(release)) { console.log(''); console.log('✔ Mac build attached'); return release; }
    const runs = ((await gh('/actions/workflows/mac.yml/runs?per_page=20')) || {}).workflow_runs || [];
    // A skipped run never built anything, so it doesn't count; a build started by hand runs on main.
    const run = runs.find(r => r.conclusion !== 'skipped' && (r.head_branch === tag || (r.display_title || '').includes(tag)
      || (dispatched && r.event === 'workflow_dispatch' && Date.parse(r.created_at) >= started)));
    if (!run && !dispatched && Date.now() - started > 90 * 1000) {
      await gh('/actions/workflows/mac.yml/dispatches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main', inputs: { tag } }) });
      dispatched = true;
    }
    if (run && run.status === 'completed' && run.conclusion !== 'success') {
      console.log('');
      console.warn(`⚠ The Mac build failed: ${run.html_url}\n  Fix it, then rerun with:  npm run release -- --github-only`);
      return release;
    }
  }
  console.log('');
  console.warn('⚠ The Mac build is taking too long. Rerun later with:  npm run release -- --github-only');
  return release;
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
  } else {
    // Finish a release whose public publish failed (does nothing if it's already there).
    try { publishPublic(); console.log(`✔ Public repo has main and ${tag}`); }
    catch (e) { fail(`Couldn't publish to the public repo:\n${(e.stderr || e.message).toString().trim()}`); }
  }
  try { await publishGithubRelease(); }
  catch (e) {
    console.warn(`\n⚠ Couldn't publish the GitHub release: ${e.message}`);
    console.warn('  Try again with:  npm run release -- --github-only');
  }
})();
