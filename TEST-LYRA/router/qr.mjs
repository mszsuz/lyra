// QR code generation for mobile auth
import QRCode from 'qrcode';

/**
 * Generate QR code as SVG string with transparent background.
 * Dots use currentColor — Chat applies text color via CSS.
 * @param {string} text — content to encode (mobile_jwt)
 * @returns {Promise<string>} SVG string
 */
export async function generateQR(text) {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    width: 200,
    margin: 1,
    errorCorrectionLevel: 'L',
    color: { dark: '#000000', light: '#00000000' },
  });
  // Replace hardcoded color with currentColor — inherits text color in CSS
  return svg.replace(/#000000/g, 'currentColor');
}
