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

// Simple table line regex tuned for your quotes:
// e.g. "SP-1036  Low Profile Speaker  9  432.00  3,888.00"
const ROW_PATTERN = /^([A-Z0-9.\-]+)\s+(.+?)\s+(\d+)\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s+(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/;

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

    const one = tryParseLine(line);
    if (one) items.push(one);
  }

  if (items.length === 0) {
    for (const line of lines) {
      const one = tryParseLine(line);
      if (one) items.push(one);
    }
  }
  return items;
}

function tryParseLine(line) {
  const m = line.match(ROW_PATTERN);
  if (!m) return null;

  const productCode = m[1];
  const description = m[2].trim().replace(/\s+/g, ' ');
  const qty = parseInt(m[3], 10);
  const price = parseFloat(m[4].replace(/,/g, ''));
  const total = parseFloat(m[5].replace(/,/g, ''));
  const key = `${productCode.toUpperCase()}||${(description || '').toUpperCase()}`;

  return { key, productCode, description, quantity: qty, unitPrice: price, lineTotal: total };
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
