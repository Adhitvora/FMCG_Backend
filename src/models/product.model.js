const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
    },
    productName: {
      type: String,
      trim: true,
      default: '',
    },
    sku: {
      type: String,
      trim: true,
      default: '',
    },
    productCode: {
      type: String,
      trim: true,
      default: '',
    },
    code: {
      type: String,
      trim: true,
      default: '',
    },
    mrp: {
      type: Number,
      min: 0,
      default: 0,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  { timestamps: true }
);

productSchema.pre('validate', function (next) {
  if (!this.productName) this.productName = this.name;
  if (!this.name) this.name = this.productName;
  if (!this.companyId && this.company) this.companyId = this.company;
  if (!this.company && this.companyId) this.company = this.companyId;
  if (!this.code && this.productCode) this.code = this.productCode;
  if (!this.productCode && this.code) this.productCode = this.code;
  next();
});

productSchema.index({ name: 1, companyId: 1 });
productSchema.index({ productName: 1, companyId: 1 });
productSchema.index({ sku: 1, companyId: 1 });
productSchema.index({ productCode: 1, companyId: 1 });
productSchema.index({ companyId: 1, status: 1 });
productSchema.index({ status: 1, name: 1 });
productSchema.index({ name: 'text', productName: 'text', sku: 'text', productCode: 'text' });

module.exports = mongoose.model('Product', productSchema);
