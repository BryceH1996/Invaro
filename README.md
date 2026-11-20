<p align="center"><img src="docs/icon.png" width="96" alt="Invaro logo"></p>

<h1 align="center">Invaro</h1>

<p align="center"><strong>Simple invoices for the clients you bill every month.</strong></p>

<p align="center">
  <a href="https://github.com/BryceH1996/Invaro/releases/latest"><strong>⬇ Download for Windows or Mac</strong></a> ·
  <a href="https://bryceh1996.github.io/Invaro/">Website</a> ·
  <a href="https://bryceh1996.github.io/Invaro/privacy.html">Privacy</a>
</p>

Invaro is a small, free app for Windows and Mac. Pick a client, fill in your days or hours, and save a clean PDF invoice. Invaro remembers the rest. Use it on your own, or share the work with your partner or team. There are no ads, no tracking and no analytics.

Invaro was called **Invoicer** up to version 1.14. If you used it then, it carries on with your existing folders (the ones still named `Invoicer`), so nothing moves.

## Install

**Windows**
1. Download `Invaro-Setup-<version>.exe` from the [latest release](https://github.com/BryceH1996/Invaro/releases/latest).
2. Run it. Invaro isn't code-signed yet, so your browser may say the file "isn't commonly downloaded" (choose **Keep**), and Windows may show "Windows protected your PC" (click **More info → Run anyway**). See [Is it safe?](#is-it-safe)

To remove it, go to **Settings → Apps → Installed apps → Invaro → Uninstall**.

**Mac** (Apple silicon and Intel, macOS 12 Monterey or later)
1. Download `Invaro-<version>-mac.dmg` from the [latest release](https://github.com/BryceH1996/Invaro/releases/latest), open it, and drag **Invaro** into **Applications**.
2. Open Invaro from Applications. Because it isn't signed by Apple, macOS first says it can't check the app for malware. Click **Done**, then open **System Settings → Privacy & Security**, scroll down to "Invaro was blocked…", click **Open Anyway**, and confirm. You only need to do this once.

To remove it, turn off any reminders on the **Notifications** tab first, then drag Invaro from Applications to the Bin.

**Then**, fill in **My details**, add a client under **Clients**, and make your first invoice. Invaro keeps itself up to date after that. Removing the app keeps your invoices and data.

![Making an invoice in Invaro, with the live PDF preview on the right](docs/screenshot-invoice.png)

## What it does

### Invoicing
- **Saved clients:** each client keeps its address, payment terms, currency (GBP, USD, EUR or ZAR), hourly rate, daily rate and day-off reduction.
- **Priced for you:** add lines as days, hours, days off, items (a quantity at a price each) or fixed amounts, and the total is worked out from the client's rates. Set a tax rate for a client to add a VAT line.
- **As many lines as you need:** long descriptions wrap, and a long invoice carries on over more pages with the table header repeated and "Page 1 of 3" at the bottom. When every line is hours, the Qty column says Hours.
- **Show or hide rates:** untick **Show rates on the PDF** to leave your hourly, daily and unit rates off an invoice or quote, showing just the quantities and amounts. New ones start the way you last chose.
- **Discounts:** click **%** beside any line to take a percentage or a whole amount off it. The saving shows as its own line under it, and comes off before the total and VAT.
- **Discount on the whole invoice:** tick **Discount on the whole invoice**, then type a percentage and a reason (e.g. "Loyal customer"). It shows as the last line, with the amount it was taken from, before VAT.
- **Live preview:** the PDF updates as you type. Zoom with − / +, or Ctrl (⌘ on a Mac) with + / − / 0.
- **A folder per client:** **Save invoice** puts the PDF straight into that client's folder, e.g. `Documents/Invaro/Northwind Design Co/Northwind Design Co. Invoice - November 2026 - Alex Morgan.pdf`.
- **Numbering:** invoice numbers carry on from the last one you saved, and never clash in a team.
- **Quotes:** switch **New invoice** to **Quote** for a quote with its own numbering and a "valid until" date, then turn it into an invoice with one click. Itemise it with **Item** lines (a quantity at a price each).
- **Quotes paid in steps:** in **History**, click **Payments** on a quote and tick off each line as the client pays for it. Invaro shows what's been paid and what's still outstanding.
- **History:** every saved invoice, ready to open, save again, or copy into a new one.
- **Edit before you send:** click **Edit** on any saved invoice or quote to change values or add lines, then **Save changes**. It keeps its number, file and paid status, and whatever you were drafting comes back afterwards.

### Your look
- **Nine designs:** Classic, Wave, Minimal, Bold, Elegant, Sidebar, Corporate, Mono and Geometric, in any colour, with a second colour on two-tone designs to match your branding, plus your company logo.
- **Business details:** your company name, VAT, tax and registration numbers, plus each client's VAT number.
- **EFT details:** print your bank, account holder, account number, account type, branch code, SWIFT code and payment reference at the bottom of every invoice, with your bank's logo. Pick a South African bank to fill in its branch and SWIFT codes.

### Staying on top
- **Reminders:** pick a day each month for each client on the **Notifications** tab. Your computer then reminds you once a day until you've invoiced them, even when Invaro is closed.
- **Paid or not:** mark invoices paid in **History**. Unpaid invoices past their due date show as overdue, and you're reminded the day after, then weekly.
- **Reports:** see what you've invoiced, been paid, are owed and charged in VAT for a tax year (March to February) or calendar year, by client and by month, and export it to a spreadsheet.

### Working together
- **Teams:** create a team and invite your partner or colleagues by email. Everyone works on the same clients, invoices and business details, kept in sync within seconds. Whoever creates the team is its admin and gives everyone a role:
  - **Admin:** everything, including who's in the team.
  - **Accountant:** sees all clients, invoices and reports, and marks invoices paid.
  - **Team member:** makes invoices and quotes and sees only their own, without changing rates, paid status or the business details.

  The database enforces the roles, not just the app. If two people change the same thing, the later change wins and the other version is kept in a `conflicts` folder.
- **Personal items:** tick **Personal** on a client or an invoice, before or after you share, to keep it out of the team.
- **Share your invoices:** with Google Drive connected, type your partner's or company's email to give them view or edit access to your backup folder. They see each invoice as soon as it's saved.

### Backups and sync
- **Backups:** every saved invoice is also copied to Google Drive (My Drive or a shared drive), OneDrive, or any other folder you choose, into a folder of your choice with a folder per client (**My details → Invoice backup**). **Connect Google Drive** to back up without Google Drive for desktop.
- **Sign in with Google (optional):** back up your clients, settings, logos and invoice history to your own private account, and use them on your other computers. Accounts are invite-only for now. If you're not approved yet, Invaro tells you how to ask for access when you sign in.

![The Notifications tab, with a reminder day for each client](docs/screenshot-notifications.png)

## Is it safe?

Each [release](https://github.com/BryceH1996/Invaro/releases) lists a **SHA-256 checksum** for every download. To check that your download is exactly the published file, run one of these in the folder you saved it to, and compare the result:

```powershell
Get-FileHash .\Invaro-Setup-<version>.exe     # Windows, in PowerShell
```
```bash
shasum -a 256 Invaro-<version>-mac.dmg       # Mac, in Terminal
```

Releases also link a **VirusTotal** scan of the Windows installer and the Mac disk image, and all of the source code is in this repository.

**What Invaro does on your computer:**
- **Your data:** it saves your data as plain files on your computer (see [Your data](#your-data)). There's no tracking or analytics, and nothing leaves your computer unless you sign in, join a team or set up a backup.
- **Your account (only if you sign in):** your clients, settings, logos and invoice history are synced to your own account, which only you can read. Your PDFs aren't uploaded. **My details → Account & sync → Delete my cloud data** removes it. See the [privacy policy](https://bryceh1996.github.io/Invaro/privacy.html).
- **Your team (only if you join one):** the team's clients, invoices and business details are shared with its members, and each person sees only what their role allows. Personal clients and invoices stay on your computer.
- **Reminders:** while at least one client has a reminder or an invoice is unpaid, it schedules a quick check once a day at 9am. On Windows that's a Task Scheduler task called "Invaro reminders"; on a Mac it's a launch agent called `local.invoicer.reminders`, which also checks when you log in. Turning off your last reminder removes it, and on Windows so does uninstalling.
- **Updates:** it checks this repository's releases when it starts and every 30 minutes. It only downloads and installs an update when you click **Restart & update**.
- **Backups:** saved invoices are copied into `Invaro Backups` (or a folder you pick) inside your `My Drive` folder (Google Drive for desktop) or your `OneDrive` folder, or into any folder you pick, and the sync app uploads them as usual. Without Google Drive for desktop you can instead **Connect Google Drive**: Invaro then uploads each saved PDF to that folder in My Drive or a shared drive you pick, and nothing else. **Disconnect Google Drive** removes its access.

## Your data

Everything is in the `Invaro` folder in your Documents (or `Invoicer`, if you've used it since before the rename). **My details → Data** shows the exact folder, and lets you move it:

| File | What's in it |
| --- | --- |
| `clients.json` | Your clients and their rates |
| `settings.json` | Your details and invoice settings |
| `invoices.json` | The history of saved invoices |
| `logo.png` (or `.jpg`, …) | Your logo, if you've added one |
| `bank-logo.png` (or `.jpg`, …) | Your bank's logo, if you've added one |
| `<Client>/*.pdf` | Your invoices, one folder per client |

Invaro's app folder also remembers which data folder you use, when each reminder last showed, and (if you sign in) your sign-in, encrypted by the operating system. It's `%APPDATA%\Invaro` on Windows and `~/Library/Application Support/Invaro` on a Mac (or `Invoicer` in place of `Invaro`, for installs from before the rename). To back everything up, or to use the same data on another computer, move the data folder into OneDrive, iCloud Drive or similar.

---

## For developers

Built with [Electron](https://www.electronjs.org/) and [jsPDF](https://github.com/parallax/jsPDF).

```bash
npm install
npm start          # run it
npm run dist       # build dist/Invaro Setup <version>.exe (on Windows)
npm run dist:mac   # build the Mac .dmg and .zip (on a Mac)
```

To release, bump `version` in `package.json`, then run `npm run release -- "What changed"` on Windows. The script:
1. builds the Windows installer
2. copies it into `<data folder>/updates`
3. commits, tags `v<version>`, and pushes to the `origin` and `public` remotes
4. creates the GitHub Release on the public repo (`updateRepo` in `package.json`) with the installer attached. That starts `.github/workflows/mac.yml`, which builds the Mac version on a GitHub Mac, smoke-tests it (`scripts/mac-smoke-test.js`) and attaches the `.dmg` and `.zip`
5. waits for the Mac files, then adds every file's SHA-256 to the release notes, plus VirusTotal results if `VIRUSTOTAL_API_KEY` is set

It refuses to reuse a version number. Use `--no-build` to reuse the installer in `dist/`, or `--github-only` to redo just the GitHub Release.

| Path | What it is |
| --- | --- |
| `main.js` | Main process: window, storage, saving, backups, reminders, updates |
| `preload.js` | Bridge between the UI and the main process |
| `app/` | UI (`index.html`, `renderer.js`, `style.css`) and the PDF layout (`pdf.js`) |
| `cloud.js` | Sign-in with Google (via Supabase) and cloud sync |
| `team.js`, `supabase/teams.sql` | Teams: shared data synced record by record, and its database |
| `supabase/signup-allowlist.sql` | Invite-only sign-up: the approved list and its auth hook |
| `gdrive.js` | Connect Google Drive: uploads backups and shares the backup folder |
| `docs/` | The website (GitHub Pages): homepage and privacy policy, plus README screenshots (invented sample data) |
| `scripts/release.js` | The release script |
| `.github/workflows/mac.yml`, `scripts/mac-smoke-test.js` | The Mac build and its smoke test |
| `.github/workflows/supabase-keepalive.yml` | Keeps the Supabase project awake with a read every 3 days |
| `build/` | App icon; `installer.nsh` removes the reminder task on uninstall |
| `prototype/invoicer.html` | The original single-file browser version |

### Cloud sync (Supabase)

`package.json` → `cloud` holds the Supabase project URL and its **publishable** key. That key is meant to be public; row level security keeps each user's data private. The database needs:

```sql
create table public.documents (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null check (name in ('clients', 'settings', 'invoices')),
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);
alter table public.documents enable row level security;
create policy "Users manage their own documents" on public.documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Lets "Delete my cloud data" remove the whole account, not just its rows.
create or replace function public.delete_own_account() returns void
  language sql security definer set search_path = '' as $$ delete from auth.users where id = auth.uid(); $$;
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
```

Google is the sign-in provider, and `http://127.0.0.1:47823/auth/callback` must be in **Authentication → URL Configuration → Redirect URLs**.

Sign-up is invite-only: [`supabase/signup-allowlist.sql`](supabase/signup-allowlist.sql) adds an approved-emails list and a **Before User Created** auth hook (Authentication → Auth Hooks → `public.hook_before_user_created`) that turns everyone else away.

Teams also need the tables, row level security and functions in [`supabase/teams.sql`](supabase/teams.sql). Run that file once in the SQL editor; it replaces `delete_own_account` above with a version that knows about teams.

© All rights reserved. The code is public so you can see what the app does. It isn't licensed for reuse.
