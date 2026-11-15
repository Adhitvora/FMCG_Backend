const path = require('node:path');

/** @type {import('puppeteer').Configuration} */
module.exports = {
  // Keep Chrome in the deployed project, not Render's build-only home cache.
  cacheDirectory: path.join(__dirname, '.cache', 'puppeteer'),
  // Both PDF services use headless: true, which runs the regular Chrome binary.
  'chrome-headless-shell': { skipDownload: true },
};
