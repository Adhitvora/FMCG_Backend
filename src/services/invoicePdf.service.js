const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { buildInvoiceHtml } = require('./invoiceTemplate.service');
const { uploadFileToCloudinary, isCloudinaryConfigured, CLOUDINARY_ROOT } = require('../configs/cloudinary.config');

const uploadsDirectory = path.resolve(__dirname, '..', '..', 'uploads');
const invoicesDirectory = path.join(uploadsDirectory, 'invoices');
const tempDirectory = path.join(uploadsDirectory, 'temp');

let browserPromise = null;

const ensureInvoiceDirectories = async () => {
  await Promise.all([
    fs.promises.mkdir(uploadsDirectory, { recursive: true }),
    fs.promises.mkdir(invoicesDirectory, { recursive: true }),
    fs.promises.mkdir(tempDirectory, { recursive: true }),
  ]);
};

const getPuppeteerExecutable = async () => {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH];

  try {
    candidates.push(await puppeteer.executablePath());
  } catch (error) {
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
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
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
    throw new Error('Unable to launch the invoice PDF browser. Set PUPPETEER_EXECUTABLE_PATH or install the Puppeteer Chrome browser. ' + error.message);
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
  } catch (error) {
  } finally {
    browserPromise = null;
  }
};

const safeInvoiceFileName = (invoiceNumber) => String(invoiceNumber || 'invoice')
  .replace(/[^a-zA-Z0-9._-]/g, '_') + '.pdf';

const getInvoicePdfInfo = (invoiceNumber) => {
  const fileName = safeInvoiceFileName(invoiceNumber);
  return {
    fileName,
    absolutePath: path.join(invoicesDirectory, fileName),
    publicPath: '/uploads/invoices/' + fileName,
  };
};

const createTempPdfPath = (invoiceNumber) => {
  const fileName = safeInvoiceFileName(invoiceNumber).replace(/\.pdf$/, '');
  return path.join(tempDirectory, fileName + '.' + process.pid + '.' + Date.now() + '.tmp.pdf');
};

const renderInvoicePdf = async (invoice, outputPath) => {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.setContent(buildInvoiceHtml(invoice), { waitUntil: 'load' });
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

/**
 * Upload a generated invoice PDF to Cloudinary.
 * Returns the Cloudinary secure_url, or null if Cloudinary is not configured.
 */
const uploadInvoicePdfToCloudinary = async (localPdfPath, invoiceNumber) => {
  if (!isCloudinaryConfigured()) return null;

  try {
    const publicId = safeInvoiceFileName(invoiceNumber).replace(/\.pdf$/, '');
    const result = await uploadFileToCloudinary(
      localPdfPath,
      `${CLOUDINARY_ROOT}/invoices`,
      publicId,
      'raw',
    );
    return result.secure_url;
  } catch (error) {
    console.error('Cloudinary PDF upload failed, using local path:', error.message);
    return null;
  }
};

const fileExists = async (filePath) => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
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
  createTempPdfPath,
  ensureInvoiceDirectories,
  fileExists,
  getInvoicePdfInfo,
  removeFileIfExists,
  renderInvoicePdf,
  uploadInvoicePdfToCloudinary,
};

