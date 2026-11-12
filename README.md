# Invoicer

A small Windows desktop app for making PDF invoices.

- Saved clients, each with a currency (GBP, USD, EUR, ZAR), hourly rate, daily rate and day-off reduction
- Line items priced by hours, days, days off, or a fixed amount
- Live PDF preview with zoom (the − / + buttons, or Ctrl+ / Ctrl− / Ctrl+0 for fit to width). Invoices save straight into a folder per client, `Documents\Invoicer\<Client>\Client Invoice - November 2026 - Your Name.pdf`. A second invoice in the same month gets its invoice number added to the name.
- Invoice numbers continue automatically from the last saved invoice
- History of every saved invoice, which you can save again or copy
- Data stored as plain JSON (`clients.json`, `settings.json`, `invoices.json`) in `Documents\Invoicer`, or any folder you choose (OneDrive works well)
- Updates itself from an `updates` folder inside the data folder
- Backs up every saved invoice to Google Drive (via Google Drive for desktop), and retries failed backups automatically
- Invoice reminders per client (a day of the month, or the last working day). From that day, a Windows notification appears once a day from 9am until you save an invoice for that client or click "Skip this month". While any client has a reminder, Invoicer starts with Windows and keeps running in the system tray when you close the window. Quit it from the tray icon.

Built with Electron and jsPDF.

## Development

```bash
npm install
npm start
```

## Building an installer

```bash
npm run dist
```

This creates `dist/Invoicer Setup <version>.exe`.

## Releasing an update

Bump `version` in `package.json`, then run:

```bash
npm run release -- "What changed"
```

This:
1. Refuses to run if `v<version>` is already tagged, so you can't release the same version twice.
2. Builds the installer.
3. Copies it, together with `latest.json`, into `<data folder>/updates`. Installed copies show an "Update available" bar and install the update when you click it.
4. Commits any uncommitted changes, tags `v<version>`, and pushes both to GitHub. If the push fails, the update is still published, and the script prints the `git push` command to run later.

Use `npm run release -- --no-build "note"` to reuse the installer already in `dist/`.

## Google Drive backup

Install [Google Drive for desktop](https://www.google.com/drive/download/) and sign in. It shows your Drive as a `My Drive` folder, usually `G:\My Drive`, or `%USERPROFILE%\My Drive` in mirror mode.

Invoicer finds that folder by itself. Every time you save an invoice, it copies the PDF to `My Drive\Invoicer Backups\<Client>\`, named with the invoice number. Google Drive then uploads it. If the copy fails, for example because Google Drive isn't running, History marks the invoice and Invoicer retries on start-up and every 10 minutes. To use a different folder, go to **My details → Use a different folder…**.

## Repo layout

| Path | What it is |
| --- | --- |
| `main.js` | Electron main process: window, tray, JSON storage, saving, Google Drive backups, reminders, updates |
| `preload.js` | Bridge between the UI and the main process |
| `app/` | UI (`index.html`, `renderer.js`, `style.css`) and PDF layout (`pdf.js`) |
| `scripts/release.js` | Publishes a built installer to the updates folder |
| `build/` | App icon and its generator |
| `prototype/invoicer.html` | The first single-file browser version |
