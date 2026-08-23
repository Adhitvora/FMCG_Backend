/**
 * Invoice Template Service
 * ───────────────────────
 * Generates the HTML invoice matching the SEE(1).pdf master reference.
 * One single template used for browser preview, print, and PDF generation.
 *
 * KEY DESIGN: The main data table, blank rows, and footer (GSTIN, Terms,
 * Signature) are ALL rendered inside ONE <table> so there is zero gap
 * between the last blank row and the footer rows. All borders align.
 */

const MAX_ROWS = 28; // data + blank rows to fit A4 with footer

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
};

const getCompanySnapshot = (invoice) => {
  const snapshot = invoice.companySnapshot || {};
  const company = invoice.company && typeof invoice.company === 'object' ? invoice.company : {};
  return {
    name: snapshot.name || company.name || invoice.companyName || '',
    address: snapshot.address || company.address || '',
    contact: snapshot.contact || company.contact || '',
    gst: snapshot.gst || company.gst || '',
    email: snapshot.email || company.email || '',
  };
};

const getAddressLines = (address) => String(address || '')
  .split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);

const getActualCases = (item) => Number(
  item.actualCases !== undefined && item.actualCases !== null ? item.actualCases : item.receivingCases || 0,
);

const getGrandTotal = (invoice) => {
  if (invoice.totalActualCases !== undefined && invoice.totalActualCases !== null) return invoice.totalActualCases;
  return (invoice.items || []).reduce((total, item) => total + getActualCases(item), 0);
};

// ─── CASE 2 / Merge Logic ───
const buildDisplayRows = (items) => {
  const groupSizes = new Map();

  items.forEach((item) => {
    const cId = item.cartonId ? String(item.cartonId) : null;
    const isMerged = item.isMergedGroup !== undefined ? item.isMergedGroup : (cId ? true : false);
    if (isMerged && cId) {
      groupSizes.set(cId, (groupSizes.get(cId) || 0) + 1);
    }
  });

  const seen = new Set();

  return items.map((item, index) => {
    const cId = item.cartonId ? String(item.cartonId) : null;
    let isMerged = item.isMergedGroup;
    if (isMerged === undefined) {
      const count = cId ? items.filter(i => String(i.cartonId) === cId).length : 0;
      isMerged = cId && count > 1;
    }

    const key = isMerged ? cId : `single:${index}`;
    const isFirstInGroup = !seen.has(key);
    seen.add(key);

    const groupSize = isMerged ? (groupSizes.get(cId) || 1) : 1;

    let case2Value;
    if (item.case2Value !== undefined && item.case2Value !== null) {
      case2Value = item.case2Value;
    } else if (!isMerged) {
      case2Value = getActualCases(item);
    } else {
      case2Value = 1;
    }

    return { item, index, groupKey: key, isFirstInGroup, groupSize, case2Value, isMerged };
  });
};

const chunkDisplayRows = (rows) => {
  const pages = [];
  let cursor = 0;
  while (cursor < rows.length || pages.length === 0) {
    let end = Math.min(cursor + MAX_ROWS, rows.length);
    if (end < rows.length) {
      const crossingKey = rows[end - 1]?.groupKey;
      while (end > cursor && rows[end]?.groupKey === crossingKey) end -= 1;
      if (end === cursor) end = Math.min(cursor + MAX_ROWS, rows.length);
    }
    pages.push(rows.slice(cursor, end));
    cursor = end;
  }
  return pages;
};

// ─── CSS matching SEE(1).pdf exactly ───
const PRINT_CSS = `
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 210mm; margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Times New Roman", Times, serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}

.invoice-page {
  width: 210mm; height: 297mm; padding: 5mm 6mm 4mm;
  page-break-after: always; break-after: page;
}
.invoice-page:last-child { page-break-after: auto; break-after: auto; }

/* Single outer border frame */
.invoice-frame {
  border: 0.4mm solid #000;
  height: 100%;
  overflow: hidden;
}

/* ── HEADER ── */
.header {
  text-align: center;
  padding: 3mm 3mm 1.5mm;
  border-bottom: 0.4mm solid #000;
}
.header-name {
  font-size: 16pt; font-weight: 700; letter-spacing: 0.5px;
  line-height: 1.15;
}
.header-addr { font-size: 7pt; line-height: 1.35; margin-top: 0.5mm; }
.header-contact { font-size: 7pt; line-height: 1.35; }

/* ── TITLE ROW ── */
.title-row {
  display: flex; border-bottom: 0.4mm solid #000;
  height: 7mm;
}
.title-left {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 11pt; font-weight: 700;
  border-right: 0.4mm solid #000;
}
.title-right {
  width: 28mm; display: flex; align-items: center; justify-content: center;
  font-size: 8.5pt; font-weight: 700;
}

/* ── PARTY + META SECTION ── */
.party-meta {
  display: flex; border-bottom: 0.4mm solid #000;
  min-height: 36mm;
}
.party-left {
  flex: 1; padding: 1.5mm 3mm;
  border-right: 0.4mm solid #000;
  display: flex; flex-direction: column;
}
.party-ms { font-size: 10pt; font-weight: 700; margin-bottom: 1mm; }
.party-line { font-size: 8.5pt; line-height: 1.4; }
.party-line-bold { font-size: 8.5pt; line-height: 1.4; font-weight: 700; margin-top: 1.5mm; }
.party-gst { font-size: 8.5pt; font-weight: 700; margin-top: auto; padding-top: 1mm; }
.meta-right { width: 62mm; display: flex; flex-direction: column; }
.meta-row {
  display: flex; align-items: center;
  border-bottom: 0.4mm solid #000;
  padding: 0 2mm; height: 7mm;
  font-size: 8.5pt; font-weight: 700;
}
.meta-row:last-child { border-bottom: none; }
.meta-label { width: 26mm; }
.meta-value { flex: 1; }
.meta-empty { flex: 1; }

/* ── SINGLE TABLE for data + blanks + footer ── */
table.inv {
  width: 100%; border-collapse: collapse; table-layout: fixed; border-spacing: 0;
}
table.inv th, table.inv td {
  border: 0.4mm solid #000;
  padding: 0.4mm 1.2mm;
  font-size: 9pt; line-height: 1.15;
  vertical-align: middle;
  overflow-wrap: break-word; word-break: normal;
}
/* Remove outer borders that duplicate the frame border */
table.inv th:first-child, table.inv td:first-child { border-left: none; }
table.inv th:last-child, table.inv td:last-child { border-right: none; }
table.inv thead tr:first-child th { border-top: none; }
table.inv tbody tr:last-child td { border-bottom: none; }

table.inv th { text-align: center; font-weight: 700; font-size: 9.5pt; }
table.inv .c { text-align: center; }
table.inv .merged-cell { text-align: center; font-weight: 700; vertical-align: middle; }

/* Fixed row heights */
table.inv .data-row td,
table.inv .blank-row td { height: 6.4mm; }
table.inv .blank-row td { color: transparent; }

/* Column widths: SR | PARTY NAME | TOWN | RL NO | CASE1 | CASE2 */
table.inv col:nth-child(1) { width: 8%; }
table.inv col:nth-child(2) { width: 35%; }
table.inv col:nth-child(3) { width: 17%; }
table.inv col:nth-child(4) { width: 16%; }
table.inv col:nth-child(5) { width: 12%; }
table.inv col:nth-child(6) { width: 12%; }

/* ── FOOTER ROWS (inside same table) ── */
table.inv .gstin-row td {
  height: 7mm; vertical-align: middle; font-weight: 700; font-size: 9pt;
  padding: 0 1.5mm;
}
table.inv .terms-row td {
  height: 24mm; vertical-align: top; padding: 1.5mm 2mm;
  font-size: 8pt; line-height: 1.55;
}
.terms-title { font-weight: 700; font-size: 8.5pt; margin-bottom: 0.5mm; }
.terms-text { font-size: 7.5pt; line-height: 1.5; }
.company-sig {
  text-align: right; font-weight: 700; font-size: 8.5pt;
  display: flex; flex-direction: column;
  align-items: flex-end; justify-content: flex-end;
  height: 100%; padding-bottom: 1mm;
}
table.inv {
  width: 100%;
  table-layout: fixed;
}

table.inv .sig-row td {
  width: 33.333%;
  height: 14mm;
  text-align: center;
  vertical-align: middle;
  font-size: 8pt;
  font-weight: 700;
}

.continued {
  text-align: center; padding: 4mm 0;
  font-size: 9pt; font-weight: 700;
  border-top: 0.4mm solid #000;
}
`;

// ─── Render Functions ───

const renderHeader = () => {
  const name = process.env.INVOICE_BUSINESS_NAME || 'SHRI HET - ARYA ENTERPRISE';
  const addr = process.env.INVOICE_BUSINESS_ADDRESS || 'A-4,Urja Commercial Park B/h. Audi Showroom Navsarjan Main Road. Rajkot,Gujarat,360003';
  const contact = process.env.INVOICE_BUSINESS_CONTACT || 'Mo.: 95737251254 / 9898731732 ~ Email : hetarya@gmail.com - www.hetarya.com';
  return `<div class="header"><div class="header-name">${escapeHtml(name)}</div><div class="header-addr">${escapeHtml(addr)}</div><div class="header-contact">${escapeHtml(contact)}</div></div>`;
};

const renderTitleRow = () =>
  '<div class="title-row"><div class="title-left">REPLACEMENT PARTY LIST</div><div class="title-right">ORIGINAL</div></div>';

const renderPartyMeta = (invoice, companySnap) => {
  const addrLines = getAddressLines(companySnap.address);
  const allAddrLines = addrLines.length > 1 ? addrLines.slice(0, -1) : addrLines;
  const cityLine = addrLines.length > 1 ? addrLines[addrLines.length - 1] : '';

  return [
    '<div class="party-meta">',
    '  <div class="party-left">',
    `    <div class="party-ms">M/S. ${escapeHtml(companySnap.name)}</div>`,
    allAddrLines.map(line => `    <div class="party-line">${escapeHtml(line)}</div>`).join(''),
    companySnap.contact ? `    <div class="party-line">Mobile No.:+91 ${escapeHtml(companySnap.contact.replace(/^\+91\s*/, '').trim())}</div>` : '',
    cityLine ? `    <div class="party-line-bold">${escapeHtml(cityLine)}</div>` : '',
    `    <div class="party-gst">GSTIN No.  ${escapeHtml(companySnap.gst || 'COMPNYGSTNUMBER')}</div>`,
    '  </div>',
    '  <div class="meta-right">',
    `    <div class="meta-row"><span class="meta-label">DATE :</span><span class="meta-value">${escapeHtml(formatDate(invoice.invoiceDate))}</span></div>`,
    `    <div class="meta-row"><span class="meta-label">INVOICE NO :</span><span class="meta-value">${escapeHtml(invoice.invoiceNumber || '')}</span></div>`,
    `    <div class="meta-row"><span class="meta-label">TRANSPORT :</span><span class="meta-value">${escapeHtml(invoice.transportName || '')}</span></div>`,
    '    <div class="meta-empty"></div>',
    '  </div>',
    '</div>',
  ].join('\n');
};

const renderDataRow = (row, sr) => {
  const item = row.item;
  let case2Cell = '';
  if (row.isFirstInGroup) {
    const rowspanAttr = row.groupSize > 1 ? ` rowspan="${row.groupSize}"` : '';
    case2Cell = `<td${rowspanAttr} class="merged-cell">${escapeHtml(row.case2Value)}</td>`;
  }
  return `<tr class="data-row"><td class="c">${sr}</td><td>${escapeHtml(item.partyName || '')}</td><td>${escapeHtml(item.town || '')}</td><td class="c">${escapeHtml(item.lrNo || '')}</td><td class="c">${getActualCases(item)}</td>${case2Cell}</tr>`;
};

const renderBlankRow = () =>
  '<tr class="blank-row"><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>';

const renderFooterRows = (invoice, companySnap, allRows) => {
  const businessName = process.env.INVOICE_BUSINESS_NAME || 'SHRI HET - ARYA ENTERPRISE';
  const businessGst = companySnap.gst || process.env.INVOICE_BUSINESS_GST || '24ABPFS1872C1Z5';
  const totalCase1 = getGrandTotal(invoice);

  let totalCase2 = invoice.totalCase2;
  if (totalCase2 === undefined || totalCase2 === null) {
    totalCase2 = allRows.filter(r => r.isFirstInGroup).reduce((sum, r) => sum + Number(r.case2Value || 0), 0);
  }

  return [
    // GSTIN + Grand Total row
    '<tr class="gstin-row">',
    `  <td colspan="3" style="padding-left:2mm;"><strong>GSTIN No.: ${escapeHtml(businessGst)}</strong></td>`,
    '  <td class="c"><strong>Grand Total Case</strong></td>',
    `  <td class="c"><strong>${escapeHtml(totalCase1)}</strong></td>`,
    `  <td class="c"><strong>${escapeHtml(totalCase2)}</strong></td>`,
    '</tr>',
    // Terms + Company Signature row
    '<tr class="terms-row">',
    '  <td colspan="3">',
    '    <div class="terms-title">Terms &amp; Condition :</div>',
    '    <div class="terms-text">1.The company is responsible for matching this list with the replacement shipment.</div>',
    '    <div class="terms-text">2.Please inform the company after receiving the replacement shipment.</div>',
    '    <div class="terms-text">3.Please report any missing cases to the company.</div>',
    '  </td>',
    '  <td colspan="2">',
    `    <div class="company-sig">For, ${escapeHtml(businessName)}</div>`,
    '  </td>',
    '</tr>',
    // Signature row
    '<tr class="sig-row">',
    '  <td colspan="2">Prepared By :</td>',
    '  <td colspan="2">Approved By :</td>',
    '  <td colspan="2">Authorized Sign</td>',
    '</tr>',
  ].join('\n');
};

/**
 * Renders ONE complete table: thead + data rows + blank rows + footer rows.
 * This ensures there is ZERO gap between blank rows and the footer.
 * All borders are continuous and column widths are shared.
 */
const renderFullTable = (rows, startIndex, blankRowCount, invoice, companySnap, allRows, isLastPage) => {
  const dataHtml = rows.map((row, i) => renderDataRow(row, startIndex + i + 1)).join('');
  const blanksHtml = Array.from({ length: Math.max(0, blankRowCount) }, () => renderBlankRow()).join('');

  const footerHtml = isLastPage
    ? renderFooterRows(invoice, companySnap, allRows)
    : '';

  return [
    '<table class="inv">',
    '<colgroup><col><col><col><col><col><col></colgroup>',
    '<thead><tr><th>SR.</th><th>PARTY NAME</th><th>TOWN</th><th>RL NO</th><th>CASE</th><th>CASE</th></tr></thead>',
    '<tbody>',
    dataHtml,
    blanksHtml,
    footerHtml,
    '</tbody>',
    '</table>',
  ].join('');
};

const renderPage = (invoice, rows, startIndex, pageIndex, isLastPage, allRows) => {
  const companySnap = getCompanySnapshot(invoice);
  const blankRowCount = Math.max(0, MAX_ROWS - rows.length);

  const parts = [
    '<section class="invoice-page">',
    '<div class="invoice-frame">',
    renderHeader(),
    renderTitleRow(),
    renderPartyMeta(invoice, companySnap),
    renderFullTable(rows, startIndex, blankRowCount, invoice, companySnap, allRows, isLastPage),
    isLastPage ? '' : '<div class="continued">Continued on next page...</div>',
    '</div>',
    '</section>',
  ];

  return parts.filter(Boolean).join('');
};

const buildInvoiceHtml = (invoice) => {
  const rows = buildDisplayRows(Array.isArray(invoice.items) ? invoice.items : []);
  const pages = chunkDisplayRows(rows);
  let startIndex = 0;
  const htmlPages = pages.map((pageRows, pageIndex) => {
    const html = renderPage(invoice, pageRows, startIndex, pageIndex, pageIndex === pages.length - 1, rows);
    startIndex += pageRows.length;
    return html;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>${htmlPages.join('')}</body></html>`;
};

module.exports = { MAX_ROWS, buildDisplayRows, buildInvoiceHtml };
