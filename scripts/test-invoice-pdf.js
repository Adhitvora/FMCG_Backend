/*
 * Render and inspect actual invoice PDFs without touching application data.
 * Run from backend:
 *   npm install --prefix .cache/pdf-acceptance-tools --no-save --ignore-scripts pdfjs-dist @napi-rs/canvas
 *   node scripts/test-invoice-pdf.js
 * PDF, PNG, HTML, and JSON evidence is written under ignored uploads/.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer');
const { buildInvoiceHtml } = require('../src/services/invoiceTemplate.service');
const { renderInvoicePdf, closeBrowser } = require('../src/services/invoicePdf.service');

const artifactDirectory = path.resolve(__dirname, '../uploads/invoice-pdf-acceptance');
const inspectionModules = path.resolve(__dirname, '../.cache/pdf-acceptance-tools/node_modules');

const makeFixture = (id, count, quantities = [1]) => ({
  id,
  invoice: {
    invoiceNumber: `PDF-TEST-${id}`,
    invoiceDate: '2026-09-12T06:00:00Z',
    companySnapshot: {
      name: 'PDF Acceptance Fixture Company',
      address: 'Industrial Estate, Rajkot, Gujarat 360003',
      contact: '9999999999',
      gst: '24TESTFIXTURE1Z5',
    },
    transportName: 'Fixture Transport',
    cartons: [],
    items: Array.from({ length: count }, (_, index) => ({
      replacement: `replacement-${id}-${index + 1}`,
      replacementId: `RL-${id}-${String(index + 1).padStart(3, '0')}`,
      partyName: `PARTY_${id}_${String(index + 1).padStart(3, '0')}`,
      town: 'Rajkot',
      lrNo: `LR-${String(index + 1).padStart(3, '0')}`,
      receivingCases: quantities[index % quantities.length],
      actualCases: quantities[index % quantities.length],
      cartonId: null,
    })),
  },
});

const merge = (fixture, indices, physicalCaseCount = 1) => {
  const cartonId = `carton-${fixture.id}-${fixture.invoice.cartons.length + 1}`;
  for (const index of indices) fixture.invoice.items[index].cartonId = cartonId;
  fixture.invoice.cartons.push({
    masterCartonId: cartonId,
    memberReplacementIds: indices.map((index) => fixture.invoice.items[index].replacement),
    physicalCaseCount,
    totalCases: indices.reduce((sum, index) => sum + fixture.invoice.items[index].receivingCases, 0),
    label: String(fixture.invoice.cartons.length + 1),
  });
  return fixture;
};

const expectedTotals = (fixture) => ({
  case1: fixture.invoice.items.reduce((sum, item) => sum + item.receivingCases, 0),
  case2: fixture.invoice.items.filter((item) => !item.cartonId)
    .reduce((sum, item) => sum + item.receivingCases, 0)
    + fixture.invoice.cartons.reduce((sum, carton) => sum + carton.physicalCaseCount, 0),
});

const inspectHtml = async (browser, fixture, media = 'print') => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.emulateMediaType(media);
    await page.setContent(buildInvoiceHtml(fixture.invoice), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (!window.invoicePaginationReady) throw new Error('Invoice pagination did not initialize');
      await window.invoicePaginationReady;
      if (window.invoicePaginationError) throw new Error(window.invoicePaginationError);
    });
    const result = await page.evaluate(() => {
      const bounds = (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        blankRows: document.querySelectorAll('.blank-row').length,
        html: document.documentElement.outerHTML,
        pages: [...document.querySelectorAll('.invoice-page')].map((invoicePage, index) => ({
          page: index + 1,
          bounds: bounds(invoicePage),
          headings: [...invoicePage.querySelectorAll('.party-table thead th')].map((cell) => cell.textContent.trim()),
          groups: [...invoicePage.querySelectorAll('tbody.invoice-group')].map((group) => ({
            id: group.dataset.groupKey,
            merged: group.hasAttribute('data-merge-group'),
            bounds: bounds(group),
            rows: [...group.querySelectorAll('tr.data-row')].map((row) => ({
              id: row.dataset.rowId,
              bounds: bounds(row),
              cells: [...row.cells].map((cell) => ({
                text: cell.textContent.trim(),
                rowspan: cell.rowSpan,
                bounds: bounds(cell),
                borders: ['Top', 'Right', 'Bottom', 'Left'].map((side) => getComputedStyle(cell)[`border${side}Width`]),
              })),
            })),
          })),
          summary: invoicePage.querySelector('.invoice-summary') ? bounds(invoicePage.querySelector('.invoice-summary')) : null,
          signatureCells: [...invoicePage.querySelectorAll('.signature-section td')].map(bounds),
        })),
      };
    });
    assert.equal(result.blankRows, 0, `${fixture.id}: artificial blank rows`);
    const observedRows = result.pages.flatMap((p) => p.groups.flatMap((group) => group.rows));
    assert.equal(observedRows.length, fixture.invoice.items.length, `${fixture.id}: missing/extra HTML rows`);
    const observedIds = new Set(observedRows.map((row) => row.id));
    assert.equal(observedIds.size, fixture.invoice.items.length, `${fixture.id}: duplicate HTML rows`);
    for (const invoicePage of result.pages) {
      assert(invoicePage.bounds.height <= 288 * 96 / 25.4, `${fixture.id}: page exceeds printable A4 height`);
      assert.deepEqual(invoicePage.headings, ['SR.', 'PARTY NAME', 'TOWN', 'RL NO', 'CASE', 'CASE']);
      for (const group of invoicePage.groups) {
        assert(group.bounds.bottom <= invoicePage.bounds.bottom + 1, `${fixture.id}: group outside printable page`);
        for (const row of group.rows) {
          assert(row.bounds.right <= invoicePage.bounds.right + 1, `${fixture.id}: row too wide`);
          const original = fixture.invoice.items.find((item) => item.replacementId === row.id || item.replacement === row.id);
          assert(original, `${fixture.id}: unrecognized row ${row.id}`);
          assert.equal(Number(row.cells[4].text), original.receivingCases, `${fixture.id}: wrong Case 1`);
          if (!original.cartonId) {
            assert.equal(row.cells.length, 6, `${fixture.id}: missing individual Case 2 cell`);
            assert.equal(row.cells[5].rowspan, 1);
            assert.equal(Number(row.cells[5].text), original.receivingCases, `${fixture.id}: individual Case 2 != Case 1`);
          }
        }
        if (group.merged) {
          const first = group.rows[0];
          const original = fixture.invoice.items.find((item) => item.replacementId === first.id || item.replacement === first.id);
          const carton = fixture.invoice.cartons.find((candidate) => candidate.masterCartonId === original.cartonId);
          assert.equal(group.rows.length, carton.memberReplacementIds.length, `${fixture.id}: merge split across tables/pages`);
          assert.equal(first.cells.length, 6);
          assert.equal(first.cells[5].rowspan, group.rows.length, `${fixture.id}: incorrect actual rowspan`);
          assert.equal(Number(first.cells[5].text), carton.physicalCaseCount, `${fixture.id}: wrong physical carton count`);
          for (const row of group.rows.slice(1)) assert.equal(row.cells.length, 5, `${fixture.id}: repeated merged Case 2 cell`);
        }
      }
      if (invoicePage.signatureCells.length) {
        assert.equal(invoicePage.signatureCells.length, 3, `${fixture.id}: signature column count`);
        const widths = invoicePage.signatureCells.map((cell) => cell.width);
        assert(Math.max(...widths) - Math.min(...widths) < 1, `${fixture.id}: signature columns unequal`);
      }
    }
    const summaryPages = result.pages.filter((p) => p.summary);
    assert.equal(summaryPages.length, 1, `${fixture.id}: summary should occur once`);
    assert.equal(summaryPages[0].page, result.pages.length, `${fixture.id}: summary is not on final page`);
    const lastPage = result.pages.at(-1);
    const lastGroup = lastPage.groups.at(-1);
    if (lastGroup) {
      const gap = lastPage.summary.y - lastGroup.bounds.bottom;
      assert(gap >= -1 && gap < 5, `${fixture.id}: unexplained footer gap/overlap (${gap}px)`);
    }
    return result;
  } finally {
    await page.close();
  }
};

const inspectPdf = async (pdfjs, canvasModule, fixture, dom) => {
  const pdfPath = path.join(artifactDirectory, `${fixture.id}.pdf`);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(pdfPath)),
    standardFontDataUrl: path.join(inspectionModules, 'pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    assert.equal(document.numPages, dom.pages.length, `${fixture.id}: PDF pagination differs from measured HTML`);
    if (fixture.expectedPages) assert.equal(document.numPages, fixture.expectedPages, `${fixture.id}: unexpected page count`);
    if (fixture.minPages) assert(document.numPages >= fixture.minPages, `${fixture.id}: expected at least ${fixture.minPages} pages`);
    const pages = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      assert(Math.abs(viewport.width - 595.28) < 1 && Math.abs(viewport.height - 841.89) < 1, `${fixture.id}: not A4 portrait`);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => item.str?.trim()).map((item) => ({
        text: item.str.trim(),
        x: item.transform[4],
        y: viewport.height - item.transform[5],
        width: item.width,
        height: item.height,
      }));
      const text = items.map((item) => item.text).join(' ');
      for (const heading of ['SR.', 'PARTY NAME', 'TOWN', 'RL NO']) assert(text.includes(heading), `${fixture.id}: missing page ${index} heading ${heading}`);
      assert(items.filter((item) => item.text === 'CASE').length >= 2, `${fixture.id}: missing repeated CASE headings`);
      assert(!/\b(?:C1|C2|C1-1|Merged)\b/.test(text), `${fixture.id}: merge display references in PDF`);
      for (const item of items) {
        assert(item.x >= 14 && item.x + item.width <= viewport.width - 14, `${fixture.id}: text outside horizontal margins: ${item.text}`);
        assert(item.y - item.height >= 7 && item.y <= viewport.height - 8, `${fixture.id}: text outside vertical margins: ${item.text}`);
      }
      const rasterViewport = page.getViewport({ scale: 1.5 });
      const canvas = canvasModule.createCanvas(Math.ceil(rasterViewport.width), Math.ceil(rasterViewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: rasterViewport }).promise;
      // Check the actual PDF raster at every internal merged-row boundary.
      // Each horizontal border must reach Case 1 and stop before Case 2.
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const dark = (x, y) => {
        if (x < 0 || x >= pixels.width || y < 0 || y >= pixels.height) return false;
        const offset = (Math.round(y) * pixels.width + Math.round(x)) * 4;
        return pixels.data[offset] < 100 && pixels.data[offset + 1] < 100 && pixels.data[offset + 2] < 100;
      };
      const domPage = dom.pages[index - 1];
      const rasterX = (x) => (6 * 72 / 25.4 + (x - domPage.bounds.x) * 0.75) * 1.5;
      const rasterY = (y) => (5 * 72 / 25.4 + (y - domPage.bounds.y) * 0.75) * 1.5;
      const horizontalInk = (x, y) => {
        let maximum = 0;
        for (let dy = -3; dy <= 3; dy += 1) {
          let ink = 0;
          for (let dx = -5; dx <= 5; dx += 1) if (dark(x + dx, y + dy)) ink += 1;
          maximum = Math.max(maximum, ink);
        }
        return maximum;
      };
      for (const group of domPage.groups.filter((candidate) => candidate.merged)) {
        const mergedCell = group.rows[0].cells[5].bounds;
        for (const row of group.rows.slice(0, -1)) {
          const y = rasterY(row.bounds.bottom);
          const case1 = row.cells[4].bounds;
          const present = horizontalInk(rasterX(case1.x + case1.width * 0.2), y);
          const absent = horizontalInk(rasterX(mergedCell.x + mergedCell.width * 0.2), y);
          assert(present >= 8, `${fixture.id}: actual PDF Case 1 row border missing in ${group.id}`);
          assert(absent === 0, `${fixture.id}: actual PDF internal horizontal border crosses merged Case 2 in ${group.id}`);
        }
      }
      const imagePath = path.join(artifactDirectory, `${fixture.id}-page-${index}.png`);
      await fs.writeFile(imagePath, canvas.toBuffer('image/png'));
      pages.push({ page: index, text, items, imagePath });
    }
    const totalPages = pages.filter((page) => page.text.includes('Grand Total'));
    assert.equal(totalPages.length, 1, `${fixture.id}: actual PDF contains missing/duplicate totals`);
    assert.equal(totalPages[0].page, pages.length, `${fixture.id}: actual PDF totals are not final`);
    for (const phrase of ['Terms & Condition', 'For, SHRI HET - ARYA ENTERPRISE', 'Prepared By', 'Approved By', 'Authorized Sign']) {
      const matchingPages = pages.filter((page) => page.text.includes(phrase));
      assert.equal(matchingPages.length, 1, `${fixture.id}: missing/duplicated ${phrase}`);
      assert.equal(matchingPages[0].page, pages.length, `${fixture.id}: ${phrase} not on final page`);
    }
    const totals = expectedTotals(fixture);
    const finalItems = pages.at(-1).items;
    const totalLabel = finalItems.find((item) => item.text.includes('Grand Total'));
    const totalValues = finalItems.filter((item) => /^\d+(?:\.\d+)?$/.test(item.text) && item.x > 595 * 0.73 && Math.abs(item.y - totalLabel.y) < 8)
      .sort((a, b) => a.x - b.x).map((item) => Number(item.text));
    assert.deepEqual(totalValues.slice(-2), [totals.case1, totals.case2], `${fixture.id}: actual PDF totals wrong`);
    const itemPage = new Map();
    for (const item of fixture.invoice.items) {
      const token = item.partyName.split(' ')[0];
      const matches = pages.flatMap((page) => page.items.filter((entry) => entry.text.includes(token)).map((entry) => ({ page: page.page, entry })));
      assert.equal(matches.length, 1, `${fixture.id}: actual PDF row missing/duplicated (${token})`);
      itemPage.set(item.replacement, matches[0].page);
      const endToken = item.partyName.match(/END_[A-Z]+_\d+/)?.[0];
      if (endToken) {
        const endingPages = pages.filter((page) => page.text.includes(endToken));
        assert.equal(endingPages.length, 1, `${fixture.id}: long party name clipped`);
        assert.equal(endingPages[0].page, matches[0].page, `${fixture.id}: long party row split across PDF pages`);
      }
    }
    for (const carton of fixture.invoice.cartons) {
      const memberPages = new Set(carton.memberReplacementIds.map((id) => itemPage.get(id)));
      assert.equal(memberPages.size, 1, `${fixture.id}: actual PDF splits merged group ${carton.masterCartonId}`);
    }
    await fs.writeFile(path.join(artifactDirectory, `${fixture.id}-inspection.json`), JSON.stringify({ totals, dom: { ...dom, html: undefined }, pages }, null, 2));
    return { fixture: fixture.id, rowCount: fixture.invoice.items.length, pageCount: pages.length, totals, images: pages.map((page) => page.imagePath) };
  } finally {
    await loadingTask.destroy();
  }
};

const main = async () => {
  await fs.mkdir(artifactDirectory, { recursive: true });
  const pdfjs = await import(pathToFileURL(path.join(inspectionModules, 'pdfjs-dist/legacy/build/pdf.mjs')).href);
  const canvasModule = require(path.join(inspectionModules, '@napi-rs/canvas'));
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || await puppeteer.executablePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const capacityProbe = makeFixture('PROBE', 90);
    const capacityDom = await inspectHtml(browser, capacityProbe);
    const capacity = capacityDom.pages[0].groups.reduce((sum, group) => sum + group.rows.length, 0);
    assert(capacity > 10, 'Insufficient printable row capacity');
    const a = makeFixture('A', 1, [2]);
    a.expectedPages = 1;
    const b = makeFixture('B', 10, [2, 5, 1, 1, 1, 1, 2, 1, 1, 1]);
    b.expectedPages = 1;
    const c = makeFixture('C', 10, [2, 5, 1, 3, 4]);
    c.invoice.items.forEach((item, index) => {
      item.partyName += ` Long Party Name Wholesale Distribution and Replacement Department END_C_${index + 1}`;
      item.town = index % 2 ? 'Very Long Town District Name' : 'Rajkot';
    });
    c.expectedPages = 1;
    const d = makeFixture('D', 12, [2, 5, 1, 1]);
    merge(d, [0, 1, 2]);
    merge(d, [3, 4]);
    merge(d, [5, 6, 7]);
    d.expectedPages = 1;
    const e = makeFixture('E', Math.min(capacity - 5, 24), [2, 5, 1]);
    merge(e, e.invoice.items.map((_, index) => index));
    e.expectedPages = 1;
    const leadingRows = capacity - 3;
    const f = makeFixture('F', leadingRows + 10 + 4, [2, 1]);
    merge(f, Array.from({ length: 10 }, (_, index) => leadingRows + index));
    f.expectedPages = 2;
    const g = makeFixture('G', capacity * 2 + Math.floor(capacity / 2), [1, 2, 5]);
    merge(g, [5, 6, 7, 8]);
    merge(g, Array.from({ length: 8 }, (_, index) => capacity - 2 + index));
    merge(g, [capacity * 2 - 1, capacity * 2, capacity * 2 + 1]);
    g.minPages = 3;
    // Critical acceptance case: sixteen original cartons, four explicitly
    // merged into one physical carton. CASE 1 / CASE 2 must be 16 / 13.
    const h = makeFixture('H-16-MERGE-4', 16);
    merge(h, [0, 1, 2, 3]);
    h.expectedPages = 1;
    const report = [];
    for (const fixture of [a, b, c, d, e, f, g, h]) {
      const dom = await inspectHtml(browser, fixture);
      if (fixture.id === 'F' || fixture.id === 'G') {
        const screen = await inspectHtml(browser, fixture, 'screen');
        const pageMembership = (document) => document.pages.map((page) => page.groups.map((group) => group.id));
        assert.deepEqual(pageMembership(screen), pageMembership(dom), `${fixture.id}: screen preview/print pagination mismatch`);
      }
      if (fixture.id === 'F') {
        const groupPage = dom.pages.find((page) => page.groups.some((group) => group.merged));
        assert.equal(groupPage.page, 2, 'F: group should move intact to page 2');
        assert(groupPage.groups[0].merged, 'F: moved group should begin page 2');
        const firstPage = dom.pages[0];
        const gap = 288 * 96 / 25.4 - firstPage.bounds.height;
        const groupHeight = groupPage.groups[0].bounds.height;
        assert(gap > firstPage.groups[0].bounds.height && gap < groupHeight, 'F: fixture did not exercise partially available page space');
      }
      await fs.writeFile(path.join(artifactDirectory, `${fixture.id}.html`), dom.html);
      await fs.writeFile(path.join(artifactDirectory, `${fixture.id}-fixture.json`), JSON.stringify(fixture.invoice, null, 2));
      await renderInvoicePdf(fixture.invoice, path.join(artifactDirectory, `${fixture.id}.pdf`));
      const result = await inspectPdf(pdfjs, canvasModule, fixture, dom);
      report.push(result);
      console.log(`${result.fixture}: ${result.rowCount} rows, ${result.pageCount} page(s), totals ${result.totals.case1} / ${result.totals.case2}: PASS`);
    }
    const oversized = makeFixture('OVERSIZED', capacity + 10);
    merge(oversized, oversized.invoice.items.map((_, index) => index));
    await assert.rejects(() => renderInvoicePdf(oversized.invoice, path.join(artifactDirectory, 'OVERSIZED.pdf')), /group|carton|fit|page/i);
    console.log('OVERSIZED: unprintable group rejected without clipping/splitting: PASS');
    const previews = report.flatMap((result) => result.images.map((imagePath, index) => ({ imagePath, label: `${result.fixture} — page ${index + 1} of ${result.pageCount}` })));
    for (let offset = 0; offset < previews.length; offset += 6) {
      const subset = previews.slice(offset, offset + 6);
      const canvas = canvasModule.createCanvas(1260, Math.ceil(subset.length / 3) * 620);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ddd';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < subset.length; index += 1) {
        const preview = subset[index];
        const x = (index % 3) * 420;
        const y = Math.floor(index / 3) * 620;
        context.fillStyle = '#000';
        context.font = '18px Arial';
        context.fillText(preview.label, x + 12, y + 23);
        const image = await canvasModule.loadImage(preview.imagePath);
        context.drawImage(image, x + 8, y + 32, 404, 572);
      }
      await fs.writeFile(path.join(artifactDirectory, `contact-sheet-${Math.floor(offset / 6) + 1}.png`), canvas.toBuffer('image/png'));
    }
    await fs.writeFile(path.join(artifactDirectory, 'report.json'), JSON.stringify({ firstPageRowCapacity: capacity, oversizedGroupRejected: true, fixtures: report }, null, 2));
    console.log(`Actual PDF acceptance artifacts: ${artifactDirectory}`);
  } finally {
    await browser.close();
    await closeBrowser();
  }
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
