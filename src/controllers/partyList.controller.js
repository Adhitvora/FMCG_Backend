const Replacement = require('../models/replacement.model');
const Company = require('../models/company.model');
const PDFDocument = require('pdfkit');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// GET /api/party-list/:companyId/pdf?replacementIds=id1,id2&date=2026-08-02&transport=XYZ&invoiceNo=HAE-2026-000001
const generatePartyListPDF = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.companyId);
    if (!company) throw ApiError.notFound('Company not found');

    const { replacementIds, date, transport, invoiceNo } = req.query;

    let replacements;
    if (replacementIds) {
      const ids = replacementIds.split(',');
      replacements = await Replacement.find({ _id: { $in: ids }, status: 'active' })
        .populate('party', 'name town gst mobile address')
        .populate('receivingTransport', 'name')
        .sort({ 'party.name': 1 });
    } else {
      // Get all dispatched but uninvoiced replacements for this company
      replacements = await Replacement.find({
        company: req.params.companyId,
        status: 'active',
        sentDate: { $ne: null },
      })
        .populate('party', 'name town gst mobile address')
        .populate('receivingTransport', 'name')
        .sort({ createdAt: -1 });
    }

    // A4 Portrait
    const doc = new PDFDocument({ size: 'A4', margin: 35 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Party_List_${company.name.replace(/\s/g, '_')}.pdf`);
    doc.pipe(res);

    const pageW = doc.page.width;
    const margin = 35;
    const contentW = pageW - margin * 2;
    const listDate = date || new Date().toLocaleDateString('en-IN');

    // ══════════════════════════════════════════════════════════════
    // HEADER: SHRI HET - ARYA ENTERPRISE
    // ══════════════════════════════════════════════════════════════
    doc.font('Helvetica-Bold').fontSize(18).text('SHRI HET - ARYA ENTERPRISE', margin, 30, { align: 'center', width: contentW });

    doc.font('Helvetica').fontSize(7).text(
      'A-4 Urja Commercial Park, B/h. Audi Showroom, Navsarjan Main Road, Rajkot, Gujarat 360005',
      margin, 52, { align: 'center', width: contentW }
    );
    doc.fontSize(7).text(
      'Mo.: 9737351254, 9998757976 - Email: hetarya@gmail.com - www.hetarya.com',
      margin, 62, { align: 'center', width: contentW }
    );

    // ══════════════════════════════════════════════════════════════
    // TITLE BAR: REPLACEMENT PARTY LIST
    // ══════════════════════════════════════════════════════════════
    const titleY = 78;
    doc.rect(margin, titleY, contentW * 0.7, 18).stroke();
    doc.font('Helvetica-Bold').fontSize(11).text('REPLACEMENT PARTY LIST', margin, titleY + 4, { width: contentW * 0.7, align: 'center' });

    // ORIGINAL label
    doc.font('Helvetica-Bold').fontSize(9).text('ORIGINAL', margin + contentW * 0.75, titleY + 4);

    // ══════════════════════════════════════════════════════════════
    // COMPANY DETAILS BOX (left) + DATE/INVOICE/TRANSPORT (right)
    // ══════════════════════════════════════════════════════════════
    const detailY = 100;
    const leftW = contentW * 0.6;
    const rightW = contentW * 0.4;
    const boxH = 95;

    // Left box - Company details
    doc.rect(margin, detailY, leftW, boxH).stroke();
    let cY = detailY + 6;
    doc.font('Helvetica-Bold').fontSize(9).text(`M/S. ${company.name}`, margin + 8, cY);
    cY += 13;
    if (company.address) {
      const addrLines = company.address.split(',').map(s => s.trim());
      doc.font('Helvetica').fontSize(8);
      addrLines.forEach(line => {
        if (cY < detailY + boxH - 15) {
          doc.text(line + ',', margin + 8, cY);
          cY += 11;
        }
      });
    }
    if (company.contact) {
      doc.font('Helvetica').fontSize(8).text(`Mobile No. ${company.contact}`, margin + 8, cY);
    }

    // Right box - Date, Invoice, Transport
    const rightX = margin + leftW;
    doc.rect(rightX, detailY, rightW, boxH).stroke();

    // Date row
    doc.rect(rightX, detailY, rightW, boxH / 3).stroke();
    doc.font('Helvetica-Bold').fontSize(8).text('DATE :', rightX + 6, detailY + 8);
    doc.font('Helvetica').fontSize(8).text(listDate, rightX + 55, detailY + 8);

    // Invoice row
    doc.rect(rightX, detailY + boxH / 3, rightW, boxH / 3).stroke();
    doc.font('Helvetica-Bold').fontSize(8).text('INVOICE NO. :', rightX + 6, detailY + boxH / 3 + 8);
    doc.font('Helvetica').fontSize(8).text(invoiceNo || '', rightX + 75, detailY + boxH / 3 + 8);

    // Transport row
    doc.font('Helvetica-Bold').fontSize(8).text('TRANSPORT :', rightX + 6, detailY + (boxH / 3) * 2 + 8);
    doc.font('Helvetica').fontSize(8).text(transport || '', rightX + 70, detailY + (boxH / 3) * 2 + 8);

    // ══════════════════════════════════════════════════════════════
    // CITY LINE
    // ══════════════════════════════════════════════════════════════
    const cityY = detailY + boxH + 8;
    const town = replacements.length > 0 ? (replacements[0].town || '') : '';
    if (town) {
      doc.font('Helvetica-Bold').fontSize(9).text(town, margin + 8, cityY);
    }

    // ══════════════════════════════════════════════════════════════
    // TABLE
    // ══════════════════════════════════════════════════════════════
    const tableY = cityY + 18;
    const colWidths = [35, 180, 95, 80, 65, 65]; // SR, PARTY NAME, TOWN, RL NO, CASE, CASE
    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const rowH = 18;

    // Table header
    doc.rect(margin, tableY, tableW, rowH).stroke();
    doc.font('Helvetica-Bold').fontSize(8);
    const headers = ['SR.', 'PARTY NAME', 'TOWN', 'RL NO', 'CASE', 'CASE'];

    let xPos = margin;
    headers.forEach((h, i) => {
      doc.rect(xPos, tableY, colWidths[i], rowH).stroke();
      doc.text(h, xPos + 4, tableY + 5, { width: colWidths[i] - 8, align: 'center' });
      xPos += colWidths[i];
    });

    // Table rows
    let currentY = tableY + rowH;
    let grandTotalReceived = 0;
    let grandTotalSent = 0;

    doc.font('Helvetica').fontSize(8);

    // Calculate available rows for the page
    const maxRowY = doc.page.height - 150; // Reserve space for footer

    replacements.forEach((rep, idx) => {
      if (currentY > maxRowY) {
        doc.addPage();
        currentY = 40;
      }

      xPos = margin;
      const rowData = [
        String(idx + 1),
        rep.party?.name || '',
        rep.party?.town || rep.town || '',
        rep.receivingLRNo || '',
        String(rep.receivingCases || 0),
        String(rep.dispatchCases || 0),
      ];

      // Draw row border
      colWidths.forEach((w) => {
        doc.rect(xPos, currentY, w, rowH).stroke();
        xPos += w;
      });

      // Fill data
      xPos = margin;
      rowData.forEach((val, i) => {
        const align = i >= 4 ? 'center' : (i === 0 ? 'center' : 'left');
        doc.text(val, xPos + 4, currentY + 5, { width: colWidths[i] - 8, align });
        xPos += colWidths[i];
      });

      grandTotalReceived += rep.receivingCases || 0;
      grandTotalSent += rep.dispatchCases || 0;
      currentY += rowH;
    });

    // Empty rows to fill the table (minimum 20 rows total)
    const minRows = Math.max(20, replacements.length);
    for (let i = replacements.length; i < minRows; i++) {
      if (currentY > maxRowY) break;
      xPos = margin;
      colWidths.forEach((w) => {
        doc.rect(xPos, currentY, w, rowH).stroke();
        xPos += w;
      });
      currentY += rowH;
    }

    // ══════════════════════════════════════════════════════════════
    // GSTIN + GRAND TOTAL
    // ══════════════════════════════════════════════════════════════
    currentY += 6;
    doc.font('Helvetica-Bold').fontSize(8);
    doc.text(`GSTIN No.: 24ABPFS1872C1Z5`, margin, currentY);

    const totalText = `Grand Total Case:`;
    doc.text(totalText, margin + contentW * 0.55, currentY);
    doc.text(String(grandTotalSent || grandTotalReceived), margin + contentW * 0.85, currentY, { align: 'right', width: 50 });

    // ══════════════════════════════════════════════════════════════
    // TERMS & CONDITIONS
    // ══════════════════════════════════════════════════════════════
    currentY += 18;
    doc.font('Helvetica-Bold').fontSize(7.5).text('Terms & Condition :', margin, currentY);
    currentY += 12;
    doc.font('Helvetica').fontSize(7);
    doc.text('1. The company is responsible for matching this list with the replacement shipment.', margin, currentY);
    currentY += 10;
    doc.text('2. Please inform the company after receiving the replacement shipment.', margin, currentY);
    currentY += 10;
    doc.text('3. Please report any missing cases to the company.', margin, currentY);

    // ══════════════════════════════════════════════════════════════
    // SIGNATURE SECTION
    // ══════════════════════════════════════════════════════════════
    currentY += 25;
    doc.font('Helvetica-Bold').fontSize(8);
    doc.text('For, SHRI HET - ARYA ENTERPRISE', margin + contentW * 0.6, currentY, { align: 'right', width: contentW * 0.4 });

    currentY += 35;
    const sigW = contentW / 3;
    doc.font('Helvetica').fontSize(8);
    doc.moveTo(margin, currentY).lineTo(margin + sigW - 20, currentY).stroke();
    doc.text('Prepared By :', margin, currentY + 4, { width: sigW, align: 'center' });

    doc.moveTo(margin + sigW, currentY).lineTo(margin + sigW * 2 - 20, currentY).stroke();
    doc.text('Approved By :', margin + sigW, currentY + 4, { width: sigW, align: 'center' });

    doc.moveTo(margin + sigW * 2, currentY).lineTo(margin + sigW * 3, currentY).stroke();
    doc.text('Authorized Sign', margin + sigW * 2, currentY + 4, { width: sigW, align: 'center' });

    doc.end();
  } catch (error) {
    next(error);
  }
};

// POST /api/party-list/generate — Create party list from selected replacements
const getPartyListData = async (req, res, next) => {
  try {
    const { companyId, replacementIds } = req.body;

    const company = await Company.findById(companyId);
    if (!company) throw ApiError.notFound('Company not found');

    let filter = { company: companyId, status: 'active' };
    if (replacementIds && replacementIds.length > 0) {
      filter._id = { $in: replacementIds };
    } else {
      filter.sentDate = { $ne: null };
    }

    const replacements = await Replacement.find(filter)
      .populate('party', 'name town')
      .populate('receivingTransport', 'name')
      .sort({ 'party.name': 1 });

    const data = {
      company: {
        name: company.name,
        address: company.address,
        gst: company.gst,
        contact: company.contact,
      },
      items: replacements.map((r, i) => ({
        sr: i + 1,
        partyName: r.party?.name || '',
        town: r.party?.town || r.town || '',
        rlNo: r.receivingLRNo || '',
        receivingCases: r.receivingCases || 0,
        dispatchCases: r.dispatchCases || 0,
        replacementId: r._id,
      })),
      grandTotalReceived: replacements.reduce((s, r) => s + (r.receivingCases || 0), 0),
      grandTotalSent: replacements.reduce((s, r) => s + (r.dispatchCases || 0), 0),
    };

    ApiResponse.success(res, data);
  } catch (error) {
    next(error);
  }
};

module.exports = { generatePartyListPDF, getPartyListData };
