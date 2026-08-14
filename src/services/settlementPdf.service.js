const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { buildSettlementHtml } = require('./settlementTemplate.service');
const { uploadFileToCloudinary, isCloudinaryConfigured, CLOUDINARY_ROOT } = require('../configs/cloudinary.config');

const uploadsDirectory = path.resolve(__dirname, '..', '..', 'uploads');
const settlementsDirectory = path.join(uploadsDirectory, 'settlements');
const tempDirectory = path.join(uploadsDirectory, 'temp');

let browserPromise = null;

const ensureSettlementDirectories = async () => {
  await Promise.all([
    fs.promises.mkdir(uploadsDirectory, { recursive: true }),
    fs.promises.mkdir(settlementsDirectory, { recursive: true }),
    fs.promises.mkdir(tempDirectory, { recursive: true }),
  ]);
};

const getPuppeteerExecutable = async () => {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH];
  try {
    candidates.push(await puppeteer.executablePath());
  } catch {
    candidates.push(null);
  }
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  }
  if (process.platform === 'linux') {
    candidates.push('/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
};

const launchBrowser = async () => {
  const executablePath = await getPuppeteerExecutable();
  const options = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (executablePath) options.executablePath = executablePath;
  try {
    return await puppeteer.launch(options);
  } catch (error) {
    throw new Error('Unable to launch the settlement PDF browser. Set PUPPETEER_EXECUTABLE_PATH or install the Puppeteer Chrome browser. ' + error.message);
  }
};

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
};

const closeBrowser = async () => {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
  } finally {
    browserPromise = null;
  }
};

const safeSettlementFileName = (settlementNo) => String(settlementNo || 'settlement')
  .replace(/[^a-zA-Z0-9._-]/g, '_') + '.pdf';

const getSettlementPdfInfo = (settlementNo) => {
  const fileName = safeSettlementFileName(settlementNo);
  return {
    fileName,
    absolutePath: path.join(settlementsDirectory, fileName),
    publicPath: '/uploads/settlements/' + fileName,
  };
};

const createTempSettlementPdfPath = (settlementNo) => {
  const fileName = safeSettlementFileName(settlementNo).replace(/\.pdf$/, '');
  return path.join(tempDirectory, fileName + '.' + process.pid + '.' + Date.now() + '.tmp.pdf');
};

const renderSettlementPdf = async (settlement, outputPath) => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.setContent(buildSettlementHtml(settlement), { waitUntil: 'load' });
    await page.emulateMediaType('print');
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await page.close();
  }
};

const uploadSettlementPdfToCloudinary = async (localPdfPath, settlementNo) => {
  if (!isCloudinaryConfigured()) return null;
  try {
    const publicId = safeSettlementFileName(settlementNo).replace(/\.pdf$/, '');
    const result = await uploadFileToCloudinary(localPdfPath, `${CLOUDINARY_ROOT}/settlements`, publicId, 'raw');
    return result.secure_url;
  } catch (error) {
    console.error('Cloudinary settlement PDF upload failed, using local path:', error.message);
    return null;
  }
};

const fileExists = async (filePath) => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const removeFileIfExists = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

process.once('SIGTERM', closeBrowser);
process.once('SIGINT', closeBrowser);

module.exports = {
  closeBrowser,
  createTempSettlementPdfPath,
  ensureSettlementDirectories,
  fileExists,
  getSettlementPdfInfo,
  removeFileIfExists,
  renderSettlementPdf,
  uploadSettlementPdfToCloudinary,
};
