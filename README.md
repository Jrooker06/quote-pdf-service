# Quote Comparison PDF parsing service

Accepts POST /parse with `{ "pdfBase64": "..." }`, returns `{ "items": [ { "key", "productCode", "description", "quantity", "unitPrice", "lineTotal" } ] }`.

- Deploy to Heroku: `heroku create your-app && git push heroku main` (add pdf-parse, express).
- Or run locally: `npm install && npm start` (port 3000).
- In Salesforce: Setup > Quote Comparison Settings > set PDF Service URL to `https://your-app.herokuapp.com/parse`. Add the host to Remote Site Settings.
