#!/usr/bin/env node
// Logs in to XMS (sm360), downloads a CSV export and saves it in OUTPUT_DIR as:
//   YYYY/YYYY-MM-DD.csv  the export for that day
//   latest.csv           a copy of the newest export
//   latest.json          its date, row count, size and SHA-256
// Settings come from environment variables; see README.md.

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const TEXT_INPUT = ':is(input:not([type]), input[type="text"], input[type="email"], input[type="tel"])';
// Most specific first: the first of these with a visible match is used as the username field.
const USERNAME_FIELDS = [
  `${TEXT_INPUT}[autocomplete~="username"]`,
  'input[type="email"]',
  `${TEXT_INPUT}:is([name*="user" i], [id*="user" i], [name*="mail" i], [id*="mail" i], [name*="login" i], [id*="login" i])`,
  TEXT_INPUT,
];
const PASSWORD_FIELD = 'input[type="password"]';
const SUBMIT_BUTTON = ':is(button[type="submit"], button:not([type]), input[type="submit"])';
const SUBMIT_LABEL = /^\s*(log ?in|sign ?in|connexion|se connecter|continue|continuer|next|suivant|submit|soumettre)\s*$/i;
const CODE_FIELD = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="mfa" i], input[name*="totp" i]';
const LOGIN_ERROR = '[role="alert"], .alert-danger, .error, .error-message, .invalid-feedback, .text-danger, mat-error, .mat-mdc-form-field-error';
const CLICKABLE_ROLES = ['button', 'link', 'menuitem', 'menuitemradio', 'option', 'radio', 'tab'];
// A step written as a Playwright selector rather than as the text of what to click.
const SELECTOR_STEP = /^(css|xpath|text|role|id|data-testid)=|^\(*\/\//;
const EXPORT_WORDS = /export|csv|excel|xls|download|télécharg|rapport|report/i;

function readConfig() {
  const env = (name, fallback = '') => process.env[name]?.trim() || fallback;
  const config = {
    loginUrl: env('XMS_LOGIN_URL', 'https://xms.sm360.ca/login'),
    username: env('XMS_USERNAME'),
    // Only trailing line breaks are removed: they are easy to paste into a secret by accident
    // and cannot be part of a password typed into a password field.
    password: (process.env.XMS_PASSWORD ?? '').replace(/[\r\n]+$/, ''),
    steps: env('XMS_EXPORT_STEPS').split(/\r?\n/).map((step) => step.trim()).filter(Boolean),
    locale: env('XMS_LOCALE', 'en-CA'),
    timeZone: env('XMS_TIMEZONE', 'America/Toronto'),
    timeoutMs: Number(env('XMS_TIMEOUT_SECONDS', '60')) * 1000,
    outputDir: env('OUTPUT_DIR', 'out'),
    debugDir: env('XMS_DEBUG_DIR'),
  };
  if (!config.username || !config.password) throw new Error('Set XMS_USERNAME and XMS_PASSWORD.');
  if (!(config.timeoutMs > 0)) throw new Error('XMS_TIMEOUT_SECONDS must be a positive number.');
  localDate(config.timeZone); // Fails now, before logging in, if the time zone is unknown.
  return config;
}

async function main() {
  const config = readConfig();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: config.locale,
    timezoneId: config.timeZone,
    viewport: { width: 1440, height: 900 },
  });
  context.setDefaultTimeout(config.timeoutMs);
  const page = await context.newPage();
  let loggedIn = false;
  try {
    await logIn(page, config);
    loggedIn = true;
    if (!config.steps.length) {
      throw new Error('Logged in, but XMS_EXPORT_STEPS is not set, so there is nothing to download. See xms-export/README.md.');
    }
    const download = await runSteps(page, config);
    const saved = await save(download, config);
    const size = `${saved.rows} rows, ${Math.ceil(saved.bytes / 1024)} KB`;
    console.log(`Saved ${path.join(config.outputDir, saved.file)}: ${size}.`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `XMS export for ${saved.date}: ${size}.\n`);
    }
  } catch (error) {
    await describe(page, config.debugDir, loggedIn);
    throw error;
  } finally {
    await browser.close();
  }
}

async function logIn(page, { loginUrl, username, password, timeoutMs }) {
  console.log(`Opening ${where(loginUrl)}`);
  await page.goto(loginUrl);

  const passwordField = visible(page.locator(PASSWORD_FIELD));
  await waitFor(visible(page.locator([...USERNAME_FIELDS, PASSWORD_FIELD].join(', '))), 'No login form appeared');
  const usernameField = await firstPresent(USERNAME_FIELDS.map((selector) => visible(page.locator(selector))));
  if (!usernameField) throw new Error(`No username field found on ${where(page.url())}.`);
  await usernameField.fill(username);

  // Some sign-in pages ask for the username first and only then show the password field.
  if (!(await appears(passwordField, 3000))) {
    await submit(usernameField);
    await waitFor(passwordField, 'No password field appeared after entering the username');
  }
  await passwordField.fill(password);
  const shownBefore = await errorMessages(page);
  await submit(passwordField);
  await waitUntilLoggedIn(page, timeoutMs, shownBefore);
  console.log(`Logged in, now on ${where(page.url())}`);
}

// Clicks the form's submit button the way a person would. Presses Enter instead when there is no
// such button or something (a cookie banner, for example) covers it.
async function submit(field) {
  const button = await firstPresent([
    visible(field.locator('xpath=ancestor::form[1]').locator(SUBMIT_BUTTON)),
    visible(field.page().getByRole('button', { name: SUBMIT_LABEL })),
  ]);
  if (button) {
    try {
      return await button.click({ timeout: 5000 });
    } catch {
      // Fall back to Enter below.
    }
  }
  if (await field.isVisible()) await field.press('Enter');
}

// Waits until the password field has been gone for two seconds. Fails early when the page shows a
// new error (one not in shownBefore, such as a maintenance notice) or asks for a verification code.
async function waitUntilLoggedIn(page, timeoutMs, shownBefore) {
  const passwordField = visible(page.locator(PASSWORD_FIELD));
  const deadline = Date.now() + timeoutMs;
  let goneSince;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await visible(page.locator(CODE_FIELD)).count()) {
      throw new Error('XMS asks for a verification code (two-factor authentication), which this script cannot enter.');
    }
    if (await passwordField.isVisible()) {
      goneSince = undefined;
      const error = (await errorMessages(page)).find((message) => !shownBefore.includes(message));
      if (error) throw new Error(`Login failed: ${error}`);
    } else {
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= 2000) return;
    }
  }
  throw new Error(`Still on the login page after ${timeoutMs / 1000}s (${where(page.url())}). Check XMS_USERNAME and XMS_PASSWORD.`);
}

async function errorMessages(page) {
  const texts = await page.locator(LOGIN_ERROR).filter({ visible: true, hasText: /\S/ }).allInnerTexts();
  return texts.map((text) => text.trim());
}

async function runSteps(page, { steps, timeoutMs }) {
  const downloads = watchDownloads(page.context());
  for (const [index, step] of steps.entries()) {
    console.log(`Step ${index + 1}/${steps.length}: ${step}`);
    try {
      if (/^https?:\/\//i.test(step)) await open(page, step);
      else await click(page, step);
    } catch (error) {
      if (!downloads.started) throw error;
      throw new Error(`A download started before step ${index + 1}. Remove the steps after the one that starts it.`);
    }
  }
  console.log('Waiting for the download');
  return downloads.next(timeoutMs * 3);
}

async function open(page, url) {
  try {
    await page.goto(url);
  } catch (error) {
    // Opening a file's address directly starts a download, which Playwright reports as a failed navigation.
    if (!String(error?.message).includes('Download is starting')) throw error;
  }
}

async function click(page, step) {
  const candidates = (SELECTOR_STEP.test(step) ? [page.locator(step)] : textMatches(page, step))
    .map((locator) => locator.filter({ visible: true }));
  const any = candidates.reduce((all, locator) => all.or(locator)).first();
  await waitFor(any, `Could not find "${step}"`);
  const target = (await firstPresent(candidates.map((locator) => locator.first()))) ?? any;
  await target.click();
}

// In order of preference: buttons, links and menu items labelled exactly with the text, those whose
// label contains it, then any other element showing it.
function textMatches(page, text) {
  const exact = new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const clickable = (name) => CLICKABLE_ROLES.map((role) => page.getByRole(role, { name })).reduce((all, locator) => all.or(locator));
  return [clickable(exact), clickable(text), page.getByText(exact), page.getByText(text)];
}

// Resolves with the first download from any tab, including tabs opened by a click.
function watchDownloads(context) {
  let started = false;
  const first = new Promise((resolve) => {
    const watch = (page) => page.on('download', (download) => {
      started = true;
      resolve(download);
    });
    context.pages().forEach(watch);
    context.on('page', watch);
  });
  return {
    get started() {
      return started;
    },
    async next(timeoutMs) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No download started within ${timeoutMs / 1000}s of the last step.`)), timeoutMs);
      });
      try {
        return await Promise.race([first, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function save(download, { outputDir, timeZone }) {
  const name = download.suggestedFilename();
  const failure = await download.failure();
  if (failure) throw new Error(`Downloading "${name}" failed: ${failure}`);
  const data = await readFile(await download.path());
  const { rows, header } = inspectCsv(data, name);
  console.log(`Downloaded "${name}". Columns: ${header}`);

  const date = localDate(timeZone);
  const file = `${date.slice(0, 4)}/${date}.csv`;
  await mkdir(path.join(outputDir, date.slice(0, 4)), { recursive: true });
  await writeFile(path.join(outputDir, file), data);
  await writeFile(path.join(outputDir, 'latest.csv'), data);
  const info = {
    date,
    file,
    rows,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    source_filename: name,
    downloaded_at: new Date().toISOString(),
  };
  await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

// Rejects files that are clearly not CSV (spreadsheets, PDFs, error pages) and counts the data rows,
// ignoring line breaks inside quoted fields.
function inspectCsv(data, name) {
  const notCsv = (kind) => new Error(`"${name}" is ${kind}, not a CSV file. Check the last steps in XMS_EXPORT_STEPS.`);
  if (!data.length) throw new Error(`"${name}" is empty.`);
  const magic = data.subarray(0, 4).toString('latin1');
  if (magic === 'PK\x03\x04') throw notCsv('a ZIP or Excel file');
  if (magic === '\xD0\xCF\x11\xE0') throw notCsv('an old Excel (.xls) file');
  const text = data.toString('utf8').replace(/^\uFEFF/, '');
  if (text.startsWith('%PDF')) throw notCsv('a PDF');
  if (/^\s*</.test(text)) throw notCsv('a web page (often an error page or an expired session)');

  let lines = 0;
  let headerEnd = -1;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === '\n' && !quoted) {
      if (headerEnd < 0) headerEnd = i;
      lines++;
    }
  }
  if (!text.endsWith('\n')) lines++;
  const header = text.slice(0, headerEnd < 0 ? undefined : headerEnd).trim();
  return { rows: Math.max(lines - 1, 0), header: header.length > 200 ? `${header.slice(0, 200)}…` : header };
}

// Logs where the browser ended up and, once logged in, which export-like buttons it could see, to help
// fix the steps. Only export-related labels are listed, so that customer data on the page stays out of
// the logs.
async function describe(page, debugDir, listExportButtons) {
  try {
    if (page.isClosed()) return;
    console.error(`The browser was on ${where(page.url())} ("${await page.title()}").`);
    if (listExportButtons) await listExportLabels(page);
    if (debugDir) {
      await mkdir(debugDir, { recursive: true });
      await page.screenshot({ path: path.join(debugDir, 'failure.png'), fullPage: true });
      console.error(`Saved a screenshot to ${path.join(debugDir, 'failure.png')}`);
    }
  } catch (error) {
    console.error(`(Could not inspect the page: ${error?.message})`);
  }
}

async function listExportLabels(page) {
  const labels = await page
    .locator('a, button, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]')
    .filter({ visible: true })
    .evaluateAll((elements) => elements.map((el) => el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || ''));
  const related = [...new Set(labels.map((label) => label.replace(/\s+/g, ' ').trim()).filter((label) => EXPORT_WORDS.test(label)))];
  console.error(related.length
    ? `Export-related buttons and links on that page: ${related.slice(0, 15).map((label) => `"${label}"`).join(', ')}`
    : 'No export-related buttons or links are visible on that page.');
}

const visible = (locator) => locator.filter({ visible: true }).first();
const appears = (locator, timeout) => locator.waitFor({ timeout }).then(() => true, () => false);

// Like locator.waitFor(), but a timeout fails with the given message and where the browser was.
async function waitFor(locator, message) {
  try {
    await locator.waitFor();
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    throw new Error(`${message} on ${where(locator.page().url())}.`);
  }
}

async function firstPresent(locators) {
  for (const locator of locators) if (await locator.count()) return locator;
  return null;
}

function localDate(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Host and path only: query strings can carry session tokens.
function where(url) {
  try {
    const { host, pathname } = new URL(url);
    return host ? host + pathname : url;
  } catch {
    return url;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=XMS export failed::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
});
