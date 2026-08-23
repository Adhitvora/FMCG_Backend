const fs = require('fs');
const path = require('path');

const defaultLogoPath = path.resolve(__dirname, '..', '..', '..', 'frontend', 'public', 'Hetarya.png');

const companyBranding = {
  companyName: process.env.INVOICE_BUSINESS_NAME || 'HET ARYA ENTERPRISE',
  address: process.env.INVOICE_BUSINESS_ADDRESS || 'A-4 Urja Commercial Park, B/h. Audi Showroom, Navsarjan Main Road, Rajkot, Gujarat 360005',
  phone: process.env.COMPANY_PHONE || '9737351254, 9998757976',
  email: process.env.COMPANY_EMAIL || 'hetarya@gmail.com',
  website: process.env.COMPANY_WEBSITE || 'www.hetarya.com',
  gstin: process.env.INVOICE_BUSINESS_GST || '24ABPFS1872C1Z5',
  logoPath: process.env.COMPANY_LOGO_PATH || defaultLogoPath,
};

const getLogoDataUri = () => {
  try {
    const logoBuffer = fs.readFileSync(companyBranding.logoPath);
    const extension = path.extname(companyBranding.logoPath).toLowerCase();
    const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${logoBuffer.toString('base64')}`;
  } catch (error) {
    return '';
  }
};

module.exports = {
  companyBranding,
  getLogoDataUri,
};
