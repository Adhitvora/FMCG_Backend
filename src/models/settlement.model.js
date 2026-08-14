const mongoose = require('mongoose');

const productEntrySchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, trim: true, required: true },
  mrp: { type: Number, min: 0, default: 0 },
  quantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, trim: true, default: 'pcs' },
  value: { type: Number, min: 0, default: 0 },
  calculatedValue: { type: Number, min: 0, default: 0 },
  batchNo: { type: String, trim: true, default: '' },
  expiryDate: { type: Date, default: null },
  remarks: { type: String, trim: true, default: '' },
}, { _id: true });

const matchEntrySchema = new mongoose.Schema({
  approvedProduct: { type: String, trim: true, default: '' },
  sentProduct: { type: String, trim: true, default: '' },
  approvedQty: { type: Number, default: 0 },
  sentQty: { type: Number, default: 0 },
  approvedValue: { type: Number, default: 0 },
  sentValue: { type: Number, default: 0 },
  difference: { type: Number, default: 0 },
  matchStatus: {
    type: String,
    enum: ['MATCHED', 'PARTIAL', 'EXCESS', 'SHORT', 'NOT MATCHED'],
    default: 'NOT MATCHED',
  },
}, { _id: false });

const settlementSchema = new mongoose.Schema(
  {
    settlementNo: { type: String, unique: true, required: true },
    replacementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Replacement', required: true, unique: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    partyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    approvalId: { type: mongoose.Schema.Types.ObjectId, default: null },

    lastSaleInvoiceNo: { type: String, trim: true, default: '' },
    approvalType: { type: String, enum: ['Amount', 'Product'], default: 'Amount' },
    approvedAmount: { type: Number, min: 0, default: 0 },
    approvedProducts: [productEntrySchema],
    sentProducts: [productEntrySchema],
    matchDetails: [matchEntrySchema],

    approvedValue: { type: Number, min: 0, default: 0 },
    sentValue: { type: Number, min: 0, default: 0 },
    difference: { type: Number, default: 0 },
    settlementStatus: {
      type: String,
      enum: ['PENDING', 'PARTIAL', 'MATCHED', 'SETTLED', 'REJECTED', 'ON_HOLD'],
      default: 'PENDING',
    },

    companyRLNo: { type: String, trim: true, default: '' },
    cnNo: { type: String, trim: true, default: '' },
    settlementDate: { type: Date, default: null },
    remarks: { type: String, trim: true, default: '' },

    pdfPath: { type: String, default: '' },
    pdfGeneratedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    unlockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    isLocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const calculateProductValue = (product) => {
  const calculatedValue = Number(product.mrp || 0) * Number(product.quantity || 0);
  const explicitValue = Number(product.value || product.calculatedValue || 0);
  return explicitValue > 0 ? explicitValue : calculatedValue;
};

const normalizeProduct = (product) => {
  const value = calculateProductValue(product);
  product.calculatedValue = value;
  product.value = value;
};

const buildProductMatches = (approvedProducts, sentProducts) => {
  const sentByName = new Map();
  sentProducts.forEach((product) => {
    const key = String(product.productName || '').trim().toLowerCase();
    if (!key) return;
    const current = sentByName.get(key) || { qty: 0, value: 0, name: product.productName };
    current.qty += Number(product.quantity || 0);
    current.value += Number(product.value || product.calculatedValue || 0);
    sentByName.set(key, current);
  });

  const rows = approvedProducts.map((approved) => {
    const key = String(approved.productName || '').trim().toLowerCase();
    const sent = sentByName.get(key) || { qty: 0, value: 0, name: '' };
    const approvedValue = Number(approved.value || approved.calculatedValue || 0);
    const sentValue = Number(sent.value || 0);
    const difference = sentValue - approvedValue;
    let matchStatus = 'NOT MATCHED';
    if (approvedValue === sentValue && Number(approved.quantity || 0) === Number(sent.qty || 0)) matchStatus = 'MATCHED';
    else if (sentValue === 0) matchStatus = 'SHORT';
    else if (sentValue < approvedValue) matchStatus = 'PARTIAL';
    else if (sentValue > approvedValue) matchStatus = 'EXCESS';
    else if (sentValue === approvedValue) matchStatus = 'MATCHED';

    return {
      approvedProduct: approved.productName || '',
      sentProduct: sent.name || '',
      approvedQty: Number(approved.quantity || 0),
      sentQty: Number(sent.qty || 0),
      approvedValue,
      sentValue,
      difference,
      matchStatus,
    };
  });

  const approvedNames = new Set(approvedProducts.map((product) => String(product.productName || '').trim().toLowerCase()).filter(Boolean));
  sentProducts.forEach((sent) => {
    const key = String(sent.productName || '').trim().toLowerCase();
    if (key && !approvedNames.has(key)) {
      rows.push({
        approvedProduct: '',
        sentProduct: sent.productName || '',
        approvedQty: 0,
        sentQty: Number(sent.quantity || 0),
        approvedValue: 0,
        sentValue: Number(sent.value || sent.calculatedValue || 0),
        difference: Number(sent.value || sent.calculatedValue || 0),
        matchStatus: 'NOT MATCHED',
      });
    }
  });

  return rows;
};

settlementSchema.pre('validate', function (next) {
  if (Array.isArray(this.approvedProducts)) this.approvedProducts.forEach(normalizeProduct);
  if (Array.isArray(this.sentProducts)) this.sentProducts.forEach(normalizeProduct);

  this.approvedValue = this.approvalType === 'Product'
    ? this.approvedProducts.reduce((sum, product) => sum + Number(product.value || 0), 0)
    : Number(this.approvedAmount || 0);
  if (!this.approvedValue && this.approvedProducts.length) {
    this.approvedValue = this.approvedProducts.reduce((sum, product) => sum + Number(product.value || 0), 0);
  }
  this.sentValue = this.sentProducts.reduce((sum, product) => sum + Number(product.value || product.calculatedValue || 0), 0);
  this.difference = this.sentValue - this.approvedValue;
  this.matchDetails = this.approvalType === 'Product'
    ? buildProductMatches(this.approvedProducts, this.sentProducts)
    : [];

  if (!this.isLocked && !['SETTLED', 'REJECTED', 'ON_HOLD'].includes(this.settlementStatus)) {
    if (!this.sentProducts.length) this.settlementStatus = 'PENDING';
    else if (this.difference === 0) this.settlementStatus = 'MATCHED';
    else if (this.sentValue > 0 && this.sentValue < this.approvedValue) this.settlementStatus = 'PARTIAL';
    else this.settlementStatus = 'ON_HOLD';
  }

  next();
});

settlementSchema.index({ companyId: 1, settlementStatus: 1 });
settlementSchema.index({ partyId: 1, createdAt: -1 });
settlementSchema.index({ settlementDate: -1 });
settlementSchema.index({ lastSaleInvoiceNo: 1 });

module.exports = mongoose.model('Settlement', settlementSchema);
