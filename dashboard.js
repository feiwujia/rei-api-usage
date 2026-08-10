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
    latency: raw.usage?.average_duration_ms || 0
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

  return normalize(raw);
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


  const latest =
    data.daily[data.daily.length - 1];

  document.querySelector("#updated").textContent =
    latest
      ? `Latest usage: ${latest.date}`
      : "No usage data";
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

  const labels =
    data.daily.map(
      row => row.date.slice(5)
    );


  const costs =
    data.daily.map(
      row =>
        Number(
          row.actual_cost ??
          row.cost ??
          0
        )
    );


  new Chart(
    document.querySelector("#costChart"),
    {
      type: "line",

      data: {
        labels,

        datasets: [
          {
            label: "Daily cost",
            data: costs,
            tension: 0.3,
            fill: true
          }
        ]
      },

      options: {
        responsive: true,
        maintainAspectRatio: false,

        interaction: {
          intersect: false,
          mode: "index"
        },

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


function renderModelChart(data) {

  const models =
    data.models.slice(0, 7);


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

    renderDailyChart(data);

    renderModelChart(data);

    renderModelTable(data);

  } catch (error) {

    console.error(error);

    document.querySelector("#updated").textContent =
      "Failed to load usage data";

  }
}


main();
