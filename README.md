# Invoicer

A small, no-fuss app for Windows and Mac, for freelancers who invoice the same clients every month. Pick a client, fill in your days or hours, and save a clean PDF invoice. Invoicer remembers the rest.

## Install

**[⬇ Download the latest version](https://github.com/BryceH1996/invoicer/releases/latest)**

**Windows**
1. Download `Invoicer-Setup-<version>.exe` from the [latest release](https://github.com/BryceH1996/invoicer/releases/latest).
2. Run it. Invoicer isn't code-signed yet, so your browser may say the file "isn't commonly downloaded" (choose **Keep**), and Windows may show "Windows protected your PC" (click **More info → Run anyway**). See [Is it safe?](#is-it-safe)

To remove it, go to **Settings → Apps → Installed apps → Invoicer → Uninstall**.

**Mac** (Apple silicon and Intel, macOS 12 Monterey or later)
1. Download `Invoicer-<version>-mac.dmg` from the [latest release](https://github.com/BryceH1996/invoicer/releases/latest), open it, and drag **Invoicer** into **Applications**.
2. Open Invoicer from Applications. Because it isn't signed by Apple, macOS first says it can't check the app for malware. Click **Done**, then open **System Settings → Privacy & Security**, scroll down to "Invoicer was blocked…", click **Open Anyway**, and confirm. You only need to do this once.

To remove it, turn off any reminders on the **Notifications** tab first, then drag Invoicer from Applications to the Bin.

**Then**, fill in **My details**, add a client under **Clients**, and make your first invoice. Invoicer keeps itself up to date after that. Removing the app keeps your invoices and data.

![Making an invoice in Invoicer, with the live PDF preview on the right](docs/screenshot-invoice.png)

## What it does

- **Clients:** each client keeps its address, payment terms, currency (GBP, USD, EUR or ZAR), hourly rate, daily rate and day-off reduction.
- **Pricing:** add lines as days, hours, days off or fixed amounts, and the total is worked out from the client's rates.
- **Your look:** choose from nine templates (Classic, Wave, Minimal, Bold, Elegant, Sidebar, Corporate, Mono and Geometric) in any colour, with a second colour on two-tone designs to match your branding, and add your company logo.
- **EFT details:** print your bank, account holder, account number, account type, branch code, SWIFT code and payment reference at the bottom of every invoice, with your bank's logo. Pick a South African bank to fill in its branch and SWIFT codes.
- **Business details:** your company name, VAT, tax and registration numbers, plus each client's VAT number. Set a tax rate for a client to add a VAT line to their invoices.
- **Live preview:** the PDF updates as you type. Zoom with − / +, or Ctrl (⌘ on a Mac) with + / − / 0.
- **A folder per client:** **Save invoice** puts the PDF straight into that client's folder, e.g. `Documents/Invoicer/Northwind Design Co/Northwind Design Co. Invoice - November 2026 - Alex Morgan.pdf`.
- **Numbering:** invoice numbers carry on from the last one you saved.
- **History:** every saved invoice, ready to open, save again, or copy into a new one.
- **Reminders:** pick a day each month for each client on the **Notifications** tab. Your computer then reminds you once a day until you've invoiced them, even when Invoicer is closed.
- **Paid or not:** mark invoices paid in **History**. Unpaid invoices past their due date show as overdue, and you're reminded the day after, then weekly.
- **Quotes:** switch **New invoice** to **Quote** for a quote with its own numbering and a "valid until" date, then turn it into an invoice with one click.
- **Reports:** see what you've invoiced, been paid, are owed and charged in VAT for a tax year (March to February) or calendar year, by client and by month, and export it to a spreadsheet.
- **Sign in with Google (optional):** back up your clients, settings, logos and invoice history to your own private account, and use them on your other computers.
- **Backups:** if you use Google Drive for desktop, every saved invoice is also copied to your Google Drive.

![The Notifications tab, with a reminder day for each client](docs/screenshot-notifications.png)

## Is it safe?

Each [release](https://github.com/BryceH1996/invoicer/releases) lists a **SHA-256 checksum** for every download. To check that your download is exactly the published file, run one of these in the folder you saved it to, and compare the result:

```powershell
Get-FileHash .\Invoicer-Setup-<version>.exe     # Windows, in PowerShell
```
```bash
shasum -a 256 Invoicer-<version>-mac.dmg       # Mac, in Terminal
```

Releases also link a **VirusTotal** scan of the Windows installer and the Mac disk image, and all of the source code is in this repository.

**What Invoicer does on your computer:**
- **Your data:** it saves your data as plain files on your computer (see [Your data](#your-data)). There are no accounts, tracking or analytics, and Invoicer never uploads anything itself.
- **Your account (only if you sign in):** your clients, settings, logos and invoice history are synced to your own account, which only you can read. Your PDFs aren't uploaded. **My details → Account & sync → Delete my cloud data** removes it. See the [privacy policy](https://bryceh1996.github.io/invoicer/privacy.html).
- **Reminders:** while at least one client has a reminder or an invoice is unpaid, it schedules a quick check once a day at 9am. On Windows that's a Task Scheduler task called "Invoicer reminders"; on a Mac it's a launch agent called `local.invoicer.reminders`, which also checks when you log in. Turning off your last reminder removes it, and on Windows so does uninstalling.
- **Updates:** it checks this repository's releases when it starts and every 30 minutes. It only downloads and installs an update when you click **Restart & update**.
- **Backups:** if Google Drive for desktop is installed, it copies saved invoices into your `My Drive` folder, and Google Drive uploads them as usual. Invoicer never signs in to Google itself.

## Your data

Everything is in the `Invoicer` folder in your Documents (**My details → Data** shows the exact folder, and lets you move it):

| File | What's in it |
| --- | --- |
| `clients.json` | Your clients and their rates |
| `settings.json` | Your details and invoice settings |
| `invoices.json` | The history of saved invoices |
| `logo.png` (or `.jpg`, …) | Your logo, if you've added one |
| `bank-logo.png` (or `.jpg`, …) | Your bank's logo, if you've added one |
| `<Client>/*.pdf` | Your invoices, one folder per client |

Invoicer's app folder also remembers which data folder you use, when each reminder last showed, and (if you sign in) your sign-in, encrypted by the operating system. It's `%APPDATA%\Invoicer` on Windows and `~/Library/Application Support/Invoicer` on a Mac. To back everything up, or to use the same data on another computer, move the data folder into OneDrive, iCloud Drive or similar.

---

## For developers

Built with [Electron](https://www.electronjs.org/) and [jsPDF](https://github.com/parallax/jsPDF).

```bash
npm install
npm start          # run it
npm run dist       # build dist/Invoicer Setup <version>.exe (on Windows)
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
| `docs/` | The website (GitHub Pages): homepage and privacy policy, plus README screenshots |
| `scripts/release.js` | The release script |
| `.github/workflows/mac.yml`, `scripts/mac-smoke-test.js` | The Mac build and its smoke test |
| `build/` | App icon; `installer.nsh` removes the reminder task on uninstall |
| `docs/` | README screenshots (invented sample data) |
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

© All rights reserved. The code is public so you can see what the app does. It isn't licensed for reuse.
