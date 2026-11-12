# Invoicer

A small, no-fuss Windows app for freelancers who invoice the same clients every month. Pick a client, fill in your days or hours, and save a clean PDF invoice. Invoicer remembers the rest.

## Install

**[⬇ Download the latest version](https://github.com/BryceH1996/invoicer/releases/latest)**

1. Download `Invoicer-Setup-<version>.exe` from the [latest release](https://github.com/BryceH1996/invoicer/releases/latest).
2. Run it. Invoicer isn't code-signed yet, so your browser may say the file "isn't commonly downloaded" (choose **Keep**), and Windows may show "Windows protected your PC" (click **More info → Run anyway**). [Is it safe?](#is-it-safe)
3. Fill in **My details**, add a client under **Clients**, and make your first invoice.

Invoicer keeps itself up to date after that. To remove it, go to **Windows Settings → Apps → Installed apps → Invoicer → Uninstall**. Your invoices and data stay in `Documents\Invoicer`.

![Making an invoice in Invoicer, with the live PDF preview on the right](docs/screenshot-invoice.png)

## What it does

- **Saved clients.** Each client keeps its own address, payment terms, currency (GBP, USD, EUR or ZAR), hourly rate, daily rate and day-off reduction.
- **Priced for you.** Add lines as days, hours, days off or fixed amounts, and the totals work themselves out from the client's rates.
- **Live preview.** See the PDF update as you type. Zoom in and out with the − / + buttons, or Ctrl + / Ctrl − / Ctrl 0.
- **Tidy files.** Each invoice is saved straight into a folder for that client, e.g. `Documents\Invoicer\Northwind Design Co\Northwind Design Co Invoice - November 2026 - Alex Morgan.pdf`.
- **Numbering handled.** Invoice numbers carry on from the last one you saved.
- **History.** Every invoice you've saved, ready to open, save again, or copy as the start of a new one.
- **Reminders.** Choose a day each month for each client, and Windows reminds you until you've invoiced them. Invoicer doesn't need to be open for this.
- **Backups.** If you use Google Drive for desktop, every saved invoice is copied to your Google Drive too.
- **Keeps itself up to date.** When a new version is out, a bar at the top offers to install it.

![The Notifications tab, with a reminder day for each client](docs/screenshot-notifications.png)

## Is it safe?

Every release lists two things you can check:

- **SHA-256 checksum:** a fingerprint of the installer. To check that your download is exactly the file that was published, run this in PowerShell in the folder you saved it to:
  ```powershell
  Get-FileHash .\Invoicer-Setup-<version>.exe
  ```
  The result should match the SHA-256 in the release notes.
- **VirusTotal report:** the installer scanned by around 70 antivirus engines.

The full source code is in this repository.

**What Invoicer does on your PC:**
- It keeps your clients, settings and invoice history as plain JSON files in `Documents\Invoicer`, or a folder you choose. It never sends them anywhere.
- **Reminders:** while at least one client has a reminder, it adds a Windows scheduled task called "Invoicer reminders" that checks once a day at 9am. Turning off your last reminder, or uninstalling Invoicer, removes the task.
- **Updates:** it checks this repository's Releases page for a newer version every 30 minutes. It only downloads and installs one when you click **Restart & update**.
- **Backups:** if you have Google Drive for desktop, it copies saved invoices into your `My Drive` folder, and Google Drive uploads them as usual. Invoicer never signs in to Google itself.
- It has no accounts, no tracking and no analytics.

## Your data

All of your data lives in your data folder (**My details → Data** shows where):

| File | What's in it |
| --- | --- |
| `clients.json` | Your clients and their rates |
| `settings.json` | Your details and invoice settings |
| `invoices.json` | The history of saved invoices |
| `<Client name>\*.pdf` | Your invoices, one folder per client |

Putting the data folder inside OneDrive (or similar) backs everything up, and lets you use the same data on another PC.

---

## For developers

Built with [Electron](https://www.electronjs.org/) and [jsPDF](https://github.com/parallax/jsPDF).

```bash
npm install
npm start          # run it
npm run dist       # build dist/Invoicer Setup <version>.exe
```

### Releasing

Bump `version` in `package.json`, then:

```bash
npm run release -- "What changed"
```

This:
1. Refuses to run if `v<version>` is already tagged.
2. Builds the installer.
3. Copies it, with `latest.json`, into `<data folder>/updates` (the developer's own copy updates from here).
4. Commits, tags `v<version>`, and pushes to both the `origin` and `public` remotes.
5. Creates the GitHub Release on the public repo (`updateRepo` in `package.json`) and attaches the installer. It then adds the SHA-256 and, if `VIRUSTOTAL_API_KEY` is set, the VirusTotal result to the release notes.

`--no-build` reuses the installer in `dist/`. `--github-only` reruns only step 5 for a version that's already tagged. Step 5 uses `GITHUB_TOKEN`, or the GitHub login git already has.

### Layout

| Path | What it is |
| --- | --- |
| `main.js` | Main process: window, JSON storage, saving, Google Drive backups, reminders and their scheduled task, updates |
| `preload.js` | Bridge between the UI and the main process |
| `app/` | UI (`index.html`, `renderer.js`, `style.css`) and PDF layout (`pdf.js`) |
| `scripts/release.js` | The release steps above |
| `build/` | App icon and its generator; `installer.nsh` removes the reminder task on uninstall |
| `docs/` | Screenshots for this README (made with invented sample data) |
| `prototype/invoicer.html` | The first single-file browser version |

© All rights reserved. The code is public so you can see what the app does. It isn't licensed for reuse.
