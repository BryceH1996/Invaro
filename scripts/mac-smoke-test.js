// Runs on the macOS build machine after the app is built (see .github/workflows/mac.yml).
// Starts the real app and checks the Mac-specific parts work:
//   1. it opens and keeps running (no crash on start-up)
//   2. a reminder check with a client reminder set creates the launchd job, then exits
//   3. with the reminder turned off, the next check removes the job again
// Usage: node scripts/mac-smoke-test.js path/to/Invoicer.app
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const appPath = process.argv[2];
const exe = path.join(appPath, 'Contents', 'MacOS', 'Invoicer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoicer-smoke-'));
const data = path.join(tmp, 'data'), profile = path.join(tmp, 'profile');
fs.mkdirSync(data); fs.mkdirSync(profile);
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'local.invoicer.reminders-test.plist');

const env = {
  ...process.env,
  INVOICER_DATA: data, INVOICER_PROFILE: profile,
  INVOICER_TASK_NAME: 'smoke-test',        // uses the "-test" launchd label
  INVOICER_NOW: '2026-01-02T10:00:00',     // reminders are for the 28th, so nothing is due
  INVOICER_MYDRIVE: path.join(tmp, 'no-drive'),
};
const writeClients = reminderDay => fs.writeFileSync(path.join(data, 'clients.json'), JSON.stringify([
  { id: 'c1', company: 'Smoke Test Ltd', currency: 'USD', dueDays: 14, hourlyRate: 50, dailyRate: 400, items: [], reminderDay },
]));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ me: { name: 'Test' }, prefix: 'INV-', nextNumber: 1, pageSize: 'a4' }));
fs.writeFileSync(path.join(data, 'invoices.json'), '[]');

function runApp(args, { killAfter } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    let killed = false;
    const t = setTimeout(() => { killed = true; p.kill(); }, killAfter || 60000);
    p.on('exit', code => { clearTimeout(t); resolve({ code, killed, out }); });
    p.on('error', reject);
  });
}
const fail = msg => { console.error('✖ ' + msg); process.exit(1); };

(async () => {
  // 1. normal start: should still be running after 15 seconds
  writeClients('');
  const start = await runApp([], { killAfter: 15000 });
  if (!start.killed) fail(`the app exited on its own (code ${start.code}):\n${start.out}`);
  console.log('✔ starts and keeps running');

  // 2. scheduled check with a reminder set: creates the launch agent, then exits by itself
  writeClients('28');
  const on = await runApp(['--check-reminders']);
  if (on.killed || on.code !== 0) fail(`the reminder check didn't exit cleanly (code ${on.code}):\n${on.out}`);
  if (!fs.existsSync(plist)) fail('the launchd job was not created:\n' + on.out);
  const xml = fs.readFileSync(plist, 'utf8');
  if (!xml.includes(exe) || !xml.includes('--check-reminders')) fail('the launchd job points somewhere else:\n' + xml);
  console.log('✔ reminder check sets up the launchd job');

  // 3. reminders off: the next check removes it again
  writeClients('');
  const off = await runApp(['--check-reminders']);
  if (off.killed || off.code !== 0) fail(`the second check didn't exit cleanly (code ${off.code}):\n${off.out}`);
  if (fs.existsSync(plist)) fail('the launchd job was not removed');
  console.log('✔ turning reminders off removes it');
})();
