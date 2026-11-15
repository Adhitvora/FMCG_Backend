/** Shared replacement invoice template for HTML preview, printing and Chromium PDF. */
const { buildInvoiceData } = require('./invoiceData.service');
const { paginateInvoice } = require('./invoicePagination.service');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const formatDate = (value) => {
  if (!value) return '';
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
  };
};

// Section joins have one border owner. Tables use only collapsed cell borders.
const PRINT_CSS = `
@page { size: A4 portrait; margin: 5mm 6mm 4mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Times New Roman", Times, serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.invoice { width: 198mm; margin: 0 auto; }
.invoice-page { width: 198mm; break-after: page; page-break-after: always; }
.invoice-page:last-child { break-after: auto; page-break-after: auto; }
.invoice-header { text-align: center; padding: 3mm 3mm 1.5mm; border: 1px solid #000; }
.header-name { font-size: 16pt; font-weight: 700; letter-spacing: .5px; line-height: 1.15; }
.header-addr, .header-contact { font-size: 7pt; line-height: 1.35; }
.header-addr { margin-top: .5mm; }
.title-row { display: flex; border: 1px solid #000; border-top: 0; min-height: 7mm; }
.title-left { flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 11pt; font-weight: 700; border-right: 1px solid #000; }
.title-right { width: 28mm; display: flex; align-items: center; justify-content: center;
  font-size: 8.5pt; font-weight: 700; }
.party-details { display: flex; border: 1px solid #000; border-top: 0; min-height: 36mm; }
.party-left { flex: 1; min-width: 0; padding: 1.5mm 3mm; border-right: 1px solid #000;
  display: flex; flex-direction: column; overflow-wrap: anywhere; }
.party-ms { font-size: 10pt; font-weight: 700; margin-bottom: 1mm; }
.party-line { font-size: 8.5pt; line-height: 1.4; }
.party-line-bold { font-size: 8.5pt; line-height: 1.4; font-weight: 700; margin-top: 1.5mm; }
.party-gst { font-size: 8.5pt; font-weight: 700; margin-top: auto; padding-top: 1mm; }
.meta-right { width: 62mm; display: flex; flex-direction: column; }
.meta-row { display: flex; align-items: center; border-bottom: 1px solid #000;
  padding: 1mm 2mm; min-height: 7mm; font-size: 8.5pt; font-weight: 700; }
.meta-label { width: 26mm; flex-shrink: 0; }
.meta-value { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.meta-empty { flex: 1; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; border-spacing: 0; }
th, td { border: 1px solid #000; padding: 1.2mm; font-size: 9pt; line-height: 1.25;
  vertical-align: middle; overflow-wrap: anywhere; word-break: normal; }
.party-table thead { display: table-header-group; }
.party-table thead th { border-top: 0; text-align: center; font-size: 9.5pt; font-weight: 700; }
.invoice-columns col:nth-child(1) { width: 6%; }
.invoice-columns col:nth-child(2) { width: 40%; }
.invoice-columns col:nth-child(3) { width: 17%; }
.invoice-columns col:nth-child(4) { width: 17%; }
.invoice-columns col:nth-child(5), .invoice-columns col:nth-child(6) { width: 10%; }
.c, .case2-cell { text-align: center; }
.case2-cell { vertical-align: middle; font-weight: 700; }
/* The rowspan owns the Case 2 area. Normal collapsed borders continue only
   through the other five cells, with no inset/double border artefacts. */
.merge-group .data-row:not(:last-child) td:not(.case2-cell) { border-bottom: 1px solid #000; }
.invoice-group, .data-row { break-inside: avoid; page-break-inside: avoid; }
.invoice-footer, .terms, .signature-section { break-inside: avoid; page-break-inside: avoid; }
.invoice-summary td { border-top: 0; font-weight: 700; padding: 1.5mm; }
.terms { border: 1px solid #000; border-top: 0; padding: 1.5mm 2mm; }
.terms-title { font-size: 8.5pt; font-weight: 700; margin-bottom: .5mm; }
.terms-text { font-size: 7.5pt; line-height: 1.5; }
.company-footer { border: 1px solid #000; border-top: 0; padding: 2mm;
  text-align: right; font-size: 8.5pt; font-weight: 700; }
.signature-section col { width: 33.333333%; }
.signature-section td { border-top: 0; height: 14mm; text-align: center;
  font-size: 8pt; font-weight: 700; vertical-align: middle; }
.pagination-error { padding: 4mm; color: #a00000; font-size: 11pt; }
@media screen { body { padding: 5mm 0 4mm; } .invoice-page + .invoice-page { margin-top: 9mm; } }
`;

const renderHeader = () => {
  const name = process.env.INVOICE_BUSINESS_NAME || 'SHRI HET - ARYA ENTERPRISE';
  const address = process.env.INVOICE_BUSINESS_ADDRESS || 'A-4,Urja Commercial Park B/h. Audi Showroom Navsarjan Main Road. Rajkot,Gujarat,360003';
  const contact = process.env.INVOICE_BUSINESS_CONTACT || 'Mo.: 95737251254 / 9898731732 ~ Email : hetarya@gmail.com - www.hetarya.com';
  return `<header class="invoice-header"><div class="header-name">${escapeHtml(name)}</div><div class="header-addr">${escapeHtml(address)}</div><div class="header-contact">${escapeHtml(contact)}</div></header>
    <div class="title-row"><div class="title-left">REPLACEMENT PARTY LIST</div><div class="title-right">ORIGINAL</div></div>`;
};

const renderPartyDetails = (invoice, company) => {
  const lines = String(company.address).split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
  const addressLines = lines.length > 1 ? lines.slice(0, -1) : lines;
  const city = lines.length > 1 ? lines[lines.length - 1] : '';
  return `<div class="party-details">
    <div class="party-left">
      <div class="party-ms">M/S. ${escapeHtml(company.name)}</div>
      ${addressLines.map((line) => `<div class="party-line">${escapeHtml(line)}</div>`).join('')}
      ${company.contact ? `<div class="party-line">Mobile No.:+91 ${escapeHtml(String(company.contact).replace(/^\+91\s*/, '').trim())}</div>` : ''}
      ${city ? `<div class="party-line-bold">${escapeHtml(city)}</div>` : ''}
      <div class="party-gst">GSTIN No. ${escapeHtml(company.gst)}</div>
    </div>
    <div class="meta-right">
      <div class="meta-row"><span class="meta-label">DATE :</span><span class="meta-value">${escapeHtml(formatDate(invoice.invoiceDate))}</span></div>
      <div class="meta-row"><span class="meta-label">INVOICE NO :</span><span class="meta-value">${escapeHtml(invoice.invoiceNumber)}</span></div>
      <div class="meta-row"><span class="meta-label">TRANSPORT :</span><span class="meta-value">${escapeHtml(invoice.transportName)}</span></div>
      <div class="meta-empty"></div>
    </div>
  </div>`;
};

const columns = '<colgroup class="invoice-columns"><col><col><col><col><col><col></colgroup>';

const renderGroups = (groups) => {
  let serial = 0;
  return groups.map((group) => `<tbody class="invoice-group${group.isMerged ? ' merge-group' : ''}" data-group-key="${escapeHtml(group.key)}"${group.isMerged ? ` data-merge-group="${escapeHtml(group.key)}"` : ''}>
    ${group.rows.map(({ item, case1, case2, renderCase2, case2Rowspan }) => {
      serial += 1;
      const case2Cell = renderCase2 ? `<td class="case2-cell"${case2Rowspan > 1 ? ` rowspan="${case2Rowspan}"` : ''}>${escapeHtml(case2)}</td>` : '';
      return `<tr class="data-row" data-row-id="${escapeHtml(item.replacementId || item.replacement || serial)}"><td class="c">${serial}</td><td>${escapeHtml(item.partyName)}</td><td>${escapeHtml(item.town)}</td><td class="c">${escapeHtml(item.lrNo)}</td><td class="c case1-cell">${escapeHtml(case1)}</td>${case2Cell}</tr>`;
    }).join('')}
  </tbody>`).join('');
};

const renderFooter = (company, data) => {
  const businessName = process.env.INVOICE_BUSINESS_NAME || 'SHRI HET - ARYA ENTERPRISE';
  const gst = company.gst || process.env.INVOICE_BUSINESS_GST || '24ABPFS1872C1Z5';
  return `<footer class="invoice-footer">
    <table class="invoice-summary">${columns}<tbody><tr>
      <td colspan="3">GSTIN No.: ${escapeHtml(gst)}</td><td class="c">Grand Total Case</td>
      <td class="c total-case1">${escapeHtml(data.totalCase1)}</td><td class="c total-case2">${escapeHtml(data.totalCase2)}</td>
    </tr></tbody></table>
    <section class="terms terms-section">
      <div class="terms-title">Terms &amp; Condition :</div>
      <div class="terms-text">1.The company is responsible for matching this list with the replacement shipment.</div>
      <div class="terms-text">2.Please inform the company after receiving the replacement shipment.</div>
      <div class="terms-text">3.Please report any missing cases to the company.</div>
    </section>
    <div class="company-footer">For, ${escapeHtml(businessName)}</div>
    <table class="signature-section"><colgroup><col><col><col></colgroup><tbody><tr>
      <td>Prepared By :</td><td>Approved By :</td><td>Authorized Sign</td>
    </tr></tbody></table>
  </footer>`;
};

const buildInvoiceHtml = (invoice) => {
  const data = buildInvoiceData(invoice);
  const company = getCompanySnapshot(invoice);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(invoice.invoiceNumber)}</title><style>${PRINT_CSS}</style></head>
    <body><main class="invoice"><section class="invoice-page">
      ${renderHeader()}${renderPartyDetails(invoice, company)}
      <table class="party-table">${columns}<thead><tr><th>SR.</th><th>PARTY NAME</th><th>TOWN</th><th>RL NO</th><th>CASE</th><th>CASE</th></tr></thead>${renderGroups(data.groups)}</table>
      ${renderFooter(company, data)}
    </section></main><script>
      window.invoicePaginationReady = document.fonts.ready.then(${paginateInvoice.toString()}).catch(function(error) {
        window.invoicePaginationError = error.message;
        var message = document.createElement('p');
        message.className = 'pagination-error'; message.textContent = error.message;
        document.querySelector('.invoice').replaceChildren(message);
        return { error: error.message };
      });
    </script></body></html>`;
};

module.exports = { buildInvoiceHtml };
