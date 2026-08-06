# Turning on the automatic dashboard

Right now results arrive as codes people paste to you. To have them arrive on
their own, the site needs somewhere to send them. GitHub Pages only serves
files, it cannot receive anything, so this is the one piece that needs five
minutes from you. It is free and needs no new account beyond the Google one you
already have.

## 1. Make the sheet

Go to <https://sheets.new>, name it anything, and leave it empty.

## 2. Add the script

In that sheet: **Extensions** then **Apps Script**. Delete whatever is there and
paste this in:

```javascript
const SHEET = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]

function doPost(e) {
  const row = JSON.parse(e.postData.contents)
  SHEET.appendRow([new Date(), row.n, row.s, row.t, JSON.stringify(row)])
  return ContentService.createTextOutput('ok')
}

function doGet() {
  const values = SHEET.getDataRange().getValues()
  const rows = values
    .map(function (r) {
      try {
        return JSON.parse(r[4])
      } catch (err) {
        return null
      }
    })
    .filter(function (r) {
      return r
    })
  return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(
    ContentService.MimeType.JSON
  )
}
```

## 3. Publish it

**Deploy** then **New deployment**. Choose type **Web app**, set
**Execute as: Me** and **Who has access: Anyone**, then Deploy. Approve the
permission prompt. Copy the web app URL it gives you, which ends in `/exec`.

## 4. Send me the URL, or paste it in yourself

Send me the web app URL and I will wire it up. It is the only thing I need:
the sheet link on its own is not enough, because I cannot open your private
sheet, and the URL is what the pages talk to.

To do it yourself, edit `config.json` in the repository and put the URL
between the quotes:

```json
{ "endpoint": "https://script.google.com/macros/s/AKfy..../exec" }
```

Commit it. About a minute later the training page starts posting results
straight to your sheet, and the dashboard loads them by itself and refreshes
every minute. Nobody has to copy a code again.

## What changes once it is on

The dashboard shows **Collector connected** instead of asking for codes, and a
second attempt from the same person is visible to you even if they cleared
their browser storage to get around the one attempt lock. That is the part a
static page genuinely cannot do on its own.

## Changing the passphrases

`keys.json` holds one way fingerprints, never the words themselves. To change
somebody's passphrase, open the dashboard, type the new word into the
Passphrases panel, and it will show you the line to paste into `keys.json`.
Commit that file and the new word is live.

Anyone can read `keys.json`, so avoid words that a short guessing list would
cover. Two ordinary words joined together, `otter-window`, is far stronger than
`otter` and no harder to pass on.
