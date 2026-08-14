const MAX_ROWS = 22;

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

const getCompany = (invoice) => {
  const snapshot = invoice.companySnapshot || {};
  const company = invoice.company && typeof invoice.company === 'object' ? invoice.company : {};
  return {
    name: snapshot.name || company.name || invoice.companyName || '',
    address: snapshot.address || company.address || '',
    contact: snapshot.contact || company.contact || '',
    gst: snapshot.gst || company.gst || '',
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

const getCartonKey = (item, index) => {
  const cartonId = item.cartonId || item.masterCartonId;
  if (cartonId) return `carton:${cartonId}`;
  const groupNumber = item.cartonGroupNumber || item.cartonDisplayValue;
  if (groupNumber) return `group:${groupNumber}`;
  return `single:${item.replacement || item.replacementId || index}`;
};

const buildDisplayRows = (items) => {
  const seen = new Set();
  const groupSizes = new Map();

  items.forEach((item, index) => {
    let isMerged = item.isMergedGroup;
    if (isMerged === undefined) {
      const cId = item.cartonId ? String(item.cartonId) : null;
      isMerged = cId ? true : false;
    }

    if (isMerged && item.cartonId) {
      const key = String(item.cartonId);
      groupSizes.set(key, (groupSizes.get(key) || 0) + 1);
    }
  });

  return items.map((item, index) => {
    let isMerged = item.isMergedGroup;
    if (isMerged === undefined) {
      const cId = item.cartonId ? String(item.cartonId) : null;
      const count = cId ? items.filter(i => String(i.cartonId) === cId).length : 0;
      isMerged = cId && count > 1;
    }

    const key = isMerged ? String(item.cartonId) : `single:${index}`;
    const isFirstInGroup = !seen.has(key);
    seen.add(key);

    const groupSize = isMerged ? (groupSizes.get(key) || 1) : 1;

    let case2Value = item.case2Value;
    if (case2Value === undefined || case2Value === null) {
      case2Value = isMerged ? 1 : getActualCases(item);
    }

    return {
      item,
      index,
      groupKey: key,
      isFirstInGroup,
      groupSize,
      case2Value,
    };
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

const PRINT_CSS = `
:root { --invoice-border: 0.25mm solid #000; }
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html, body {
  width: 210mm; min-height: 297mm; margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Times New Roman", Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.invoice-page { width: 210mm; min-height: 297mm; padding: 6mm 7mm 5mm; page-break-after: always; break-after: page; }
.invoice-page:last-child { page-break-after: auto; break-after: auto; }
.invoice-frame { border: var(--invoice-border); min-height: 286mm; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; }
.business-header { text-align: center; padding: 2mm 3mm 1.5mm; border-bottom: var(--invoice-border); box-sizing: border-box; }
.business-name { font-size: 15pt; font-weight: 700; line-height: 1.15; }
.business-address, .business-contact { font-size: 7.5pt; line-height: 1.35; }
.title-row { display: flex; height: 7mm; border-bottom: var(--invoice-border); box-sizing: border-box; }
.title-left { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 11pt; font-weight: 700; border-right: var(--invoice-border); box-sizing: border-box; }
.title-right { width: 30mm; display: flex; align-items: center; justify-content: center; font-size: 8.5pt; font-weight: 700; }
.party-section { display: flex; min-height: 42mm; border-bottom: var(--invoice-border); box-sizing: border-box; }
.party-panel { flex: 1; padding: 2mm 3mm; border-right: var(--invoice-border); display: flex; flex-direction: column; box-sizing: border-box; }
.party-name-container { font-size: 11pt; font-weight: 700; margin-bottom: 2mm; display: flex; gap: 1mm; }
.party-address-line, .party-contact, .city-line { font-size: 9pt; line-height: 1.45; }
.city-line { font-weight: 700; margin-top: 2mm; }
.party-gst { margin-top: auto; font-size: 9pt; font-weight: 700; }
.meta-panel { width: 72mm; display: flex; flex-direction: column; }
.meta-row { display: flex; align-items: center; border-bottom: var(--invoice-border); padding: 0 3mm; min-height: 7mm; font-size: 9pt; font-weight: 700; box-sizing: border-box; }
.meta-empty { flex: 1; }
.meta-label { width: 31mm; }
.table-wrap { flex: 1; }
.invoice-table { width: 100%; border-collapse: collapse; table-layout: fixed; border-spacing: 0; border-style: hidden; }
.invoice-table th, .invoice-table td {
  border: var(--invoice-border); padding: 0.6mm 1.2mm; height: 6.7mm; min-height: 6.7mm;
  font-size: 9.5pt; line-height: 1.12; vertical-align: middle; overflow-wrap: break-word; word-break: normal; box-sizing: border-box;
}
.invoice-table th { text-align: center; font-weight: 700; }
.invoice-table .center, .invoice-table .merged-carton-cell { text-align: center; }
.invoice-table .merged-carton-cell { font-weight: 700; vertical-align: middle; }
.invoice-table .blank td { color: transparent; }
.invoice-table col:nth-child(1) { width: 10mm; }
.invoice-table col:nth-child(2) { width: 76.5mm; }
.invoice-table col:nth-child(3) { width: 35mm; }
.invoice-table col:nth-child(4) { width: 30mm; }
.invoice-table col:nth-child(5) { width: 22mm; }
.invoice-table col:nth-child(6) { width: 22mm; }

.invoice-footer { width: 100%; border-collapse: collapse; table-layout: fixed; border-spacing: 0; border-style: hidden; }
.invoice-footer td { border: var(--invoice-border); box-sizing: border-box; }
.invoice-footer col:nth-child(1) { width: 10mm; }
.invoice-footer col:nth-child(2) { width: 76.5mm; }
.invoice-footer col:nth-child(3) { width: 35mm; }
.invoice-footer col:nth-child(4) { width: 30mm; }
.invoice-footer col:nth-child(5) { width: 22mm; }
.invoice-footer col:nth-child(6) { width: 22mm; }

.footer-total-row td { height: 7mm; font-size: 9pt; padding: 0 1.2mm; }
.gstin-cell { padding-left: 2mm !important; }
.footer-main-row td { height: 26mm; vertical-align: top; padding: 1.5mm 2mm; font-size: 8pt; line-height: 1.55; }
.terms-title { font-weight: 700; }
.company-sign-cell { position: relative; }
.for-company { position: absolute; bottom: 2mm; right: 3mm; font-size: 9pt; font-weight: 700; text-align: right; }
.signature-row td { height: 10mm; vertical-align: middle; font-size: 8.5pt; font-weight: 700; text-align: center; }

.continued { text-align: center; padding: 5mm 0; font-size: 9pt; font-weight: 700; border-top: var(--invoice-border); box-sizing: border-box; }
`;

const renderHeader = () => {
  const businessName = process.env.INVOICE_BUSINESS_NAME || 'SHRI HET - ARYA ENTERPRISE';
  const businessAddress = process.env.INVOICE_BUSINESS_ADDRESS || 'A-4 Urja Commercial Park, B/h. Audi Showroom, Navsarjan Main Road, Rajkot, Gujarat 360005';
  const businessContact = process.env.INVOICE_BUSINESS_CONTACT || 'Mo.: 9737351254, 9998757976 - Email: hetarya@gmail.com - www.hetarya.com';
  return `<div class="business-header"><div class="business-name">${escapeHtml(businessName)}</div><div class="business-address">${escapeHtml(businessAddress)}</div><div class="business-contact">${escapeHtml(businessContact)}</div></div>`;
};

const renderTitleRow = () => '<div class="title-row"><div class="title-left">REPLACEMENT PARTY LIST</div><div class="title-right">ORIGINAL</div></div>';

const renderPartyInfo = (invoice, company) => {
  const lines = getAddressLines(company.address);
  const addressLines = lines.length > 1 ? lines.slice(0, -1) : lines;
  const cityLine = lines.length > 1 ? lines[lines.length - 1] : '';
  return [
    '<div class="party-section"><div class="party-panel">',
    `<div class="party-name-container"><span>M/S.</span><span>${escapeHtml(company.name)}</span></div>`,
    addressLines.map((line) => `<div class="party-address-line">${escapeHtml(line)}</div>`).join(''),
    company.contact ? `<div class="party-contact">Mobile No.:+91 ${escapeHtml(company.contact.replace('+91', '').trim())}</div>` : '',
    cityLine ? `<div class="city-line">${escapeHtml(cityLine)}</div>` : '',
    `<div class="party-gst">GSTIN No. ${escapeHtml(company.gst || 'COMPNYGSTNUMBER')}</div>`,
    '</div><div class="meta-panel">',
    `<div class="meta-row"><span class="meta-label">DATE :</span><span>${escapeHtml(formatDate(invoice.invoiceDate))}</span></div>`,
    `<div class="meta-row"><span class="meta-label">INVOICE NO :</span><span>${escapeHtml(invoice.invoiceNumber)}</span></div>`,
    `<div class="meta-row"><span class="meta-label">TRANSPORT :</span><span>${escapeHtml(invoice.transportName || '')}</span></div>`,
    '<div class="meta-empty"></div>',
    '</div></div>',
  ].join('');
};

const renderDataRow = (row, sr) => {
  const item = row.item;

  let cartonCell = '';
  if (row.isFirstInGroup) {
    const rowspanAttr = row.groupSize > 1 ? ` rowspan="${row.groupSize}"` : '';
    cartonCell = `<td${rowspanAttr} class="merged-carton-cell">${escapeHtml(row.case2Value)}</td>`;
  }

  return `<tr><td class="center">${sr}</td><td>${escapeHtml(item.partyName || '')}</td><td>${escapeHtml(item.town || '')}</td><td class="center">${escapeHtml(item.lrNo || '')}</td><td class="center">${getActualCases(item)}</td>${cartonCell}</tr>`;
};

const renderTable = (rows, startIndex, blankRows) => {
  const body = rows.map((row, index) => renderDataRow(row, startIndex + index + 1)).join('');
  const blanks = Array.from({ length: Math.max(0, blankRows) }, () => '<tr class="blank"><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');
  
  return `<div class="table-wrap"><table class="invoice-table"><colgroup><col><col><col><col><col><col></colgroup><thead><tr><th>SR.</th><th>PARTY NAME</th><th>TOWN</th><th>RL NO</th><th>CASE</th><th>CASE</th></tr></thead><tbody>${body}${blanks}</tbody></table></div>`;
};

const renderFooter = (invoice, company, allRows) => {
  const businessName = process.env.INVOICE_BUSINESS_NAME || 'SHRI HET - ARYA ENTERPRISE';
  const totalCases = getGrandTotal(invoice);
  let totalCartons = invoice.totalCase2;

  if (totalCartons === undefined || totalCartons === null) {
    totalCartons = allRows.filter(r => r.isFirstInGroup).reduce((sum, r) => sum + r.case2Value, 0);
  }

  return `<table class="invoice-footer">
    <colgroup><col><col><col><col><col><col></colgroup>
    <tbody>
        <tr class="footer-total-row">
            <td colspan="3" class="gstin-cell">
                <strong>GSTIN No.: ${escapeHtml(company.gst || process.env.INVOICE_BUSINESS_GST || '24ABPFS1872C1Z5')}</strong>
            </td>
            <td class="center">
                <strong>Grand Total Case</strong>
            </td>
            <td class="center">
                <strong>${escapeHtml(totalCases)}</strong>
            </td>
            <td class="center">
                <strong>${escapeHtml(totalCartons)}</strong>
            </td>
        </tr>
        <tr class="footer-main-row">
            <td colspan="4">
                <div class="terms-title">Terms &amp; Condition :</div>
                <div>1. The company is responsible for matching this list with the replacement shipment.</div>
                <div>2. Please inform the company after receiving the replacement shipment.</div>
                <div>3. Please report any missing cases to the company.</div>
            </td>
            <td colspan="2" class="company-sign-cell">
                <div class="for-company">For, ${escapeHtml(businessName)}</div>
            </td>
        </tr>
        <tr class="signature-row">
            <td colspan="2">Prepared By :</td>
            <td colspan="2">Approved By :</td>
            <td colspan="2">Authorized Sign</td>
        </tr>
    </tbody>
  </table>`;
};

const renderPage = (invoice, rows, startIndex, pageIndex, isLastPage, allRows) => {
  const company = getCompany(invoice);
  const blankRows = MAX_ROWS - rows.length;
  return `<section class="invoice-page"><div class="invoice-frame">${renderHeader()}${renderTitleRow()}${renderPartyInfo(invoice, company)}${renderTable(rows, startIndex, blankRows)}${isLastPage ? renderFooter(invoice, company, allRows) : '<div class="continued">Continued on next page...</div>'}</div></section>`;
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
