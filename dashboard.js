const number = new Intl.NumberFormat("en-US");

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2
});

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});


function formatTokens(value) {
  return compact.format(Number(value || 0));
}


function formatMoney(value) {
  return money.format(Number(value || 0));
}


function formatLatency(ms) {
  if (!ms) return "—";

  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  return `${Math.round(ms)}ms`;
}


function normalize(raw) {

  // ----------
  // Daily usage
  // ----------

  const daily = [...(raw.daily_usage || [])]
    .sort((a, b) => a.date.localeCompare(b.date));


  // ----------
  // Summary
  // ----------

  const today =
    raw.usage?.today ||
    daily[daily.length - 1] ||
    {};


  const summary = {
    requests: today.requests || 0,
    tokens: today.total_tokens || 0,
    cost: today.actual_cost ?? today.cost ?? 0,
    latency: raw.usage?.average_duration_ms || 0,
    input_tokens: today.input_tokens || 0,
    output_tokens: today.output_tokens || 0,
    cache_read_tokens: today.cache_read_tokens || 0
  };


  // ----------
  // Quota
  // ----------

  const rawQuota = raw.rate_limits?.[0];

  let quota = null;

  if (rawQuota) {

    const limit = Number(rawQuota.limit || 0);
    const used = Number(rawQuota.used || 0);

    quota = {
      ...rawQuota,

      used_percent:
        limit > 0
          ? (used / limit) * 100
          : 0
    };
  }


  // ----------
  // Models
  // ----------

  const rawModels = raw.model_stats || [];

  const totalModelCost = rawModels.reduce(
    (total, model) =>
      total +
      Number(model.actual_cost ?? model.cost ?? 0),
    0
  );

  const totalModelRequests = rawModels.reduce(
    (total, model) =>
      total +
      Number(model.requests || 0),
    0
  );


  const models = rawModels
    .map(model => {

      const cost =
        Number(
          model.actual_cost ??
          model.cost ??
          0
        );

      const requests =
        Number(model.requests || 0);


      return {

        name: model.model,

        requests,

        input_tokens:
          Number(model.input_tokens || 0),

        output_tokens:
          Number(model.output_tokens || 0),

        cache_read_tokens:
          Number(model.cache_read_tokens || 0),

        total_tokens:
          Number(model.total_tokens || 0),

        cost,

        request_share:
          totalModelRequests
            ? requests / totalModelRequests
            : 0,

        cost_share:
          totalModelCost
            ? cost / totalModelCost
            : 0,

        avg_cost_per_request:
          requests
            ? cost / requests
            : 0
      };

    })
    .sort((a, b) => b.cost - a.cost);


  return {
    status: raw.status,
    mode: raw.mode,
    summary,
    quota,
    daily,
    models
  };
}


async function loadDashboard() {

  const response = await fetch(
    "./data/usage-latest.json",
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to load usage data: ${response.status}`
    );
  }

  const raw = await response.json();
  const data = normalize(raw);
  const report = await fetch("./README.md", { cache: "no-store" }).catch(() => null);
  if (report?.ok) {
    data.updated = (await report.text()).match(/^Updated: `([^`]+)`/m)?.[1];
  }
  data.history = [];
  try {
    const history = await fetch("./data/usage-history.jsonl", { cache: "no-store" });
    if (!history.ok) throw new Error(`History: ${history.status}`);
    data.history = (await history.text()).split(/\r?\n/).filter(line => line.trim()).map(JSON.parse);
  } catch (error) {
    data.historyUnavailable = true;
  }
  data.trends = buildTrends(data, raw);
  return data;
}

function shanghaiDay(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : null;
}

function formatUpdated(value) {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") + " (UTC+8)"
    : "unavailable";
}

function buildTrends(data, raw) {
  const snapshots = data.history.filter(row => Number.isFinite(Date.parse(row.fetched_at)))
    .sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at));
  if (data.updated && shanghaiDay(data.updated)) snapshots.push({ fetched_at: data.updated, data: raw });
  const daily = new Map();
  const coveredDays = new Set();
  const modelDays = new Map();
  const names = new Set();
  for (const snapshot of snapshots) {
    const usage = snapshot.data.daily_usage;
    if (Array.isArray(usage) && usage.length) {
      const first = usage.map(row => row.date).sort()[0];
      const last = shanghaiDay(snapshot.fetched_at);
      for (let date = Date.parse(first + "T00:00:00Z"); date <= Date.parse(last + "T00:00:00Z"); date += 86400000) {
        coveredDays.add(new Date(date).toISOString().slice(0, 10));
      }
      for (const row of usage) daily.set(row.date, row);
    }
    if (snapshot.data.usage?.today) {
      const day = shanghaiDay(snapshot.fetched_at);
      daily.set(day, { ...snapshot.data.usage.today, date: day });
      coveredDays.add(day);
    }
    const models = snapshot.data.model_stats;
    if (!Array.isArray(models)) continue;
    const values = new Map(models.map(model => [model.model, Number(model.actual_cost ?? model.cost ?? 0)]));
    for (const name of values.keys()) names.add(name);
    // Keep the last observed window total per day; differences are not daily costs.
    modelDays.set(shanghaiDay(snapshot.fetched_at), values);
  }
  for (const row of data.daily) daily.set(row.date, row);
  const dates = [...new Set([...daily.keys(), ...modelDays.keys()])].sort();
  return { daily, coveredDays, modelDays, names: [...names].sort(), dates, today: data.summary, snapshots,
    updated: data.updated || snapshots.at(-1)?.fetched_at,
    end: shanghaiDay(data.updated) || dates.at(-1) };
}

function trendSeries(trends, range, mode, selectedModel = "") {
  if (range === "today" || range === "24h") return intradaySeries(trends, range, mode);
  if (!trends.end || !trends.dates.length) return { labels: [], datasets: [] };
  const end = Date.parse(trends.end + "T00:00:00Z");
  const start = range === "all" ? Date.parse(trends.dates[0] + "T00:00:00Z")
    : end - (Number(range) - 1) * 86400000;
  const labels = [];
  for (let day = start; day <= end; day += 86400000) labels.push(new Date(day).toISOString().slice(0, 10));
  const colors = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be185d", "#64748b"];
  const datasets = mode === "total" ? [{ label: "Daily cost", borderColor: colors[0],
    data: labels.map(day => {
      const row = trends.daily.get(day);
      return row ? Number(row.actual_cost ?? row.cost ?? 0) : trends.coveredDays?.has(day) ? 0 : null;
    }) }] : trends.names.filter(name => !selectedModel || name === selectedModel).map(name => ({
      label: name,
      borderColor: colors[trends.names.indexOf(name) % colors.length],
      data: labels.map(day => trends.modelDays.has(day) ? trends.modelDays.get(day).get(name) ?? 0 : null)
    }));
  return styleSeries({ labels, datasets }, true);
}

const seriesColors = ["#3b82f6", "#14b8a6", "#e6a23c", "#a78bfa", "#ec7098", "#64748b", "#06b6d4", "#84a34a"];

function styleSeries(series, fill = true) {
  series.datasets = series.datasets.map((dataset, index) => {
    const color = seriesColors[index % seriesColors.length];
    return { ...dataset, borderColor: color, backgroundColor: color + "18",
      pointBackgroundColor: color, pointBorderColor: "#fff", pointBorderWidth: 1.5,
      pointRadius: series.labels.length === 1 ? 5 : 2, pointHoverRadius: 5,
      borderWidth: 2.5, tension: 0.25, cubicInterpolationMode: "monotone", fill, spanGaps: false };
  });
  return series;
}

function intradaySeries(trends, range, mode) {
  const end = Date.parse(trends.updated);
  const start = range === "today" ? Date.parse(shanghaiDay(trends.updated) + "T00:00:00+08:00") : end - 86400000;
  const rows = [...new Map((trends.snapshots || []).map(row => [Date.parse(row.fetched_at), row])).values()]
    .filter(row => Date.parse(row.fetched_at) >= start && Date.parse(row.fetched_at) <= end)
    .sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at));
  const labels = rows.map(row => formatUpdated(row.fetched_at).slice(5, 16));
  if (mode === "models") return styleSeries({ labels, datasets: trends.names.map(name => ({
    label: name, data: rows.map(row => {
      const model = row.data.model_stats?.find(model => model.model === name);
      return model ? Number(model.actual_cost ?? model.cost ?? 0) : Array.isArray(row.data.model_stats) ? 0 : null;
    }) })) });
  const keys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];
  const names = ["Input", "Output", "Cache read", "Cache write"];
  return styleSeries({ labels, datasets: keys.map((key, index) => {
    const values = rows.map(row => {
      const usage = range === "today" ? row.data.usage?.today : row.data.usage?.total;
      return Number.isFinite(usage?.[key]) ? usage[key] : null;
    });
    // Never interpolate a window boundary or a reset of the lifetime counter.
    const baseline = values[0];
    return { label: names[index], data: range === "today" ? values : values.map((value, i) =>
      baseline !== null && value !== null && value >= baseline &&
      !values.slice(0, i + 1).some((v, j) => j && v !== null && values[j - 1] !== null && v < values[j - 1])
        ? value - baseline : null) };
  }) }, true);
}

function renderSummary(data) {

  document.querySelector("#requests").textContent =
    number.format(data.summary.requests);

  document.querySelector("#tokens").textContent =
    formatTokens(data.summary.tokens);

  document.querySelector("#cost").textContent =
    formatMoney(data.summary.cost);

  document.querySelector("#latency").textContent =
    formatLatency(data.summary.latency);


  const status =
    document.querySelector("#status");

  document.querySelector("#subscriptionType").textContent =
    data.mode === "quota_limited" ? "Quota subscription" : (data.mode || "Unknown").replaceAll("_", " ");
  status.textContent = data.status === "active" ? "Active" : (data.status || "Unknown");
  status.className = data.status === "active" ? "status is-active" : "status";


  document.querySelector("#updated").textContent =
    data.updated
      ? `Updated: ${formatUpdated(data.updated)}`
      : "Update time unavailable";
}


function renderQuota(data) {

  const quota = data.quota;

  if (!quota) return;


  document.querySelector("#quotaUsed").textContent =
    formatMoney(quota.used);

  document.querySelector("#quotaLimit").textContent =
    formatMoney(quota.limit);


  const percent =
    Math.min(
      quota.used_percent,
      100
    );


  document.querySelector("#quotaProgress").style.width =
    `${percent}%`;


  document.querySelector("#quotaPercent").textContent =
    `${quota.used_percent.toFixed(1)}% used`;


  document.querySelector("#quotaWindow").textContent =
    `${quota.window || ""} quota`;


  document.querySelector("#quotaReset").textContent =
    `Resets ${formatUpdated(quota.reset_at)}`;
}


function renderDailyChart(data) {
  const modelChecks = document.querySelector("#trendModels");
  const selectedModels = new Set(data.trends.names);
  for (const name of data.trends.names) {
    const label = document.createElement("label");
    label.style.setProperty("--model-color", seriesColors[data.trends.names.indexOf(name) % seriesColors.length]);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = name;
    input.checked = true;
    const caption = document.createElement("span");
    caption.textContent = name;
    label.append(input, caption);
    label.querySelector("input").addEventListener("change", event => {
      event.target.checked ? selectedModels.add(name) : selectedModels.delete(name);
      update();
    });
    modelChecks.append(label);
  }
  const chart = new Chart(document.querySelector("#costChart"), {
    type: "line",
    data: trendSeries(data.trends, "today", "total"),
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, color: "#87909e", font: { size: 11 } } },
        y: { beginAtZero: true, border: { display: false }, grid: { color: "#edf0f4" }, ticks: { maxTicksLimit: 5, callback: value => compact.format(value) }, title: { display: true, text: "Tokens" } }
      },
      plugins: {
        legend: { display: false, position: "bottom", labels: { usePointStyle: true, pointStyle: "circle", padding: 18 } },
        tooltip: { backgroundColor: "#fff", titleColor: "#111827", bodyColor: "#475569", borderColor: "#e5e7eb", borderWidth: 1, padding: 12,
          callbacks: { label: ctx => `${ctx.dataset.label}: ${formatMoney(ctx.raw)}` } }
      }
    }
  });
  function update() {
    const range = document.querySelector('input[name="range"]:checked').value;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const tokens = mode === "total" && (range === "today" || range === "24h");
    modelChecks.hidden = mode !== "models";
    chart.data = trendSeries(data.trends, range, mode, "");
    chart.config.type = "line";
    if (mode === "models") chart.data.datasets = chart.data.datasets.filter(dataset => selectedModels.has(dataset.label));
    chart.options.plugins.legend.display = tokens;
    chart.options.scales.y.title.text = tokens ? "Tokens" : "USD";
    chart.options.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${tokens ? number.format(ctx.raw) : formatMoney(ctx.raw)}`;
    document.querySelector("#trendMetric").textContent = mode === "models"
      ? "Reported model cost · rolling window totals · UTC+8"
      : range === "today" ? "Cumulative tokens today · UTC+8"
      : range === "24h" ? "Cumulative tokens since first observation in the 24h window · UTC+8" : "Daily API cost · UTC+8";
    document.querySelector("#trendTitle").textContent = tokens ? "Token usage" : "Cost over time";
    const notice = document.querySelector("#trendNotice");
    const hasData = chart.data.datasets.some(dataset => dataset.data.some(value => value !== null));
    notice.textContent = data.historyUnavailable ? "History unavailable; showing latest data only."
      : !hasData ? "No observations in this period."
      : tokens && chart.data.datasets.every(dataset => dataset.data.every(value => value === null || value === 0))
        ? "No token increase recorded between these observations." : "";
    notice.hidden = !notice.textContent;
    chart.update();
  }
  for (const selector of ["#trendRange", "#trendMode"]) {
    document.querySelector(selector).addEventListener("change", update);
  }
  update();
}

function renderModelChart(data) {

  const models =
    data.models;

  document.querySelector("#modelChart").parentElement.style.height =
    `${Math.max(280, models.length * 40)}px`;


  new Chart(
    document.querySelector("#modelChart"),
    {
      type: "bar",

      data: {

        labels:
          models.map(
            model => model.name
          ),

        datasets: [
          {
            label: "Cost",
            data:
              models.map(
                model => model.cost
              )
          }
        ]
      },

      options: {

        indexAxis: "y",

        responsive: true,
        maintainAspectRatio: false,

        plugins: {

          legend: {
            display: false
          },

          tooltip: {
            callbacks: {
              label(context) {
                return formatMoney(
                  context.raw
                );
              }
            }
          }
        }
      }
    }
  );
}


function renderModelTable(data) {

  const table =
    document.querySelector("#modelTable");


  table.innerHTML =
    data.models
      .map(model => `

        <tr>

          <td>
            <strong>
              ${model.name}
            </strong>
          </td>

          <td>
            ${number.format(model.requests)}
          </td>

          <td>
            ${formatTokens(model.total_tokens)}
          </td>

          <td>
            ${formatMoney(model.cost)}
          </td>

          <td>
            ${(model.cost_share * 100).toFixed(2)}%
          </td>

          <td>
            ${formatMoney(model.avg_cost_per_request)}
          </td>

        </tr>

      `)
      .join("");
}


async function main() {

  try {

    const data =
      await loadDashboard();

    renderSummary(data);

    renderQuota(data);

    renderModelTable(data);

    renderDailyChart(data);

    renderModelChart(data);

  } catch (error) {

    console.error(error);

    document.querySelector("#updated").textContent =
      "Failed to load usage data";

  }
}


main();
