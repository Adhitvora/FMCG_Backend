const mongoose = require('mongoose');
const { calculateSettlement, MAPPING_STATUSES } = require('../services/settlementCalculation.service');

const productEntrySchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, trim: true, required: true },
  productNameSnapshot: { type: String, trim: true, default: '' },
  sku: { type: String, trim: true, default: '' },
  productCode: { type: String, trim: true, default: '' },
  mrp: { type: Number, min: 0, default: 0 },
  mrpSnapshot: { type: Number, min: 0, default: 0 },
  masterMrpSnapshot: { type: Number, min: 0, default: 0 },
  quantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, trim: true, default: 'pcs' },
  value: { type: Number, min: 0, default: 0 },
  calculatedValue: { type: Number, min: 0, default: 0 },
  batchNo: { type: String, trim: true, default: '' },
  expiryDate: { type: Date, default: null },
  remarks: { type: String, trim: true, default: '' },
}, { _id: true });

const sentMappingItemSchema = new mongoose.Schema({
  sentProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  sentProductName: { type: String, trim: true, default: '' },
  sentProductNameSnapshot: { type: String, trim: true, default: '' },
  sentMRP: { type: Number, min: 0, default: 0 },
  sentMRPSnapshot: { type: Number, min: 0, default: 0 },
  sentQuantity: { type: Number, min: 0, default: 0 },
  sentValue: { type: Number, min: 0, default: 0 },
}, { _id: false });

const productMappingSchema = new mongoose.Schema({
  approvedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  approvedProductName: { type: String, trim: true, default: '' },
  approvedProductNameSnapshot: { type: String, trim: true, default: '' },
  approvedMRP: { type: Number, min: 0, default: 0 },
  approvedMRPSnapshot: { type: Number, min: 0, default: 0 },
  approvedQuantity: { type: Number, min: 0, default: 0 },
  approvedValue: { type: Number, min: 0, default: 0 },

  sentProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  sentProductName: { type: String, trim: true, default: '' },
  sentProductNameSnapshot: { type: String, trim: true, default: '' },
  sentMRP: { type: Number, min: 0, default: 0 },
  sentMRPSnapshot: { type: Number, min: 0, default: 0 },
  sentQuantity: { type: Number, min: 0, default: 0 },
  sentValue: { type: Number, min: 0, default: 0 },
  sentItems: [sentMappingItemSchema],

  quantityDifference: { type: Number, default: 0 },
  valueDifference: { type: Number, default: 0 },
  mappingStatus: {
    type: String,
    enum: MAPPING_STATUSES,
    default: 'PENDING_REVIEW',
  },
  remark: { type: String, trim: true, default: '' },
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
    enum: ['MATCHED', 'EXACT_MATCH', 'SUBSTITUTED', 'PARTIAL', 'EXCESS', 'SHORT', 'NOT_GIVEN', 'WRONG_PRODUCT', 'PENDING_REVIEW', 'MANUAL_APPROVAL', 'NOT MATCHED'],
    default: 'PENDING_REVIEW',
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
    productMappings: [productMappingSchema],
    matchDetails: [matchEntrySchema],

    totalApprovedValue: { type: Number, min: 0, default: 0 },
    totalSentValue: { type: Number, min: 0, default: 0 },
    totalValueDifference: { type: Number, default: 0 },
    totalApprovedQuantity: { type: Number, min: 0, default: 0 },
    totalSentQuantity: { type: Number, min: 0, default: 0 },
    totalQuantityDifference: { type: Number, default: 0 },

    // Backward compatible aliases for existing reports and screens.
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

settlementSchema.pre('validate', function (next) {
  const calculated = calculateSettlement(this.toObject ? this.toObject() : this);

  this.approvedProducts = calculated.approvedProducts;
  this.sentProducts = calculated.sentProducts;
  this.productMappings = calculated.productMappings;
  this.matchDetails = calculated.matchDetails;
  this.totalApprovedValue = calculated.totalApprovedValue;
  this.totalSentValue = calculated.totalSentValue;
  this.totalValueDifference = calculated.totalValueDifference;
  this.totalApprovedQuantity = calculated.totalApprovedQuantity;
  this.totalSentQuantity = calculated.totalSentQuantity;
  this.totalQuantityDifference = calculated.totalQuantityDifference;
  this.approvedValue = calculated.approvedValue;
  this.sentValue = calculated.sentValue;
  this.difference = calculated.difference;

  if (!this.isLocked && !['SETTLED', 'REJECTED'].includes(this.settlementStatus)) {
    this.settlementStatus = calculated.settlementStatus;
  }

  next();
});

settlementSchema.index({ replacementId: 1 });
settlementSchema.index({ companyId: 1, settlementStatus: 1 });
settlementSchema.index({ partyId: 1, createdAt: -1 });
settlementSchema.index({ companyId: 1, createdAt: -1 });
settlementSchema.index({ settlementDate: -1 });
settlementSchema.index({ lastSaleInvoiceNo: 1 });
settlementSchema.index({ completedAt: -1 });

module.exports = mongoose.model('Settlement', settlementSchema);
