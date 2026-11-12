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
- Invoice reminders per client (a day of the month, or the last working day), all set from the **Notifications** tab. It shows each client's reminder, whether they're due, invoiced or skipped this month, and the next reminder date. It also shows whether the Windows task is set up and has a test-notification button. From that day, a Windows notification appears once a day from 9am until you save an invoice for that client or click "Skip this month". Invoicer doesn't need to be open. While any client has a reminder, a Windows Task Scheduler task ("Invoicer reminders") runs `Invoicer --check-reminders` every day at 9am, or as soon as the PC is on if it was off then. That run has no window and exits straight away unless a notification is showing. Turning off the last reminder deletes the task, and so does uninstalling Invoicer.

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
4. Commits any uncommitted changes, tags `v<version>`, and pushes both to this private repo (`origin`) and the public copy (`public`, github.com/BryceH1996/invoicer). If a push fails, the update is still published, and the script prints the `git push` commands to run later.
5. Creates a GitHub Release for the tag on the public repo, with the installer attached. It uses `GITHUB_TOKEN` if set, otherwise the GitHub login git already uses. If this step fails, rerun just it with `npm run release -- --github-only`.

Use `npm run release -- --no-build "note"` to reuse the installer already in `dist/`.

## Installing it for someone else

Send them https://github.com/BryceH1996/invoicer/releases/latest. They download `Invoicer-Setup-<version>.exe` and run it. Windows SmartScreen will warn that the app isn't signed: they click **More info → Run anyway**. Their copy updates itself from the same page, with no GitHub account needed.

Each copy keeps its own clients and invoices. Nothing of yours is in the installer.

## The public repo

`BryceH1996/invoicer` is a public copy of this repo. Releases push the same commits and tags to it. Only you can push to it: nobody else has access, force-pushes and deleting `main` are blocked, and issues and the wiki are turned off. Anyone can read and fork the code. It has no licence, so others have no right to reuse it.

## Updates

`npm run release` publishes each version to two places:
- the `updates` folder inside your data folder (your own copy sees it straight away)
- the public repo's GitHub Releases (every copy checks there every 30 minutes)

The app offers whichever is newer, downloads it, and installs it silently when you click **Restart & update**.

## Google Drive backup

Install [Google Drive for desktop](https://www.google.com/drive/download/) and sign in. It shows your Drive as a `My Drive` folder, usually `G:\My Drive`, or `%USERPROFILE%\My Drive` in mirror mode.

Invoicer finds that folder by itself. Every time you save an invoice, it copies the PDF to `My Drive\Invoicer Backups\<Client>\`, named with the invoice number. Google Drive then uploads it. If the copy fails, for example because Google Drive isn't running, History marks the invoice and Invoicer retries on start-up and every 10 minutes. To use a different folder, go to **My details → Use a different folder…**.

## Repo layout

| Path | What it is |
| --- | --- |
| `main.js` | Electron main process: window, JSON storage, saving, Google Drive backups, reminders and their scheduled task, updates |
| `preload.js` | Bridge between the UI and the main process |
| `app/` | UI (`index.html`, `renderer.js`, `style.css`) and PDF layout (`pdf.js`) |
| `scripts/release.js` | Builds, publishes to the updates folder, tags, pushes, and creates the GitHub Release |
| `build/` | App icon and its generator; `installer.nsh` removes the reminder task on uninstall |
| `prototype/invoicer.html` | The first single-file browser version |
