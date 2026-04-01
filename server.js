const express = require('express');
const path = require('path');
const fs = require('fs');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const templateSrc = fs.readFileSync(path.join(__dirname, 'templates', 'offer.html'), 'utf-8');
const template = Handlebars.compile(templateSrc);

const assets = JSON.parse(fs.readFileSync(path.join(__dirname, 'templates', 'assets.json'), 'utf-8'));

Handlebars.registerHelper('formatNumber', (v) => {
  const n = Number(v);
  return isNaN(n) ? v : n.toLocaleString('en-US');
});

Handlebars.registerHelper('totalPallets', (p1, p2, p3) => {
  const total = Number(p1 || 0) + Number(p2 || 0) + Number(p3 || 0);
  return total.toLocaleString('en-US');
});

Handlebars.registerHelper('cumulativePallets', (p1, p2) => {
  const total = Number(p1 || 0) + Number(p2 || 0);
  return '~' + total.toLocaleString('en-US');
});

function buildContext(body) {
  return {
    ...body,
    ...assets,
  };
}

app.post('/api/preview', (req, res) => {
  try {
    const html = template(buildContext(req.body));
    res.type('html').send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  browserInstance = await puppeteer.launch(launchOpts);
  return browserInstance;
}

app.post('/api/generate-pdf', async (req, res) => {
  try {
    const html = template(buildContext(req.body));
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await page.close();

    const clientName = (req.body.clientName || 'Client').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `FrostDepo_Offer_${clientName}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdf.length,
    });
    res.send(pdf);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FrostDepo Offer Generator running on port ${PORT}`));
