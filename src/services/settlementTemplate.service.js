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
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
};

const formatCurrency = (value) => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
}).format(Number(value || 0));

const companyName = () => process.env.INVOICE_BUSINESS_NAME || 'HET ARYA ENTERPRISE';
const companyAddress = () => process.env.INVOICE_BUSINESS_ADDRESS || 'A-4 Urja Commercial Park, B/h. Audi Showroom, Navsarjan Main Road, Rajkot, Gujarat 360005';
const companyContact = () => process.env.INVOICE_BUSINESS_CONTACT || 'Mo.: 9737351254, 9998757976 - Email: hetarya@gmail.com';

const getPopulated = (value) => (value && typeof value === 'object' ? value : {});

const rowsOrEmpty = (rows, columns, emptyText) => {
  if (!rows.length) return `<tr><td colspan="${columns}" class="empty">${escapeHtml(emptyText)}</td></tr>`;
  return rows.join('');
};

const buildSettlementHtml = (settlement) => {
  const replacement = getPopulated(settlement.replacementId);
  const party = getPopulated(settlement.partyId);
  const company = getPopulated(settlement.companyId);
  const invoice = getPopulated(settlement.invoiceId);
  const receivingTransport = getPopulated(replacement.receivingTransport);
  const dispatchTransport = getPopulated(replacement.dispatchTransport);

  const approvedRows = rowsOrEmpty((settlement.approvedProducts || []).map((product) => `
    <tr>
      <td>${escapeHtml(product.productName)}</td>
      <td class="num">${escapeHtml(product.quantity || '')}</td>
      <td class="num">${product.mrp ? formatCurrency(product.mrp) : ''}</td>
      <td class="num">${formatCurrency(product.value || product.calculatedValue)}</td>
    </tr>
  `), 4, 'No product rows. Amount approval applies.');

  const sentRows = rowsOrEmpty((settlement.sentProducts || []).map((product) => `
    <tr>
      <td>${escapeHtml(product.productName)}</td>
      <td class="num">${formatCurrency(product.mrp)}</td>
      <td class="num">${escapeHtml(product.quantity)} ${escapeHtml(product.unit || 'pcs')}</td>
      <td class="num">${formatCurrency(product.value || product.calculatedValue)}</td>
    </tr>
  `), 4, 'No sent products recorded.');

  const matchRows = rowsOrEmpty((settlement.matchDetails || []).map((row) => `
    <tr>
      <td>${escapeHtml(row.approvedProduct || '-')}</td>
      <td>${escapeHtml(row.sentProduct || '-')}</td>
      <td class="num">${escapeHtml(row.approvedQty || 0)}</td>
      <td class="num">${escapeHtml(row.sentQty || 0)}</td>
      <td class="num">${formatCurrency(row.approvedValue)}</td>
      <td class="num">${formatCurrency(row.sentValue)}</td>
      <td class="num">${formatCurrency(row.difference)}</td>
      <td>${escapeHtml(row.matchStatus)}</td>
    </tr>
  `), 8, 'Product matching is not required for amount approval.');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html, body {
  width: 210mm;
  min-height: 297mm;
  margin: 0;
  background: #fff;
  color: #111827;
  font-family: Arial, Helvetica, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page { width: 210mm; min-height: 297mm; padding: 10mm; }
.frame { min-height: 277mm; border: 0.35mm solid #111827; padding: 7mm; }
.top { text-align: center; border-bottom: 0.25mm solid #111827; padding-bottom: 4mm; }
.business { font-size: 18pt; font-weight: 800; letter-spacing: 0; }
.business-sub { font-size: 8.5pt; line-height: 1.35; margin-top: 1mm; }
.title { margin: 4mm 0; text-align: center; font-size: 14pt; font-weight: 800; color: #1F4E79; }
.meta-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm; margin-bottom: 4mm; }
.box { border: 0.22mm solid #9CA3AF; padding: 2.3mm; min-height: 12mm; }
.label { color: #6B7280; font-size: 7pt; text-transform: uppercase; font-weight: 700; }
.value { margin-top: 1mm; font-size: 9.5pt; font-weight: 700; overflow-wrap: anywhere; }
.section { margin-top: 4mm; }
.section-title { background: #EEF2F7; border: 0.22mm solid #9CA3AF; padding: 1.6mm 2mm; font-size: 8.5pt; font-weight: 800; color: #111827; }
.details { width: 100%; border-collapse: collapse; table-layout: fixed; }
.details td { border: 0.22mm solid #9CA3AF; padding: 1.6mm 2mm; font-size: 8.3pt; vertical-align: top; }
.details .k { width: 31mm; color: #4B5563; font-weight: 700; }
.data { width: 100%; border-collapse: collapse; table-layout: fixed; }
.data th, .data td { border: 0.22mm solid #9CA3AF; padding: 1.7mm 2mm; font-size: 8.2pt; vertical-align: middle; overflow-wrap: anywhere; }
.data th { background: #F8FAFC; text-align: left; font-weight: 800; }
.num { text-align: right; }
.summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; margin-top: 3mm; }
.summary .box { min-height: 10mm; }
.status { color: #0F766E; }
.empty { text-align: center; color: #6B7280; padding: 4mm !important; }
.remarks { min-height: 16mm; border: 0.22mm solid #9CA3AF; padding: 2mm; font-size: 8.5pt; }
.sign { width: 100%; border-collapse: collapse; margin-top: 8mm; }
.sign td { width: 33.33%; border-top: 0.22mm solid #111827; padding-top: 2mm; text-align: center; font-size: 8.5pt; font-weight: 700; }
</style>
</head>
<body>
<section class="page">
  <div class="frame">
    <div class="top">
      <div class="business">${escapeHtml(companyName())}</div>
      <div class="business-sub">${escapeHtml(companyAddress())}</div>
      <div class="business-sub">${escapeHtml(companyContact())}</div>
    </div>

    <div class="title">SETTLEMENT STATEMENT</div>

    <div class="meta-grid">
      <div class="box"><div class="label">Settlement No</div><div class="value">${escapeHtml(settlement.settlementNo)}</div></div>
      <div class="box"><div class="label">Settlement Date</div><div class="value">${escapeHtml(formatDate(settlement.settlementDate || settlement.completedAt || new Date()))}</div></div>
      <div class="box"><div class="label">Replacement ID</div><div class="value">${escapeHtml(replacement.replacementId || '')}</div></div>
      <div class="box"><div class="label">Party Name</div><div class="value">${escapeHtml(party.name || '')}</div></div>
      <div class="box"><div class="label">Town</div><div class="value">${escapeHtml(party.town || replacement.town || '')}</div></div>
      <div class="box"><div class="label">Company</div><div class="value">${escapeHtml(company.name || '')}</div></div>
    </div>

    <div class="section">
      <div class="section-title">REPLACEMENT DETAILS</div>
      <table class="details"><tr>
        <td class="k">Received Date</td><td>${escapeHtml(formatDate(replacement.receivingDate))}</td>
        <td class="k">Received LR</td><td>${escapeHtml(replacement.receivingLRNo || '')}</td>
        <td class="k">Received Cases</td><td>${escapeHtml(replacement.receivingCases || 0)}</td>
      </tr><tr>
        <td class="k">Transport</td><td colspan="5">${escapeHtml(receivingTransport.name || '')}</td>
      </tr></table>
    </div>

    <div class="section">
      <div class="section-title">DISPATCH DETAILS</div>
      <table class="details"><tr>
        <td class="k">Sent Date</td><td>${escapeHtml(formatDate(replacement.sentDate))}</td>
        <td class="k">Transport</td><td>${escapeHtml(dispatchTransport.name || invoice.transportName || '')}</td>
        <td class="k">LR No</td><td>${escapeHtml(replacement.dispatchLRNo || invoice.lrNo || '')}</td>
      </tr><tr>
        <td class="k">Replacement Invoice No</td><td>${escapeHtml(replacement.invoiceNumber || invoice.invoiceNumber || '')}</td>
        <td class="k">Sent Cases</td><td>${escapeHtml(replacement.dispatchCases || 0)}</td>
        <td class="k">Cartons</td><td>${escapeHtml(replacement.dispatchCartons || '')}</td>
      </tr></table>
    </div>

    <div class="section">
      <div class="section-title">COMPANY APPROVAL</div>
      <table class="details"><tr>
        <td class="k">Approval Type</td><td>${escapeHtml(settlement.approvalType)}</td>
        <td class="k">Approved Amount</td><td>${formatCurrency(settlement.approvedValue)}</td>
        <td class="k">Approval Date</td><td>${escapeHtml(formatDate(replacement.approvalDate))}</td>
      </tr><tr>
        <td class="k">Company RL No</td><td>${escapeHtml(settlement.companyRLNo || '')}</td>
        <td class="k">CN No</td><td>${escapeHtml(settlement.cnNo || '')}</td>
        <td class="k">Remark</td><td>${escapeHtml(replacement.approvalRemark || settlement.remarks || '')}</td>
      </tr></table>
    </div>

    <div class="section">
      <div class="section-title">APPROVED PRODUCT / VALUE</div>
      <table class="data"><thead><tr><th>Approved Product</th><th class="num">Qty</th><th class="num">MRP</th><th class="num">Approved Value</th></tr></thead><tbody>${approvedRows}</tbody></table>
    </div>

    <div class="section">
      <div class="section-title">SENT PRODUCT DETAILS</div>
      <table class="data"><thead><tr><th>Sent Product</th><th class="num">MRP</th><th class="num">Qty</th><th class="num">Value</th></tr></thead><tbody>${sentRows}</tbody></table>
    </div>

    <div class="summary">
      <div class="box"><div class="label">Approved Value</div><div class="value">${formatCurrency(settlement.approvedValue)}</div></div>
      <div class="box"><div class="label">Sent Value</div><div class="value">${formatCurrency(settlement.sentValue)}</div></div>
      <div class="box"><div class="label">Difference</div><div class="value">${formatCurrency(settlement.difference)}</div></div>
      <div class="box"><div class="label">Settlement Status</div><div class="value status">${escapeHtml(settlement.settlementStatus)}</div></div>
    </div>
    <div class="summary">
      <div class="box" style="grid-column: span 2;"><div class="label">Last Sale Invoice No</div><div class="value">${escapeHtml(settlement.lastSaleInvoiceNo || '')}</div></div>
      <div class="box" style="grid-column: span 2;"><div class="label">Settlement No</div><div class="value">${escapeHtml(settlement.settlementNo)}</div></div>
    </div>

    <div class="section">
      <div class="section-title">REMARKS</div>
      <div class="remarks">${escapeHtml(settlement.remarks || '')}</div>
    </div>

    <table class="sign"><tr><td>Prepared By</td><td>Approved By</td><td>Authorized Sign</td></tr></table>
  </div>
</section>
</body>
</html>`;
};

module.exports = { buildSettlementHtml };
