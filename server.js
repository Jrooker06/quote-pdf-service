/**
 * Minimal PDF parsing endpoint for Quote Comparison.
 * POST /parse with body { "pdfBase64": "..." } -> { "items": [ { "key", "productCode", "description", "quantity", "unitPrice", "lineTotal" } ] }
 * Deploy to Heroku, AWS Lambda, or similar. Set the URL in Salesforce Quote Comparison Settings.
 */
const express = require('express');
const pdfParse = require('pdf-parse');
const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;

// Simple table line regex (adjust to match your quote PDF layout)
const TRAILING_NUMBERS = /(\d+)\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/;
const PRODUCT_CODE = /\b([A-Z]{2,3}-\d{4}(?:\.[A-Z0-9]+)?)\b/;

function parseLineItems(text) {
  const items = [];
  const lines = (text || '').split(/\r?\n/).map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
  let inTable = false;

  for (const line of lines) {
    if (/Product\s+Description\s+Quantity\s+Price\s+Total/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/Total Item Net Value/i.test(line)) break;

    const m = line.match(TRAILING_NUMBERS);
    if (!m) continue;
    const left = line.slice(0, m.index).trim().replace(/\s+/g, ' ');
    const codeMatch = left.match(PRODUCT_CODE);
    if (!codeMatch) continue;

    const productCode = codeMatch[1];
    const description = left.slice(codeMatch.index + productCode.length).trim().replace(/\s+/g, ' ');
    const key = `${productCode.toUpperCase()}||${description.toUpperCase()}`;
    const qty = parseInt(m[1], 10);
    const price = parseFloat(m[2].replace(/,/g, ''));
    const total = parseFloat(m[3].replace(/,/g, ''));

    items.push({ key, productCode, description, quantity: qty, unitPrice: price, lineTotal: total });
  }
  return items;
}

app.post('/parse', async (req, res) => {
  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ error: 'Missing pdfBase64' });
    }
    const buffer = Buffer.from(pdfBase64, 'base64');
    const data = await pdfParse(buffer);
    const items = parseLineItems(data.text);
    return res.json({ items, quoteNumber: null, quoteDate: null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message, items: [] });
  }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => console.log('PDF parse service on port', PORT));
