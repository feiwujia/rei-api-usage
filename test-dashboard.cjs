const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/usage-latest.json'), 'utf8'));
const report = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const history = fs.readFileSync(path.join(__dirname, 'data/usage-history.jsonl'), 'utf8');
const elements = new Map();
const charts = [];
const context = vm.createContext({
  console, Intl,
  fetch: async url => ({ ok: true, json: async () => raw,
    text: async () => url.endsWith('.jsonl') ? history : report }),
  document: { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      style: {}, parentElement: { style: {} }, append() {}, addEventListener() {},
      value: selector.includes('range') ? '30' : selector.includes('mode') ? 'total' : ''
    });
    return elements.get(selector);
  }, createElement() { return { innerHTML: '', querySelector() { return { addEventListener() {} }; } }; } },
  Chart: function (element, config) { charts.push(config); this.config = { type: 'line' }; Object.assign(this, config); this.update = () => {}; }
});
const source = fs.readFileSync(path.join(__dirname, 'dashboard.js'), 'utf8');
(async () => {
  await vm.runInContext(source, context);
  assert.ok(elements.get('#modelTable').innerHTML.includes('gpt-6-astra'));
  assert.ok(elements.get('#updated').textContent.includes(context.formatUpdated(report.match(/^Updated: `([^`]+)`/m)[1])));
  assert.equal(context.formatUpdated('2026-09-12T17:20:45Z'), '2026-09-13 01:20:45 (UTC+8)');
  const sample = { updated: '2026-09-13T01:00:00+08:00', daily: [], history: [
    { fetched_at: '2026-09-10T23:00:00+08:00', data: { daily_usage: [{ date: '2026-09-10', cost: 4 }], model_stats: [{ model: 'm', cost: 100 }] } },
    { fetched_at: '2026-09-11T23:00:00+08:00', data: { model_stats: [{ model: 'm', cost: 80 }] } }
  ] };
  const trends = context.buildTrends(sample, { model_stats: [{ model: 'm', cost: 85 }] });
  const week = context.trendSeries(trends, '7', 'models', 'm');
  assert.equal(week.labels.length, 7);
  assert.equal(week.labels[0], '2026-09-07');
  assert.deepEqual(Array.from(week.datasets[0].data), [null, null, null, 100, 80, null, 85]);
  assert.equal(context.trendSeries(trends, '30', 'total').labels.length, 30);
  assert.equal(context.trendSeries(trends, 'all', 'total').labels[0], '2026-09-10');
  assert.equal(context.trendSeries(trends, 'all', 'total').datasets[0].data[0], 4);
  const models = Array.from({ length: 10 }, (_, i) => ({ name: `new-model-${i}`, cost: i }));
  context.renderModelChart({ models });
  assert.equal(charts.at(-1).data.labels.length, 10);
  context.fetch = async url => {
    if (url.endsWith('README.md') || url.endsWith('.jsonl')) throw new Error('Unavailable');
    return { ok: true, json: async () => raw };
  };
  assert.ok((await context.loadDashboard()).models.some(model => model.name === 'gpt-6-astra'));
  console.log('PASS: models, timestamp, date ranges, rolling totals, missing dates, fetch fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
