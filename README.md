# Invoicer

A small Windows desktop app for making PDF invoices.

- Saved clients, each with a currency (GBP, USD, EUR, ZAR), hourly rate, daily rate and day-off reduction
- Line items priced by hours, days, days off, or a fixed amount
- Live PDF preview, saved with a file name like `Client Invoice - November 2026 - Your Name.pdf`
- Invoice numbers continue automatically from the last saved invoice
- History of every saved invoice, which you can save again or copy
- Data stored as plain JSON (`clients.json`, `settings.json`, `invoices.json`) in `Documents\Invoicer`, or any folder you choose (OneDrive works well)
- Updates itself from an `updates` folder inside the data folder
- Backs up every saved invoice to an "Invoicer Backups" folder in Google Drive, and retries failed uploads automatically

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

This builds the installer and copies it, together with `latest.json`, into `<data folder>/updates`. Installed copies show an "Update available" bar and install the update when you click it.

## Google Drive backup setup (one time)

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "Invoicer"), and enable the **Google Drive API** for it.
2. Under **Google Auth Platform → Branding**, fill in the app name and your email. Under **Audience**, choose **External**, then click **Publish app** so it's "In production". Apps left in "Testing" are signed out every 7 days.
3. Under **Clients**, create a client with type **Desktop app**. Copy its client ID and client secret.
4. In Invoicer, go to **My details → Google Drive backup**, paste both, and click **Connect Google Drive**. Approve access in your browser. Google warns that the app isn't verified, because it's your own app: click **Advanced → Go to Invoicer**.

Invoicer only asks for the `drive.file` scope, so it can see only the files it creates. The credentials are stored encrypted in `%APPDATA%\Invoicer\google.json`, never in this repo.

## Repo layout

| Path | What it is |
| --- | --- |
| `main.js` | Electron main process: window, JSON storage, save dialogs, updates |
| `preload.js` | Bridge between the UI and the main process |
| `drive.js` | Google sign-in and Drive uploads |
| `app/` | UI (`index.html`, `renderer.js`, `style.css`) and PDF layout (`pdf.js`) |
| `scripts/release.js` | Publishes a built installer to the updates folder |
| `build/` | App icon and its generator |
| `prototype/invoicer.html` | The first single-file browser version |
