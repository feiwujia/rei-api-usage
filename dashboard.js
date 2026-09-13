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
  const modelDays = new Map();
  const names = new Set();
  for (const snapshot of snapshots) {
    for (const row of snapshot.data.daily_usage || []) daily.set(row.date, row);
    const models = snapshot.data.model_stats;
    if (!Array.isArray(models)) continue;
    const values = new Map(models.map(model => [model.model, Number(model.actual_cost ?? model.cost ?? 0)]));
    for (const name of values.keys()) names.add(name);
    // Keep the last observed window total per day; differences are not daily costs.
    modelDays.set(shanghaiDay(snapshot.fetched_at), values);
  }
  for (const row of data.daily) daily.set(row.date, row);
  const dates = [...new Set([...daily.keys(), ...modelDays.keys()])].sort();
  return { daily, modelDays, names: [...names].sort(), dates, today: data.summary,
    end: shanghaiDay(data.updated) || dates.at(-1) };
}

function trendSeries(trends, range, mode, selectedModel = "") {
  if (range === "today" || range === "24h") return { labels: [range === "today" ? "Today" : "Last 24h"], datasets: [{
    label: "Input", data: [trends.today.input_tokens], backgroundColor: "#2563eb"
  }, { label: "Output", data: [trends.today.output_tokens], backgroundColor: "#10b981" }, {
    label: "Cache read", data: [trends.today.cache_read_tokens], backgroundColor: "#f59e0b"
  }] };
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
      return row ? Number(row.actual_cost ?? row.cost ?? 0) : null;
    }) }] : trends.names.filter(name => !selectedModel || name === selectedModel).map(name => ({
      label: name,
      borderColor: colors[trends.names.indexOf(name) % colors.length],
      data: labels.map(day => trends.modelDays.get(day)?.get(name) ?? null)
    }));
  return { labels, datasets: datasets.map(dataset => ({ ...dataset, tension: 0,
    pointRadius: 2, borderWidth: 2, fill: false, spanGaps: false })) };
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

  status.textContent =
    `${data.status || "unknown"} · ${data.mode || "unknown"}`;


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


  const reset =
    new Date(quota.reset_at);


  document.querySelector("#quotaReset").textContent =
    `Resets ${reset.toLocaleString()}`;
}


function renderDailyChart(data) {
  const modelChecks = document.querySelector("#trendModels");
  const selectedModels = new Set(data.trends.names);
  for (const name of data.trends.names) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${name}" checked><span>${name}</span>`;
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
      scales: { y: { beginAtZero: true, title: { display: true, text: "Tokens" } } },
      plugins: {
        legend: { display: true, position: "bottom", labels: { usePointStyle: true, pointStyle: "circle", padding: 18 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatMoney(ctx.raw)}` } }
      }
    }
  });
  function update() {
    const range = document.querySelector('input[name="range"]:checked').value;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    modelChecks.hidden = mode !== "models" || range === "today" || range === "24h";
    chart.data = trendSeries(data.trends, range, mode, "");
    chart.config.type = range === "today" || range === "24h" ? "bar" : "line";
    if (mode === "models") chart.data.datasets = chart.data.datasets.filter(dataset => selectedModels.has(dataset.label));
    chart.options.plugins.legend.display = mode === "models" || range === "today" || range === "24h";
    chart.options.scales.y.title.text = range === "today" || range === "24h" ? "Tokens" : "USD";
    document.querySelector("#trendMetric").textContent = range === "today"
      ? "Token composition today" : range === "24h" ? "Latest 24h view"
      : mode === "models" ? "Reported model cost · window totals, last snapshot per day" : "Daily API cost";
    document.querySelector("#trendTitle").textContent = range === "today" || range === "24h" ? "Token usage" : "Cost over time";
    const notice = document.querySelector("#trendNotice");
    const hasData = chart.data.datasets.some(dataset => dataset.data.some(value => value !== null));
    notice.textContent = data.historyUnavailable ? "History unavailable; showing latest data only."
      : !hasData ? "No observations in this period." : "";
    notice.hidden = !notice.textContent;
    chart.update();
  }
  for (const selector of ["#trendRange", "#trendMode"]) {
    document.querySelector(selector).addEventListener("change", update);
  }
  update();
}

function renderTodayChart(data) {
  const today = data.summary;
  new Chart(document.querySelector("#todayChart"), {
    type: "doughnut",
    data: { labels: ["Input", "Output", "Cache read"], datasets: [{
      data: [today.input_tokens || 0, today.output_tokens || 0, today.cache_read_tokens || 0],
      backgroundColor: ["#2563eb", "#10b981", "#f59e0b"], borderColor: "#fff", borderWidth: 3
    }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "66%",
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "circle", padding: 18 } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatTokens(ctx.raw)}` } } } }
  });
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
    renderTodayChart(data);

  } catch (error) {

    console.error(error);

    document.querySelector("#updated").textContent =
      "Failed to load usage data";

  }
}


main();
