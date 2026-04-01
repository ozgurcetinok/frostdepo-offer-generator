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
const translations = JSON.parse(fs.readFileSync(path.join(__dirname, 'translations.json'), 'utf-8'));

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

Handlebars.registerHelper('t', function (key) {
  return (this._labels && this._labels[key]) || key;
});

function boldToHtml(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function textToListHtml(text) {
  return text.split('\n').filter(Boolean).map(line => `<li>${boldToHtml(line)}</li>`).join('\n        ');
}

function substituteVars(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, key) => {
    const val = vars[key];
    if (val === undefined) return `{${key}}`;
    return typeof val === 'number' ? val.toLocaleString('en-US') : val;
  });
}

const EDITABLE_LIST_FIELDS = [
  'includedItems', 'minTermItems', 'palletSpecsItems', 'paymentItems',
  'inOutItems', 'climateItems', 'securityItems', 'hseItems',
  'phase1Desc', 'phase2Desc', 'phase3Desc',
];
const EDITABLE_TEXT_FIELDS = [
  'coverSubtitle', 'offerHighlight', 'priceAdjustment', 'capacityIntro', 'capacitySingleIntro',
];

function buildContext(body) {
  const lang = body.lang || 'en';
  const labels = translations.labels[lang] || translations.labels.en;
  const editDefaults = translations.editable[lang] || translations.editable.en;

  const phaseCount = Number(body.phaseCount) || 3;
  const p1 = Number(body.phase1Pallets) || 500;
  const p2 = phaseCount >= 2 ? (Number(body.phase2Pallets) || 900) : 0;
  const p3 = phaseCount >= 3 ? (Number(body.phase3Pallets) || 900) : 0;

  const formVars = {
    minTerm: body.minTerm || 6,
    initialPeriod: body.initialPeriod || '1 year',
    maxExtension: body.maxExtension || '3 years',
    totalPallets: (p1 + p2 + p3).toLocaleString('en-US'),
    phase1Pallets: body.phase1Pallets || 500,
    phase1Rooms: body.phase1Rooms || 2,
    phase1Size: body.phase1Size || 240,
    phase2Pallets: body.phase2Pallets || 900,
    phase2Rooms: body.phase2Rooms || 6,
    phase2Size: body.phase2Size || 140,
    phase2Type: body.phase2Type || 'rack systems',
    phase3Pallets: body.phase3Pallets || 900,
    phase3Rooms: body.phase3Rooms || 6,
    phase3Size: body.phase3Size || 140,
    temperature: body.temperature || 15,
    humidity: body.humidity || 50,
    monthlyInOut: body.monthlyInOut || 750,
  };

  const SECTION_TOGGLES = [
    'showOfferSummary', 'showPricing', 'showIncluded',
    'showContractTerms', 'showPayment', 'showCapacity',
    'showOperations', 'showSecurity', 'showFacilitySpecs',
  ];

  const ctx = { ...body, ...assets, _labels: labels };

  for (const key of SECTION_TOGGLES) {
    ctx[key] = body[key] !== false && body[key] !== 'false';
  }
  ctx.showPage2 = ctx.showOfferSummary || ctx.showPricing || ctx.showIncluded;
  ctx.showPage3 = ctx.showContractTerms || ctx.showPayment || ctx.showCapacity;
  ctx.showPage4 = ctx.showOperations || ctx.showSecurity;

  ctx.phaseCount = phaseCount;
  ctx.isMultiPhase = phaseCount > 1;
  ctx.showPhase2 = phaseCount >= 2;
  ctx.showPhase3 = phaseCount >= 3;
  ctx.activeTotalPallets = (p1 + p2 + p3).toLocaleString('en-US');

  for (const field of EDITABLE_LIST_FIELDS) {
    const raw = body[field] || editDefaults[field] || '';
    const substituted = substituteVars(raw, formVars);
    ctx[field + 'Html'] = textToListHtml(substituted);
  }

  for (const field of EDITABLE_TEXT_FIELDS) {
    const raw = body[field] || editDefaults[field] || '';
    const substituted = substituteVars(raw, formVars);
    ctx[field + 'Html'] = boldToHtml(substituted);
  }

  return ctx;
}

app.get('/api/translations', (_req, res) => res.json(translations));

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
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() =>
      Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))])
    );
    const pdfData = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await page.close();

    const pdfBuffer = Buffer.from(pdfData);
    const clientName = (req.body.clientName || 'Client').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `FrostDepo_Offer_${clientName}.pdf`;

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FrostDepo Offer Generator running on port ${PORT}`));
