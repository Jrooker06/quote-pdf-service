/*
key change is tryParseCollapsedRow(), which parses from the numeric tail instead of relying on spaces.
*/

const express = require('express');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;

const MONEY_RE = /\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g;
const PRODUCT_CODE_RE = /^[A-Z0-9][A-Z0-9.\-\/]*$/i;

function normalizeLine(line) {
  return (line || '')
    .replace(/\u000c/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isNaN(n) ? null : n;
}

function buildItem(productCode, description, quantity, unitPrice, lineTotal) {
  const cleanCode = normalizeLine(productCode);
  const cleanDesc = normalizeLine(description);

  const qty = parseNumber(quantity);
  const price = parseNumber(unitPrice);
  const total = parseNumber(lineTotal);

  if (!cleanCode || !cleanDesc) return null;
  if (qty == null || price == null || total == null) return null;

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
    s === 'quote' ||
    s === 'test copy' ||
    s === 'order' ||
    s === 'total' ||
    s === 'product' ||
    s === 'descriptionquantityprice' ||
    s.startsWith('page:') ||
    s === '1/3' ||
    s === '2 / 3' ||
    s === '3 / 3' ||
    s.startsWith('bill to') ||
    s.startsWith('ship to') ||
    s.startsWith('date:') ||
    s.startsWith('expires:') ||
    s.startsWith('customer number:') ||
    s.startsWith('sales rep:') ||
    s.startsWith('9858 south audio drive') ||
    s.startsWith('west jordan, ut') ||
    s.startsWith('toll free:') ||
    s.startsWith('fax:') ||
    s === 'menu'
  );
}

function looksLikeTableStart(line) {
  const s = normalizeLine(line).toLowerCase();
  return (
    s === 'product' ||
    s.includes('descriptionquantityprice') ||
    (s.includes('product') && s.includes('description'))
  );
}

function looksLikeTableEnd(line) {
  const s = normalizeLine(line).toLowerCase();
  return (
    s.startsWith('total item net value') ||
    s.startsWith('overall discount') ||
    s.startsWith('freight') ||
    s.startsWith('state (') ||
    s.startsWith('county (') ||
    s.startsWith('city (') ||
    s.startsWith('subtotal') ||
    s.startsWith('tax') ||
    s === 'total'
  );
}

function isCodeFragment(line) {
  const s = normalizeLine(line);
  if (!s) return false;
  return PRODUCT_CODE_RE.test(s) && !/\d+\.\d{2}/.test(s);
}

function mergeCodeFragments(lines) {
  const merged = [];

  for (let i = 0; i < lines.length; i++) {
    const curr = lines[i];
    const next = lines[i + 1];

    if (
      curr &&
      next &&
      /^[A-Z0-9.\-\/]+-$/i.test(curr) &&
      /^[A-Z0-9.\-\/]+$/i.test(next)
    ) {
      merged.push(curr + next);
      i += 1;
      continue;
    }

    merged.push(curr);
  }

  return merged;
}

function extractTailNumbers(text) {
  const matches = [...text.matchAll(/\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g)];
  if (matches.length < 2) return null;

  const totalMatch = matches[matches.length - 1];
  const priceMatch = matches[matches.length - 2];

  const total = totalMatch[0];
  const unitPrice = priceMatch[0];

  const beforePrice = text.slice(0, priceMatch.index);
  const betweenPriceAndTotal = text.slice(priceMatch.index + unitPrice.length, totalMatch.index);

  return {
    beforePrice,
    betweenPriceAndTotal,
    unitPrice,
    lineTotal: total
  };
}

function splitDescriptionAndQty(prefix) {
  const s = normalizeLine(prefix);
  if (!s) return null;

  const m = s.match(/^(.*?)(\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const description = normalizeLine(m[1]);
  const quantity = m[2];

  if (!description || !quantity) return null;

  return { description, quantity };
}

function tryParseCollapsedRow(productCode, body) {
  const text = normalizeLine(body);
  if (!productCode || !text) return null;

  const tail = extractTailNumbers(text);
  if (!tail) return null;

  const qtySplit = splitDescriptionAndQty(tail.beforePrice);
  if (!qtySplit) return null;

  return buildItem(
    productCode,
    qtySplit.description,
    qtySplit.quantity,
    tail.unitPrice,
    tail.lineTotal
  );
}

function tryParseNormalRow(line) {
  const s = normalizeLine(line);
  if (!s) return null;

  const m = s.match(/^([A-Z0-9][A-Z0-9.\-\/]*)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s+(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})$/i);
  if (!m) return null;

  return buildItem(m[1], m[2], m[3], m[4], m[5]);
}

function tryParseCodePlusBody(code, body) {
  return tryParseNormalRow(`${code} ${body}`) || tryParseCollapsedRow(code, body);
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const sig = `${item.productCode}|${item.description}|${item.quantity}|${item.unitPrice}|${item.lineTotal}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }

  return out;
}

function parseLineItems(text) {
  const rawLines = (text || '').split(/\r?\n/);
  let lines = rawLines.map(normalizeLine).filter(Boolean);
  lines = mergeCodeFragments(lines);

  console.log('raw line count:', rawLines.length);
  console.log('normalized non-empty line count:', lines.length);
  console.log('first 100 normalized lines:', JSON.stringify(lines.slice(0, 100), null, 2));

  const items = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (looksLikeTableStart(line)) {
      inTable = true;
      continue;
    }

    if (!inTable) continue;

    if (looksLikeTableEnd(line)) {
      break;
    }

    if (isLikelyHeaderOrFooter(line)) {
      continue;
    }

    let item = tryParseNormalRow(line);
    if (item) {
      items.push(item);
      continue;
    }

    if (isCodeFragment(line)) {
      if (i + 1 < lines.length) {
        item = tryParseCodePlusBody(line, lines[i + 1]);
        if (item) {
          items.push(item);
          i += 1;
          continue;
        }
      }

      if (i + 2 < lines.length) {
        item = tryParseCodePlusBody(line, `${lines[i + 1]} ${lines[i + 2]}`);
        if (item) {
          items.push(item);
          i += 2;
          continue;
        }
      }

      if (i + 3 < lines.length) {
        item = tryParseCodePlusBody(line, `${lines[i + 1]} ${lines[i + 2]} ${lines[i + 3]}`);
        if (item) {
          items.push(item);
          i += 3;
          continue;
        }
      }
    }

    if (i + 1 < lines.length) {
      item = tryParseNormalRow(`${line} ${lines[i + 1]}`);
      if (item) {
        items.push(item);
        i += 1;
        continue;
      }
    }
  }

  const deduped = dedupeItems(items);

  console.log('parsed item count:', deduped.length);
  console.log('first 15 parsed items:', JSON.stringify(deduped.slice(0, 15), null, 2));

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

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log('PDF parse service on port', PORT);
});
