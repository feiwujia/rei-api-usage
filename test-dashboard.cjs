const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/usage-latest.json'), 'utf8'));
const report = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const elements = new Map();
const charts = [];
const context = vm.createContext({
  console, Intl,
  fetch: async url => ({ ok: true, json: async () => raw, text: async () => report }),
  document: { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { style: {}, parentElement: { style: {} } });
    return elements.get(selector);
  } },
  Chart: function (element, config) { charts.push(config); }
});
const source = fs.readFileSync(path.join(__dirname, 'dashboard.js'), 'utf8');
(async () => {
  await vm.runInContext(source, context);
  assert.ok(elements.get('#modelTable').innerHTML.includes('gpt-6-astra'));
  assert.ok(elements.get('#updated').textContent.includes(report.match(/^Updated: `([^`]+)`/m)[1]));
  const models = Array.from({ length: 10 }, (_, i) => ({ name: `new-model-${i}`, cost: i }));
  context.renderModelChart({ models });
  assert.equal(charts.at(-1).data.labels.length, 10);
  context.fetch = async url => {
    if (url.endsWith('README.md')) throw new Error('Unavailable');
    return { ok: true, json: async () => raw };
  };
  assert.ok((await context.loadDashboard()).models.some(model => model.name === 'gpt-6-astra'));
  console.log('PASS: GPT-6, all models, README timestamp, missing timestamp fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
