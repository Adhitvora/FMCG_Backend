const mongoose = require('mongoose');

const transportSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Transport name is required'],
      trim: true,
      unique: true,
    },
    contact: {
      type: String,
      trim: true,
      default: '',
    },
    gst: {
      type: String,
      trim: true,
      default: '',
    },
    branch: {
      type: String,
      trim: true,
      default: '',
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

transportSchema.index({ status: 1 });

module.exports = mongoose.model('Transport', transportSchema);
