const mongoose = require('mongoose');

const companySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true,
      unique: true,
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    gst: {
      type: String,
      trim: true,
      default: '',
    },
    contact: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      trim: true,
      default: '',
    },
    approvalDays: {
      type: Number,
      default: 30,
      min: 0,
    },
    logo: {
      type: String,
      default: '',
    },
    invoicePrefix: {
      type: String,
      trim: true,
      default: 'HAE',
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

companySchema.index({ status: 1 });

module.exports = mongoose.model('Company', companySchema);
