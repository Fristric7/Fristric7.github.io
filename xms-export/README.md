# XMS daily CSV export

Every day at 10:23 UTC (6:23 a.m. Eastern in summer, 5:23 a.m. in winter), a GitHub Actions workflow
opens <https://xms.sm360.ca/login> in a headless browser, signs in, follows the steps you give it to
download the CSV export, and commits the file to this repository:

```
data/xms/latest.csv            the newest export
data/xms/latest.json           its date, row count, size and SHA-256
data/xms/2026/2026-10-27.csv   one file per day
```

Any project that can read this repository can use the files (see [Using the files](#using-the-files)).

## Setup

All settings are under **Settings → Secrets and variables → Actions**, on the **Secrets** and
**Variables** tabs.

### 1. Make this repository private

The export is committed here, and the workflow refuses to save it to a public repository. Open
**Settings → General** and, under **Danger Zone**, use **Change visibility** to make it private.

On the free GitHub plan this takes the fristric7.github.io website offline: free accounts can only
publish GitHub Pages sites from public repositories. Private repositories also have a monthly
allowance of free Actions minutes (2,000 on the free plan); the export uses about 3 minutes a day.

To keep this repository public and commit the files to a separate private repository instead, set
`XMS_DATA_REPO` and `XMS_DATA_TOKEN` (see [Settings](#settings)).

### 2. Add the XMS login

Add the secrets `XMS_USERNAME` and `XMS_PASSWORD`. If you can, use an XMS user made for this export,
with only the access it needs. It must not use two-factor authentication: the script cannot enter
verification codes.

### 3. Describe the export

Add the variable `XMS_EXPORT_STEPS`: what you do in XMS, after signing in, to download the CSV. Put
one step per line, for example:

```
https://xms.sm360.ca/the/page/with/the/export
Exporter
CSV
```

- A line starting with `https://` opens that page. Copy it from your browser's address bar.
- Any other line clicks the button, link, tab or menu item showing that text. Case does not matter,
  and a label that matches exactly wins over one that only contains the text.
- For something more precise, use a [Playwright selector](https://playwright.dev/docs/other-locators):
  `css=#export-button`, `role=button[name="Export CSV"]`, or an XPath starting with `//`.
- The last step must be the one that starts the download.

Write the labels as XMS shows them. The browser asks XMS for English; if your XMS is in French,
write the steps in French and also set the variable `XMS_LOCALE` to `fr-CA`.

### 4. Merge, then test

GitHub only runs scheduled workflows, and only offers **Run workflow**, from the default branch, so
merge this into `main` first. Then open **Actions → XMS daily CSV export → Run workflow**:

- Tick **dry run** to check that the download works without saving it anywhere.
- If a run fails, its log says where the browser was and which export buttons it could see there.
  Tick **debug** as well to keep a screenshot of the page for a day, under **Artifacts** on the
  run's page.

The logs never contain your password, username or the rows of the export. They do show page addresses
and titles, your steps, button labels, and the downloaded file's name and column names.

## Using the files

Anything allowed to read this repository can use the files. To give another project access, create a
token at <https://github.com/settings/personal-access-tokens/new>: under **Repository access** pick
**Only select repositories** and choose this repository, then under **Permissions** set **Contents**
to **Read-only**.

From any script or tool:

```sh
curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw" \
  -o latest.csv https://api.github.com/repos/Fristric7/Fristric7.github.io/contents/data/xms/latest.csv
```

From another repository's GitHub Actions workflow:

```yaml
- uses: actions/checkout@v7
  with:
    repository: Fristric7/Fristric7.github.io
    token: ${{ secrets.XMS_DATA_READ_TOKEN }}
    path: xms-data
# The export is now at xms-data/data/xms/latest.csv
```

On a computer: `git clone https://github.com/Fristric7/Fristric7.github.io.git` once, then `git pull`
for the newest file.

`latest.json` says which day `latest.csv` is from. Check it if your project must not use an old export.

## Settings

| Name | Type | Default | Purpose |
| --- | --- | --- | --- |
| `XMS_USERNAME`, `XMS_PASSWORD` | secret | (required) | The XMS login. |
| `XMS_EXPORT_STEPS` | variable | (required) | How to get to the download; see step 3. |
| `XMS_DATA_REPO` | variable | this repository | Repository to commit the files to, as `owner/name`. |
| `XMS_DATA_TOKEN` | secret | the workflow's own token | Token that can write to `XMS_DATA_REPO`; needed when that is another repository. |
| `XMS_ALLOW_PUBLIC_DATA` | variable | `false` | `true` allows committing the export to a public repository. |
| `XMS_LOGIN_URL` | variable | `https://xms.sm360.ca/login` | Where to sign in. |
| `XMS_LOCALE` | variable | `en-CA` | Language the browser asks for. |
| `XMS_TIMEZONE` | variable | `America/Toronto` | Time zone that decides the date in the file names. |
| `XMS_TIMEOUT_SECONDS` | variable | `60` | How long to wait for each page or button. The download itself may take three times as long. |

To run at another time, change the `cron` line in `.github/workflows/xms-daily-export.yml`. It is in UTC.

## When a run fails

- **Is public, so the export would be visible to anyone**: make the repository private (step 1).
- **Login failed** or **Still on the login page**: check `XMS_USERNAME` and `XMS_PASSWORD`. If a run
  with **debug** shows a CAPTCHA, XMS is blocking automated browsers and this approach will not work.
- **Asks for a verification code**: use an XMS user without two-factor authentication.
- **Could not find "…"** or **No download started**: the log lists the export buttons and links it saw
  on that page. Use one of those labels, and make sure the last step is the one that starts the download.
- **Is a ZIP or Excel file** or **is a web page**: the last step downloaded something other than the
  CSV. Check which option it picks.
- **Cannot read …**: `XMS_DATA_REPO` is set, but `XMS_DATA_TOKEN` is missing, lacks access to that
  repository, or has expired.
- **The site cannot be reached**: if XMS only accepts connections from your dealership's network,
  GitHub's servers cannot reach it. Run it on a computer on that network instead (below), or on a
  [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners).

## Running it on your computer

Requires [Node.js](https://nodejs.org) 20 or later.

```sh
cd xms-export
npm ci
npx playwright install chromium
export XMS_USERNAME='you@example.com'
printf 'XMS password: '; read -rs XMS_PASSWORD; echo; export XMS_PASSWORD
export XMS_EXPORT_STEPS=$'https://xms.sm360.ca/the/page\nExporter\nCSV'
node export.mjs   # saves into ./out; set OUTPUT_DIR to save elsewhere
```

To find selectors, `npx playwright codegen https://xms.sm360.ca/login` opens a browser that shows a
selector for everything you click.
