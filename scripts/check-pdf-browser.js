const fs = require('node:fs/promises');
const puppeteer = require('puppeteer');

const checkPdfBrowser = async () => {
  // Check Puppeteer's configured binary directly so a system browser cannot
  // hide a missing deployment artifact on a developer's machine.
  const executablePath = await puppeteer.executablePath();
  await fs.access(executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><h1>PDF browser check</h1></body></html>');
    const pdf = await page.pdf({ format: 'A4' });
    if (Buffer.from(pdf).subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('Chrome did not generate a valid PDF.');
    }
    console.log(`PDF browser check passed: ${executablePath}`);
  } finally {
    await browser.close();
  }
};

checkPdfBrowser().catch((error) => {
  console.error('PDF browser check failed. Run npm run browser:install and check the Puppeteer environment variables.');
  console.error(error.message);
  process.exitCode = 1;
});
