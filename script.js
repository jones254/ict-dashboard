// script.js — ICT multi-timeframe analyzer (15m added) 
// Replace the API keys below with your own
document.addEventListener("DOMContentLoaded", () => {

const POLY_API_KEY = "kMIVSYalfpLCApmVaF1Zepb4CA5XFjRm"; // replace if needed
const TD_API_KEY   = "d1babeb679ab40b3874b0541d46f6059"; // replace with your key

// ---------------- pairs ----------------
const pairs = [
  "C:EURUSD","C:GBPUSD","C:USDJPY","C:USDCAD","C:AUDUSD",
  "C:NZDUSD","C:EURGBP","C:EURJPY","C:GBPJPY","C:CHFJPY",
  "C:AUDJPY","C:NZDJPY","C:EURCAD","C:GBPCAD","C:CADJPY",
  "C:USDCHF","C:EURCHF","C:GBPCHF","C:AUDCAD","C:NZDCAD"
];

const pairSelect = document.getElementById("pairSelect");
pairs.forEach(p => pairSelect.insertAdjacentHTML("beforeend", `<option value="${p}">${p.replace("C:", "")}</option>`));
pairSelect.value = "C:EURUSD";

// mode (affects confidence weighting if you want later)
const modeSelect = document.getElementById("modeSelect");

// ---------------- timeframes (15m added) ----------------
const timeframes = {
  "weekly": { source: "polygon", mult:1, span:"week" },
  "daily":  { source: "polygon", mult:1, span:"day" },
  "4hour":  { source: "twelvedata", interval:"4h" },
  "1hour":  { source: "twelvedata", interval:"1h" },
  "15min":  { source: "twelvedata", interval:"15m" }      // << NEW: 15-minute timeframe
};

// ---------------- helpers ----------------
const sleep = ms => new Promise(res => setTimeout(res, ms));
const average = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : NaN;
const sma = (arr,n) => arr.length < n ? NaN : average(arr.slice(arr.length-n));

function rsi(arr, p=14){
  if (!Array.isArray(arr) || arr.length < p+1) return NaN;
  let gains=0, losses=0;
  for (let i=arr.length-p;i<arr.length;i++){
    const d = arr[i] - arr[i-1];
    if (d>0) gains += d; else losses += Math.abs(d);
  }
  const avgG = gains/p, avgL = losses/p;
  if (avgL === 0) return 100;
  const rs = avgG/avgL;
  return 100 - 100/(1+rs);
}

const trend = (s50,s200) =>
  (isNaN(s50)||isNaN(s200)) ? "Neutral" : (s50 > s200 ? "Up" : s50 < s200 ? "Down" : "Neutral");

// ---------------- date ranges (tailored for intraday) ----------------
function rangeFor(tf){
  const now = new Date();
  let start = new Date();
  if (tf === "weekly") start.setFullYear(now.getFullYear()-5);
  else if (tf === "daily") start.setFullYear(now.getFullYear()-1);
  else if (tf === "4hour") start.setDate(now.getDate()-10);
  else if (tf === "1hour") start.setDate(now.getDate()-3);
  else if (tf === "15min") start.setDate(now.getDate()-2); // last 2 days enough for 15m
  return { from: start.toISOString().slice(0,10), to: now.toISOString().slice(0,10) };
}

// ---------------- polygon fetch ----------------
async function fetchPolygonAggs(ticker,mult,span,from,to,attempt=1){
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${mult}/${span}/${from}/${to}?sort=asc&limit=500&apiKey=${POLY_API_KEY}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    if (j && Array.isArray(j.results) && j.results.length)
      return j.results.map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c}));
    if (attempt===1){ await sleep(700); return fetchPolygonAggs(ticker,mult,span,from,to,2); }
    return [];
  } catch(e){ return []; }
}

// ---------------- twelvedata fetch ----------------
function toTdSymbol(pair){ const raw = pair.replace("C:", ""); return `${raw.slice(0,3)}/${raw.slice(3,6)}`; }

async function fetchTwelveDataIntraday(pair, interval, outputsize=500, attempt=1){
  const symbol = toTdSymbol(pair);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&format=JSON&apikey=${TD_API_KEY}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    if (j && Array.isArray(j.values) && j.values.length){
      const asc = j.values.slice().reverse();
      return asc.map(v=>({
        t: new Date(v.datetime).getTime(),
        o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close)
      }));
    }
    if (attempt===1){ await sleep(700); return fetchTwelveDataIntraday(pair,interval,outputsize,2); }
    return [];
  } catch(e){ return []; }
}

// ---------------- unified fetch ----------------
async function fetchForTimeframe(pair, tfKey){
  const tf = timeframes[tfKey];
  if (!tf) return [];
  if (tf.source === "polygon"){
    const {from,to} = rangeFor(tfKey);
    return await fetchPolygonAggs(pair, tf.mult, tf.span, from, to);
  }
  if (tf.source === "twelvedata"){
    return await fetchTwelveDataIntraday(pair, tf.interval, 500);
  }
  return [];
}

// ---------------- confidence calculation (updated to include 15min expected bars) ----------------
function calculateConfidence(results, barsByTf, mode = "standard"){
  // base weights — can be adjusted by mode
  let trendWeight = 40, rsiWeight = 20, smaWeight = 20, dataWeight = 10, volWeight = 10;
  if (mode === "conservative"){ trendWeight += 5; dataWeight += 5; rsiWeight -= 5; }
  if (mode === "aggressive"){ rsiWeight += 5; volWeight -= 5; }

  let score = 0;
  const overall = results["Overall"];
  const dominant = overall.Dominant;

  // 1. trend agreement
  const tfs = Object.keys(timeframes);
  const trends = tfs.map(tf => results[tf] && results[tf].Trend ? results[tf].Trend : "Neutral");
  const agreeCount = trends.filter(t => t === dominant).length;
  score += (agreeCount / tfs.length) * trendWeight;

  // 2. RSI support
  const rsis = tfs.map(tf => results[tf] && typeof results[tf].RSI === "number" ? results[tf].RSI : NaN).filter(v=>!isNaN(v));
  let rsiSupport = 0;
  if (dominant === "Up") rsiSupport = rsis.filter(v => v < 55).length;
  if (dominant === "Down") rsiSupport = rsis.filter(v => v > 45).length;
  score += (rsis.length ? (rsiSupport / rsis.length) : 0) * rsiWeight;

  // 3. SMA support
  let smaSupport = 0;
  tfs.forEach(tf => {
    const r = results[tf];
    if (!r) return;
    if (typeof r.SMA50 === "number" && typeof r.SMA200 === "number"){
      if (dominant === "Up" && r.SMA50 > r.SMA200) smaSupport++;
      if (dominant === "Down" && r.SMA50 < r.SMA200) smaSupport++;
    }
  });
  score += (smaSupport / tfs.length) * smaWeight;

  // 4. data quality (expected bars per tf)
  const expected = { weekly:250, daily:365, "4hour":200, "1hour":120, "15min": (24*4)*2 }; // ~2 days for 15m
  let returned = 0, expectTotal = 0;
  tfs.forEach(tf => { expectTotal += (expected[tf]||0); returned += (results[tf] && results[tf].Bars) ? results[tf].Bars : 0; });
  score += Math.min((returned / expectTotal), 1) * dataWeight;

  // 5. volatility stability (use daily bars)
  const dailyBars = barsByTf["daily"] || [];
  if (dailyBars.length){
    const closes = dailyBars.map(b => b.c);
    const avg = closes.reduce((a,b)=>a+b,0)/closes.length;
    const variance = closes.reduce((a,b)=>a + Math.pow(b - avg,2),0)/closes.length;
    const std = Math.sqrt(variance);
    let volScore = 10 - Math.min(std*2, 10); // scale
    if (volScore < 0) volScore = 0;
    score += (volScore / 10) * volWeight;
  }

  return Math.round(score);
}

// ---------------- helper: choose bars to render (prefer most granular present) ----------------
function pickChartBars(barsByTf){
  // preference from most granular to least
  const order = ["15min","1hour","4hour","daily","weekly"];
  for (const tf of order){
    if (barsByTf[tf] && barsByTf[tf].length) return { bars: barsByTf[tf], tf };
  }
  return { bars: [], tf: null };
}

// ---------------- main run handler ----------------
const runBtn = document.getElementById("runBtn");
runBtn.onclick = async () => {
  const pair = pairSelect.value;
  const mode = modeSelect.value;

  if (!pair) return alert("Choose a pair");

  document.getElementById("results").innerHTML = `<div class="bg-white p-4 rounded-lg shadow">Running analysis for ${pair.replace("C:","")}...</div>`;
  document.getElementById("chartMeta").textContent = "";

  const barsByTf = {};   // store fetched bars per timeframe
  const results = {};

  const order = ["weekly","daily","4hour","1hour","15min"];

  for (let i=0;i<order.length;i++){
    const tf = order[i];
    if (i !== 0) await sleep(600); // rate-limit friendly

    let bars = await fetchForTimeframe(pair, tf);

    // If intraday missing, fallback to daily (but still record missing)
    if ((tf === "4hour" || tf === "1hour" || tf === "15min") && (!bars || bars.length === 0)){
      // ensure daily is loaded
      if (!barsByTf["daily"] || !barsByTf["daily"].length){
        await sleep(200);
        barsByTf["daily"] = await fetchForTimeframe(pair, "daily");
      }
      if (barsByTf["daily"] && barsByTf["daily"].length){
        // fallback uses daily bars for indicators, but mark Bars count accordingly
        bars = barsByTf["daily"];
      } else {
        bars = [];
      }
    }

    barsByTf[tf] = bars;

    if (!bars || bars.length === 0){
      results[tf] = { Error: "No data", Bars: 0 };
      continue;
    }

    const closes = bars.map(b => b.c).filter(x => typeof x === "number");
    const s50 = sma(closes,50);
    const s200 = sma(closes,200);
    const rsiVal = rsi(closes,14);

    results[tf] = {
      Close: closes.at(-1),
      RSI: isNaN(rsiVal) ? "N/A" : Number(rsiVal.toFixed(2)),
      SMA50: isNaN(s50) ? "N/A" : Number(s50.toFixed(6)),
      SMA200: isNaN(s200) ? "N/A" : Number(s200.toFixed(6)),
      Trend: trend(s50,s200),
      Bars: closes.length
    };
  }

  // overall aggregator
  const trendCounts = {};
  Object.values(results).forEach(r => { if (r && r.Trend && r.Trend !== "Neutral") trendCounts[r.Trend] = (trendCounts[r.Trend]||0)+1; });
  let dominant = "Neutral";
  if (Object.keys(trendCounts).length) dominant = Object.keys(trendCounts).reduce((a,b)=>trendCounts[a]>trendCounts[b]?a:b);
  const allRSIs = Object.values(results).map(r=> typeof r.RSI === "number" ? r.RSI : null).filter(x=>x!==null);
  const avgRsi = allRSIs.length ? Number((allRSIs.reduce((a,b)=>a+b,0)/allRSIs.length).toFixed(2)) : "N/A";

  let advice = "NEUTRAL";
  if (dominant==="Up" && avgRsi < 45) advice = "STRONG BUY";
  else if (dominant==="Down" && avgRsi > 55) advice = "STRONG SELL";
  else if (dominant==="Up") advice = "BUY";
  else if (dominant==="Down") advice = "SELL";

  // build overall then compute confidence
  results["Overall"] = { Dominant: dominant, AvgRSI: avgRsi, Advice: advice };
  const confidenceScore = calculateConfidence(results, barsByTf, mode);
  results["Overall"].Confidence = confidenceScore + "%";

  renderResults(results);
  // pick bars for chart (prefer 15m then 1h etc)
  const picked = pickChartBars(barsByTf);
  document.getElementById("chartMeta").innerHTML = picked.tf ? `<span class="timeframe-badge">${picked.tf.toUpperCase()}</span>` : "";
  renderCharts(picked.bars);

  // update confidence UI
  document.getElementById("confidenceBar").style.width = results["Overall"].Confidence;
  document.getElementById("confidenceText").textContent = `Confidence: ${results["Overall"].Confidence} (${mode} mode)`;
};

// ---------------- render results ----------------
function renderResults(results){
  const out = document.getElementById("results");
  out.innerHTML = "";
  const order = ["weekly","daily","4hour","1hour","15min","Overall"];
  order.forEach(tf => {
    if (!results[tf]) return;
    const r = results[tf];
    const title = tf === "Overall" ? "Overall" : tf.toUpperCase();

    let body = "";
    if (r.Error) body = `<div class="text-red-600 font-semibold">${r.Error}</div>`;
    else {
      body = `<div class="grid grid-cols-2 gap-2 text-sm">`;
      for (const k in r) body += `<div class="text-gray-600">${k}</div><div class="font-mono">${r[k]}</div>`;
      body += `</div>`;
    }

    out.insertAdjacentHTML("beforeend", `
      <div class="bg-white p-4 rounded-xl shadow mb-3">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold">${title}</h3>
        </div>
        ${body}
      </div>
    `);
  });
}

// ---------------- defensive charts ----------------
function renderCharts(bars){
  const chartDiv = document.getElementById("chart");
  const rsiDiv = document.getElementById("rsiChart");
  chartDiv.innerHTML = ""; rsiDiv.innerHTML = "";

  if (!bars || bars.length === 0) {
    console.warn("renderCharts: no bars");
    return;
  }

  // convert to lightweight format and validate times
  let candleData = bars.map(b => ({
    time: Math.floor(Number(b.t) / 1000),
    open: Number(b.o),
    high: Number(b.h),
    low:  Number(b.l),
    close:Number(b.c)
  }));

  // check time sequence
  let badTime = false;
  for (let i=1;i<candleData.length;i++){
    if (candleData[i].time <= candleData[i-1].time) { badTime = true; break; }
  }
  if (badTime){
    console.warn("renderCharts: bad timestamps — regenerating monotonic times");
    const base = Math.floor(Date.now() / 1000) - candleData.length * 60 * 15; // assume 15m spacing
    candleData = candleData.map((c,i)=>({ ...c, time: base + i * 60 * 15 }));
  }

  try{
    const chart = LightweightCharts.createChart(chartDiv, {
      layout:{ background:{color:"#fff"}, textColor:"#333"},
      grid:{ vertLines:{color:"#eee"}, horzLines:{color:"#eee"}},
      rightPriceScale:{ scaleMargins:{ top:0.1, bottom:0.1 } },
      timeScale: { timeVisible:true, secondsVisible:false }
    });

    chart.addCandlestickSeries().setData(candleData);

    // RSI
    const closes = candleData.map(c=>c.close);
    const rsiSeriesData = [];
    for (let i=0;i<closes.length;i++){
      const seg = closes.slice(0,i+1);
      const val = rsi(seg,14);
      if (!isNaN(val)) rsiSeriesData.push({ time: candleData[i].time, value: Number(val.toFixed(2)) });
    }

    const rsiChart = LightweightCharts.createChart(rsiDiv, {
      layout:{ background:{color:"#fff"}, textColor:"#333"},
      rightPriceScale:{ visible:true }
    });

    rsiChart.addLineSeries().setData(rsiSeriesData);

  } catch(err){
    console.error("renderCharts error:", err);
  }
}

}); // DOMContentLoaded end
