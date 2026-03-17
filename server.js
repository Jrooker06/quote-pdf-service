/**
 * PDF parsing endpoint for Quote Comparison.
 * POST /parse with body { "pdfBase64": "..." }
 * -> { "items": [ { "key", "productCode", "description", "quantity", "unitPrice", "lineTotal" } ] }
 */
const express = require('express');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;

const MONEY_RE = '\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})|\\d+(?:\\.\\d{2})';
const QTY_RE = '\\d+(?:\\.\\d+)?';
const CODE_RE = '[A-Z0-9][A-Z0-9.\\-/]*';

function normalizeLine(line) {
  return (line || '')
    .replace(/\u000c/g, ' ') // form feed/page break
    .replace(/\u00A0/g, ' ') // nbsp
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,]/g, '').trim());
  return Number.isNaN(n) ? null : n;
}

function buildItem(productCode, description, quantity, unitPrice, lineTotal) {
  const cleanCode = (productCode || '').trim();
  const cleanDesc = (description || '').replace(/\s+/g, ' ').trim();
  const qty = parseNumber(quantity);
  const price = parseNumber(unitPrice);
  const total = parseNumber(lineTotal);

  if (!cleanCode || !cleanDesc || qty == null || price == null || total == null) {
    return null;
  }

  return {
    key: `${cleanCode.toUpperCase()}||${cleanDesc.toUpperCase()}`,
    productCode: cleanCode,
    description: cleanDesc,
    quantity: qty,
    unitPrice: price,
    lineTotal: total
  };
}

function isLikelyHeaderOrFooter(line) {
  const s = normalizeLine(line).toLowerCase();
  if (!s) return true;

  return (
    s.startsWith('test copy') ||
    s.startsWith('order confirmation') ||
    s === 'order' ||
    s.startsWith('page:') ||
    s.includes('page: 2 / 2') ||
    s.startsWith('bill to') ||
    s.startsWith('ship to') ||
    s.startsWith('date:') ||
    s.startsWith('po number:') ||
    s.startsWith('requested date:') ||
    s.startsWith('sales rep:') ||
    s.startsWith('9858 south audio drive') ||
    s.startsWith('west jordan, ut') ||
    s.startsWith('toll free:') ||
    s.startsWith('fax:')
  );
}

function looksLikeTableStart(line) {
  const s = normalizeLine(line).toLowerCase();
  return s.includes('product') &&
    s.includes('description') &&
    s.includes('quantity') &&
    s.includes('price') &&
    s.includes('total');
}

function looksLikeTableEnd(line) {
  const s = normalizeLine(line).toLowerCase();
  return (
    s.startsWith('total item net value') ||
    s.startsWith('overall discount') ||
    s.startsWith('freight') ||
    s.startsWith('state (%)') ||
    s.startsWith('county (%)') ||
    s.startsWith('city (%)') ||
    s === 'total' ||
    s.startsWith('total ')
  );
}

function isProductCodeOnly(line) {
  const s = normalizeLine(line);
  return new RegExp(`^${CODE_RE}$`, 'i').test(s);
}

function tryParseSingleLine(line) {
  const s = normalizeLine(line);
  if (!s) return null;

  const pattern = new RegExp(
    `^(${CODE_RE})\\s+(.+?)\\s+(${QTY_RE})\\s+(${MONEY_RE})\\s+(${MONEY_RE})$`,
    'i'
  );

  const m = s.match(pattern);
  if (!m) return null;

  return buildItem(m[1], m[2], m[3], m[4], m[5]);
}

function tryParseProductPlusBody(productCode, body) {
  const s = normalizeLine(body);
  if (!productCode || !s) return null;

  const pattern = new RegExp(
    `^(.+?)\\s+(${QTY_RE})\\s+(${MONEY_RE})\\s+(${MONEY_RE})$`,
    'i'
  );

  const m = s.match(pattern);
  if (!m) return null;

  return buildItem(productCode, m[1], m[2], m[3], m[4]);
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const sig = [
      item.productCode,
      item.description,
      item.quantity,
      item.unitPrice,
      item.lineTotal
    ].join('|');

    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }

  return out;
}

function parseLineItems(text) {
  const rawLines = (text || '').split(/\r?\n/);
  const lines = rawLines
    .map(normalizeLine)
    .filter(Boolean);

  console.log('raw line count:', rawLines.length);
  console.log('normalized non-empty line count:', lines.length);
  console.log('first 80 normalized lines:', JSON.stringify(lines.slice(0, 80), null, 2));

  const items = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (looksLikeTableStart(line)) {
      inTable = true;
      console.log('table start:', line);
      continue;
    }

    if (!inTable) continue;

    if (looksLikeTableEnd(line)) {
      console.log('table end:', line);
      break;
    }

    if (isLikelyHeaderOrFooter(line)) {
      continue;
    }

    // Case 1: full row is already on one line
    let item = tryParseSingleLine(line);
    if (item) {
      items.push(item);
      continue;
    }

    // Case 2: product code on one line, body on next line
    if (isProductCodeOnly(line) && i + 1 < lines.length) {
      item = tryParseProductPlusBody(line, lines[i + 1]);
      if (item) {
        items.push(item);
        i += 1;
        continue;
      }

      // Case 3: product code + 2 body lines + pricing line
      if (i + 2 < lines.length) {
        item = tryParseProductPlusBody(line, `${lines[i + 1]} ${lines[i + 2]}`);
        if (item) {
          items.push(item);
          i += 2;
          continue;
        }
      }

      // Case 4: product code + 3 body lines
      if (i + 3 < lines.length) {
        item = tryParseProductPlusBody(line, `${lines[i + 1]} ${lines[i + 2]} ${lines[i + 3]}`);
        if (item) {
          items.push(item);
          i += 3;
          continue;
        }
      }
    }

    // Case 5: malformed row split across 2 or 3 lines even without code-only first line
    if (i + 1 < lines.length) {
      item = tryParseSingleLine(`${line} ${lines[i + 1]}`);
      if (item) {
        items.push(item);
        i += 1;
        continue;
      }
    }

    if (i + 2 < lines.length) {
      item = tryParseSingleLine(`${line} ${lines[i + 1]} ${lines[i + 2]}`);
      if (item) {
        items.push(item);
        i += 2;
        continue;
      }
    }
  }

  const deduped = dedupeItems(items);

  console.log('parsed item count:', deduped.length);
  console.log('first 10 parsed items:', JSON.stringify(deduped.slice(0, 10), null, 2));

  return deduped;
}

app.post('/parse', async (req, res) => {
  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ error: 'Missing pdfBase64', items: [] });
    }

    console.log('parse request received');
    console.log('base64 length:', pdfBase64.length);

    const buffer = Buffer.from(pdfBase64, 'base64');
    const data = await pdfParse(buffer);

    console.log('extracted text length:', (data.text || '').length);

    const items = parseLineItems(data.text);

    if (!items.length) {
      console.warn('No items parsed from PDF');
      return res.status(422).json({
        error: 'No line items parsed from PDF',
        items: [],
        quoteNumber: null,
        quoteDate: null
      });
    }

    return res.json({
      items,
      quoteNumber: null,
      quoteDate: null
    });
  } catch (err) {
    console.error('parse error:', err);
    return res.status(500).json({
      error: err.message || 'Unknown parser error',
      items: [],
      quoteNumber: null,
      quoteDate: null
    });
  }
});

app.get('/health', (req, res) => {
  res.send('OK');
});

app.listen(PORT, () => {
  console.log('PDF parse service on port', PORT);
});
