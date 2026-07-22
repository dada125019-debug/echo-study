const { chromium } = require('C:/Users/Junda Mou/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(__dirname, '..', 'ui-check-desktop.png'), fullPage: true });
  await page.locator('#openSource').click();
  await page.locator('[data-source="search"]').click();
  await page.screenshot({ path: path.join(__dirname, '..', 'ui-check-dialog.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(__dirname, '..', 'ui-check-mobile.png'), fullPage: true });
  console.log(JSON.stringify({ title: await page.title(), errors, screenshots: 3 }));
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
