// ================= CONFIG =================
const DEFAULT_API_KEY = ""; // optionally pre-fill
const API_BASE = "https://api.polygon.io";
const TIMEFRAMES = {
  monthly: {mult:1, span:"month"},
  weekly:  {mult:1, span:"week"},
  daily:   {mult:1, span:"day"},
  "4hour": {mult:4, span:"hour"},
  "1hour": {mult:1, span:"hour"}
};
const PAIRS = [
  "C:EURUSD","C:GBPUSD","C:USDJPY","C:USDCAD","C:AUDUSD","C:NZDUSD",
  "C:EURGBP","C:EURJPY","C:GBPJPY","C:CHFJPY","C:AUDJPY","C:NZDJPY",
  "C:EURCAD","C:GBPCAD","C:CADJPY","C:USDCHF","C:EURCHF","C:GBPCHF",
  "C:AUDCAD","C:NZDCAD"
];

// ================ UTIL ================
const sleep = ms => new Promise(r=>setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0,10);
const luxon = window.luxon;

// Simple average
const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;

// RSI same approach as Python
function computeRSI(values, period=14){
  if (values.length < period+1) return NaN;
  const gains=[], losses=[];
  for(let i=1;i<values.length;i++){
    const d = values[i]-values[i-1];
    gains.push(Math.max(d,0));
    losses.push(Math.max(-d,0));
  }
  const recentG = gains.slice(-period), recentL = losses.slice(-period);
  const avgG = avg(recentG), avgL = avg(recentL);
  if (avgL === 0) return 100;
  const rs = avgG/avgL;
  return 100 - (100/(1+rs));
}

function sma(values, n){
  if (values.length < n) return NaN;
  return avg(values.slice(-n));
}

function computeTrend(s50, s200){
  if (isNaN(s50) || isNaN(s200)) return "Neutral";
  return s50 > s200 ? "Up" : (s50 < s200 ? "Down" : "Neutral");
}

// ================== UI INIT ==================
const pairSelect = document.getElementById("pairSelect");
const runBtn = document.getElementById("runBtn");
const apiKeyInput = document.getElementById("apiKey");
apiKeyInput.value = DEFAULT_API_KEY;

PAIRS.forEach(p => {
  const o = document.createElement("option");
  o.value = p; o.textContent = p.replace("C:","");
  pairSelect.appendChild(o);
});

// Tabs
document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-content").forEach(c=>{
      c.id === tab ? c.classList.remove("hidden") : c.classList.add("hidden");
    });
  });
});
// activate first tab
document.querySelectorAll(".tab-btn")[0].click();

// ============ POLYGON FETCH WITH CACHING ============
function cacheKey(pair, mult, span){ return `poly_${pair}_${mult}_${span}`; }

async function fetchAggs(pair, mult, span, apiKey){
  const key = cacheKey(pair,mult,span);
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      const p = JSON.parse(cached);
      // keep cache for 12 hours
      if (Date.now() - (p._ts||0) < 1000*60*60*12) {
        console.log("cache hit", key);
        return p.data;
      }
    } catch(e){}
  }

  const url = `${API_BASE}/v2/aggs/ticker/${encodeURIComponent(pair)}/range/${mult}/${span}/2004-01-01/${today()}?sort=asc&limit=500&apiKey=${apiKey}`;
  try {
    const res = await fetch(url);
    const j = await res.json();
    const results = j.results || [];
    localStorage.setItem(key, JSON.stringify({ _ts: Date.now(), data: results }));
    return results;
  } catch(e){
    console.error("fetch error", e);
    return [];
  }
}

// ===== ICT/SMC FUNCTIONS (converted) =====
function findOrderBlocks(df){ // df: array of candle objects {t,o,h,l,c}
  const bull=[], bear=[];
  for(let i=2;i<df.length;i++){
    const prev = df[i-1], curr = df[i], prev2 = df[i-2];
    if (prev.c < prev.o && curr.c > prev2.h && curr.c > curr.o) bull.push(prev.t);
    if (prev.c > prev.o && curr.c < prev2.l && curr.c < curr.o) bear.push(prev.t);
  }
  return {bull,bear};
}

function findFVG(df){
  const fvg_up=[], fvg_down=[];
  for(let i=2;i<df.length;i++){
    const c1=df[i-2], c3=df[i];
    if (c3.l > c1.h) fvg_up.push({from:c1.t, to:c3.t, top:c1.h, bottom:c3.l});
    if (c3.h < c1.l) fvg_down.push({from:c1.t, to:c3.t, top:c1.l, bottom:c3.h});
  }
  return {fvg_up,fvg_down};
}

function getStructure(df){
  // simple rolling maxima/minima over 5 center
  const highs = df.map(d=>d.h), lows=df.map(d=>d.l);
  if (highs.length < 5) return "Neutral";
  const lastIdx = highs.length-1;
  const windowHigh = Math.max(...highs.slice(Math.max(0,lastIdx-4), lastIdx+1));
  const prev = highs[lastIdx-1] ?? highs[lastIdx];
  if (windowHigh > prev) return "HH";
  if (windowHigh < prev) return "LH";
  const windowLow = Math.min(...lows.slice(Math.max(0,lastIdx-4), lastIdx+1));
  const prevLow = lows[lastIdx-1] ?? lows[lastIdx];
  if (windowLow > prevLow) return "HL";
  if (windowLow < prevLow) return "LL";
  return "Neutral";
}

// Killzones (NY 8-11am ET, LDN 2-5am ET)
// timestamp is ms UTC
function isNYKillzone(tsMs){
  const dt = luxon.DateTime.fromMillis(tsMs, {zone:"utc"}).setZone("America/New_York");
  const h = dt.hour;
  return h >= 8 && h < 11;
}
function isLDNKillzone(tsMs){
  const dt = luxon.DateTime.fromMillis(tsMs, {zone:"utc"}).setZone("America/New_York");
  const h = dt.hour;
  return h >= 2 && h < 5;
}

// ============ RENDER HELPERS ============
function mkCardHTML(title, bodyHTML){
  return `<div class="bg-white p-4 rounded-xl shadow">${bodyHTML}</div>`;
}

// ============ CHARTS ============
let mainChart = null, candleSeries=null, rsiChart=null, rsiSeries=null;
function renderCandles(bars){
  // bars: array with fields t (ms), o,h,l,c
  document.getElementById("chart").innerHTML = "";
  document.getElementById("rsiChart").innerHTML = "";
  mainChart = LightweightCharts.createChart(document.getElementById("chart"), {
    layout: { textColor: '#0f172a', background: { color: '#ffffff' } },
    grid: { vertLines: { color:'#f1f5f9' }, horzLines: { color:'#f1f5f9' } }
  });
  candleSeries = mainChart.addCandlestickSeries();
  const data = bars.map(b => ({ time: Math.floor(b.t/1000), open: b.o, high: b.h, low: b.l, close: b.c }));
  candleSeries.setData(data);

  // RSI
  rsiChart = LightweightCharts.createChart(document.getElementById("rsiChart"), {
    layout: { background: { color:'#ffffff' }, textColor:'#0f172a' }
  });
  rsiSeries = rsiChart.addLineSeries();
  const closes = bars.map(b => b.c);
  const rsiData = closes.map((_,i)=>({
    time: Math.floor(bars[i].t/1000),
    value: computeRSI(closes.slice(0,i+1))
  })).filter(d=>!isNaN(d.value));
  rsiSeries.setData(rsiData);
}

// ============ RUN LOGIC ============
async function runAnalysis(){
  const apiKey = (document.getElementById("apiKey").value || "").trim();
  if (!apiKey) { alert("Please paste your Polygon API key (it will be exposed on the page)."); return; }

  const pair = document.getElementById("pairSelect").value;
  const mode = document.getElementById("modeSelect").value;

  // Clear UI
  document.getElementById("overviewCards").innerHTML = `<div class="p-4">Running analysis for ${pair} ...</div>`;
  document.getElementById("taResults").innerHTML = "";
  document.getElementById("ictResults").innerHTML = "";

  const resultsByTF = {};
  let dailyBars = [];

  // Fetch for each timeframe with polite delay (polygon free tier restrictions)
  for (const tfName of Object.keys(TIMEFRAMES)){
    const {mult, span} = TIMEFRAMES[tfName];
    const bars = await fetchAggs(pair, mult, span, apiKey); // returns ascending order
    if (!bars || bars.length===0) {
      resultsByTF[tfName] = {Error:"no data"};
    } else {
      const closes = bars.map(b => b.c);
      const rsiVal = computeRSI(closes);
      const s50 = sma(closes,50);
      const s200 = sma(closes,200);
      const trend = computeTrend(s50, s200);
      resultsByTF[tfName] = {
        Close: Number(closes.at(-1).toFixed(6)),
        RSI: isNaN(rsiVal) ? "N/A" : Number(rsiVal.toFixed(2)),
        SMA50: isNaN(s50)? "N/A": Number(s50.toFixed(6)),
        SMA200: isNaN(s200)? "N/A": Number(s200.toFixed(6)),
        Trend: trend,
        Bars: bars.length
      };

      // store daily for charts & ICT
      if (tfName === "daily") dailyBars = bars.map(b=>({t:b.t, o:b.o, h:b.h, l:b.l, c:b.c}));

      // polite sleep except after last
      if (tfName !== Object.keys(TIMEFRAMES).at(-1)) await sleep(12000);
    }
  }

  // overall advice
  const trendList = Object.values(resultsByTF).map(r=>r.Trend).filter(t=>t && t!=="Neutral");
  const dominant = trendList.length ? trendList.sort((a,b)=> trendList.filter(x=>x===a).length - trendList.filter(x=>x===b).length ).pop() : "Neutral";
  const rsiList = Object.values(resultsByTF).map(r=>parseFloat(r.RSI)).filter(v=>!isNaN(v));
  const avgRsi = rsiList.length ? (rsiList.reduce((a,b)=>a+b,0)/rsiList.length) : NaN;
  let advice = "NEUTRAL";
  if (dominant==="Up" && !isNaN(avgRsi) && avgRsi < 45) advice = "STRONG BUY";
  else if (dominant==="Down" && !isNaN(avgRsi) && avgRsi > 55) advice = "STRONG SELL";
  else if (dominant==="Up") advice = "BUY";
  else if (dominant==="Down") advice = "SELL";

  // render overview cards
  document.getElementById("overviewCards").innerHTML = "";
  document.getElementById("overviewCards").innerHTML += mkCardHTML("Summary",
    `<div><div class="card-title">Pair: ${pair.replace("C:","")}</div>
     <div class="small-muted">Dominant Trend: <span class="kv">${dominant}</span></div>
     <div class="small-muted">Avg RSI: <span class="kv">${isNaN(avgRsi) ? "N/A" : avgRsi.toFixed(2)}</span></div>
     <div class="small-muted">Advice: <span class="kv">${advice}</span></div></div>`
  );

  // TA results per timeframe
  const taContainer = document.getElementById("taResults");
  taContainer.innerHTML = "";
  for (const [k,v] of Object.entries(resultsByTF)){
    taContainer.innerHTML += mkCardHTML(k.toUpperCase(),
      `<div><div class="card-title">${k.toUpperCase()}</div>
       <div class="small-muted">Close: <span class="kv">${v.Close ?? "N/A"}</span></div>
       <div class="small-muted">RSI: <span class="kv">${v.RSI ?? "N/A"}</span></div>
       <div class="small-muted">SMA50: <span class="kv">${v.SMA50 ?? "N/A"}</span></div>
       <div class="small-muted">SMA200: <span class="kv">${v.SMA200 ?? "N/A"}</span></div>
       <div class="small-muted">Trend: <span class="kv">${v.Trend ?? "N/A"}</span></div></div>`
    );
  }

  // ========== ICT ANALYSIS (use daily for structure + OB/FVG) ==========
  const ictContainer = document.getElementById("ictResults");
  ictContainer.innerHTML = "";

  if (dailyBars.length === 0) {
    ictContainer.innerHTML = mkCardHTML("ICT", "<div>No daily data available for ICT analysis.</div>");
  } else {
    const ob = findOrderBlocks(dailyBars);
    const fvg = findFVG(dailyBars);
    const structure = getStructure(dailyBars);
    const latest = dailyBars.at(-1);
    const candleType = latest.c > latest.o ? "Bullish" : "Bearish";
    const inNY = isNYKillzone(latest.t);
    const inLDN = isLDNKillzone(latest.t);

    // HTF = daily, MTF = 4hour, LTF = 1hour
    const htf = structure;
    const mtf = "Check 4H"; // we already used TIMEFRAMES to populate mtf earlier; for brevity we show placeholder
    const ltfCandle = candleType;

    // ICT overall signal
    let bias = "Neutral";
    if (htf==="HH" || htf==="HL") bias = "Bullish";
    if (htf==="LL" || htf==="LH") bias = "Bearish";

    let signal = "WAIT";
    if (bias==="Bullish" && ltfCandle==="Bullish" && inNY) signal = "BUY – ICT Alignment (FVG/OB pullback)";
    if (bias==="Bearish" && ltfCandle==="Bearish" && inNY) signal = "SELL – ICT Alignment (FVG/OB pullback)";

    ictContainer.innerHTML += mkCardHTML("ICT Summary",
      `<div><div class="card-title">HTF Structure: ${htf}</div>
       <div class="small-muted">Bullish OBs: <span class="kv">${ob.bull.length}</span></div>
       <div class="small-muted">Bearish OBs: <span class="kv">${ob.bear.length}</span></div>
       <div class="small-muted">Bullish FVGs: <span class="kv">${fvg.fvg_up.length}</span></div>
       <div class="small-muted">Bearish FVGs: <span class="kv">${fvg.fvg_down.length}</span></div>
       <div class="small-muted">Latest Candle: <span class="kv">${ltfCandle}</span></div>
       <div class="small-muted">In NY Killzone: <span class="kv">${inNY}</span></div>
       <div class="small-muted">Signal: <span class="kv">${signal}</span></div></div>`
    );

    // show one card with some FVG/OB details
    const obDetailsHTML = `
      <div><strong>Recent OB (Bull):</strong>
      <div>${ob.bull.slice(-5).map(t=>luxon.DateTime.fromMillis(t).toISODate()).join(", ") || "—"}</div>
      <strong>Recent OB (Bear):</strong>
      <div>${ob.bear.slice(-5).map(t=>luxon.DateTime.fromMillis(t).toISODate()).join(", ") || "—"}</div>
      </div>`;
    ictContainer.innerHTML += mkCardHTML("OB / FVG (sample)", obDetailsHTML);
  }

  // Render charts from daily bars
  if (dailyBars.length) renderCandles(dailyBars);
}

// event
runBtn.addEventListener("click", runAnalysis);

// optional: run with default key if provided
if (DEFAULT_API_KEY) document.getElementById("apiKey").value = DEFAULT_API_KEY;
