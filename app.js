const REST_BASES = [
    "https://data-api.binance.vision/api/v3",
    "https://api.binance.com/api/v3"
];
const WS_BASES = [
    "wss://stream.binance.com:9443/stream?streams=",
    "wss://data-stream.binance.vision/stream?streams="
];

const STORAGE_KEY = "binance_clone_sim_v1";
const FALLBACK_USDT_MXN = 17.0;
const DEFAULT_BALANCE_MXN = 10000;

const TOP_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TIAUSDT"];
const TIMEFRAME_MAP = {
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d"
};

let activeRestBase = REST_BASES[0];
let activeWsBase = WS_BASES[0];

let appState = {
    balanceMxn: DEFAULT_BALANCE_MXN,
    selectedSymbol: "BTCUSDT",
    timeframe: "1h",
    leverage: 20,
    usdtMxn: FALLBACK_USDT_MXN,
    spotPositions: {},
    perpPositions: []
};

let market = new Map();
let orderBook = { bids: [], asks: [] };
let lastPriceBySymbol = new Map();

let chartApi = null;
let candleSeries = null;
let ma7Series = null;
let ma25Series = null;
let ma99Series = null;
let candles = [];

let tickerPoll = null;
let tickerSocket = null;
let klineSocket = null;
let depthSocket = null;
let mentorOpen = false;

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        appState = {
            ...appState,
            ...parsed,
            spotPositions: parsed.spotPositions || {},
            perpPositions: Array.isArray(parsed.perpPositions) ? parsed.perpPositions : []
        };
    } catch (_err) {
        // ignore invalid localStorage
    }
}

function formatMxn(value) {
    return new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
        maximumFractionDigits: 2
    }).format(Number(value || 0));
}

function formatUsdt(value, decimals = 4) {
    return Number(value || 0).toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals
    });
}

function usdtToMxn(value) {
    return Number(value || 0) * appState.usdtMxn;
}

async function fetchJson(url, timeoutMs = 9000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

async function fetchBinance(path) {
    let lastError = null;
    for (let i = 0; i < REST_BASES.length; i += 1) {
        const base = REST_BASES[i];
        try {
            const data = await fetchJson(`${base}${path}`);
            activeRestBase = base;
            activeWsBase = WS_BASES[Math.min(i, WS_BASES.length - 1)];
            return data;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error("No se pudo consultar Binance");
}

function setTickerRowClickHandlers() {
    document.querySelectorAll(".ticker-item").forEach((item) => {
        item.addEventListener("click", async () => {
            const symbol = item.dataset.symbol;
            if (!symbol || symbol === appState.selectedSymbol) return;
            appState.selectedSymbol = symbol;
            saveState();
            document.getElementById("symbolName").textContent = symbol;
            await refreshSymbolData();
        });
    });
}

function renderTickerBar() {
    const tickerBar = document.getElementById("tickerBar");
    tickerBar.innerHTML = TOP_SYMBOLS.map((symbol) => {
        const t = market.get(symbol);
        const price = t ? formatMxn(usdtToMxn(t.lastPrice)) : "-";
        const change = t ? t.changePct : 0;
        return `
            <div class="ticker-item" data-symbol="${symbol}">
                <span class="ticker-symbol">${symbol}</span>
                <span class="ticker-price">${price}</span>
                <span class="ticker-change ${change >= 0 ? "positive" : "negative"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span>
            </div>
        `;
    }).join("");

    setTickerRowClickHandlers();
}

function renderHeaderPrice() {
    const t = market.get(appState.selectedSymbol);
    const priceEl = document.getElementById("currentPrice");
    const changeEl = document.getElementById("priceChange");

    if (!t) {
        priceEl.textContent = "-";
        changeEl.textContent = "-";
        return;
    }

    const lastPrice = Number(t.lastPrice || 0);
    const changePct = Number(t.changePct || 0);
    const mxn = formatMxn(usdtToMxn(lastPrice));
    priceEl.textContent = `${mxn}`;

    changeEl.textContent = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    changeEl.className = `price-change ${changePct >= 0 ? "positive" : "negative"}`;

    document.getElementById("priceInput").value = lastPrice ? usdtToMxn(lastPrice).toFixed(2) : "";
    document.getElementById("symbolName").textContent = appState.selectedSymbol;
    document.getElementById("usdtMxn").textContent = appState.usdtMxn.toFixed(4);
}

function parseKlines(raw) {
    return raw.map((k) => ({
        time: Math.floor(k[0] / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5])
    }));
}

function calcMA(values, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
        sum += values[i].close;
        if (i >= period) sum -= values[i - period].close;
        if (i >= period - 1) {
            out.push({ time: values[i].time, value: sum / period });
        }
    }
    return out;
}

function ensureSeries(chart, type, options) {
    if (type === "candles") {
        if (typeof chart.addCandlestickSeries === "function") return chart.addCandlestickSeries(options);
        if (typeof chart.addSeries === "function" && LightweightCharts.CandlestickSeries) {
            return chart.addSeries(LightweightCharts.CandlestickSeries, options);
        }
    }
    if (type === "line") {
        if (typeof chart.addLineSeries === "function") return chart.addLineSeries(options);
        if (typeof chart.addSeries === "function" && LightweightCharts.LineSeries) {
            return chart.addSeries(LightweightCharts.LineSeries, options);
        }
    }
    return null;
}

function initChart() {
    const container = document.getElementById("chartContainer");
    chartApi = LightweightCharts.createChart(container, {
        layout: { background: { color: "#1E2329" }, textColor: "#848E9C" },
        grid: { vertLines: { color: "#2B3139" }, horzLines: { color: "#2B3139" } },
        rightPriceScale: { borderColor: "#2B3139" },
        timeScale: { borderColor: "#2B3139", timeVisible: true, secondsVisible: false }
    });

    candleSeries = ensureSeries(chartApi, "candles", {
        upColor: "#0ECB81",
        downColor: "#F6465D",
        borderVisible: false,
        wickUpColor: "#0ECB81",
        wickDownColor: "#F6465D"
    });

    ma7Series = ensureSeries(chartApi, "line", { color: "#F0B90B", lineWidth: 1, priceLineVisible: false });
    ma25Series = ensureSeries(chartApi, "line", { color: "#3A6AB5", lineWidth: 1, priceLineVisible: false });
    ma99Series = ensureSeries(chartApi, "line", { color: "#8A2BE2", lineWidth: 1, priceLineVisible: false });

    const resize = () => chartApi.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    window.addEventListener("resize", resize);
    resize();
}

function renderChart() {
    if (!candleSeries) return;
    candleSeries.setData(candles);

    const ma7 = calcMA(candles, 7);
    const ma25 = calcMA(candles, 25);
    const ma99 = calcMA(candles, 99);

    ma7Series?.setData(ma7);
    ma25Series?.setData(ma25);
    ma99Series?.setData(ma99);

    const ma7Last = ma7[ma7.length - 1]?.value;
    const ma25Last = ma25[ma25.length - 1]?.value;
    const ma99Last = ma99[ma99.length - 1]?.value;

    document.getElementById("ma7").textContent = ma7Last ? formatMxn(usdtToMxn(ma7Last)) : "-";
    document.getElementById("ma25").textContent = ma25Last ? formatMxn(usdtToMxn(ma25Last)) : "-";
    document.getElementById("ma99").textContent = ma99Last ? formatMxn(usdtToMxn(ma99Last)) : "-";
}

async function loadCandles() {
    const interval = TIMEFRAME_MAP[appState.timeframe] || "1h";
    const raw = await fetchBinance(`/klines?symbol=${appState.selectedSymbol}&interval=${interval}&limit=300`);
    candles = parseKlines(raw);
    renderChart();
}

function closeSocket(socketRef) {
    if (!socketRef) return;
    try {
        socketRef.onopen = null;
        socketRef.onmessage = null;
        socketRef.onerror = null;
        socketRef.onclose = null;
        if (socketRef.readyState === WebSocket.OPEN || socketRef.readyState === WebSocket.CONNECTING) {
            socketRef.close(1000, "switch");
        }
    } catch (_err) {
        // ignore close race
    }
}

function connectKlineSocket() {
    closeSocket(klineSocket);

    const interval = TIMEFRAME_MAP[appState.timeframe] || "1h";
    const stream = `${appState.selectedSymbol.toLowerCase()}@kline_${interval}`;
    klineSocket = new WebSocket(`${activeWsBase}${stream}`);

    klineSocket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        const k = payload?.data?.k;
        if (!k || !candleSeries) return;

        const c = {
            time: Math.floor(k.t / 1000),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v)
        };

        const last = candles[candles.length - 1];
        if (last && last.time === c.time) candles[candles.length - 1] = c;
        else candles.push(c);

        candleSeries.update(c);

        const t = market.get(appState.selectedSymbol) || {};
        t.lastPrice = c.close;
        market.set(appState.selectedSymbol, t);
        renderHeaderPrice();
        renderPositions();

        if (candles.length % 3 === 0) {
            renderChart();
        }
    };
}

async function loadDepthSnapshot() {
    const raw = await fetchBinance(`/depth?symbol=${appState.selectedSymbol}&limit=20`);
    orderBook.asks = raw.asks.map((a) => ({ price: Number(a[0]), qty: Number(a[1]) }));
    orderBook.bids = raw.bids.map((b) => ({ price: Number(b[0]), qty: Number(b[1]) }));
    renderOrderBook();
}

function connectDepthSocket() {
    closeSocket(depthSocket);
    const stream = `${appState.selectedSymbol.toLowerCase()}@depth20@100ms`;
    depthSocket = new WebSocket(`${activeWsBase}${stream}`);

    depthSocket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        const data = payload?.data;
        if (!data) return;

        orderBook.asks = (data.asks || []).map((a) => ({ price: Number(a[0]), qty: Number(a[1]) }));
        orderBook.bids = (data.bids || []).map((b) => ({ price: Number(b[0]), qty: Number(b[1]) }));
        renderOrderBook();
    };
}

function renderOrderBook() {
    const asks = orderBook.asks.slice(0, 8);
    const bids = orderBook.bids.slice(0, 8);

    const asksHtml = asks.map((ask) => `
        <div class="order-row asks">
            <span class="price-cell">${formatMxn(usdtToMxn(ask.price))}</span>
            <span class="amount-cell">${formatUsdt(ask.qty, 4)}</span>
            <span class="total-cell">${formatMxn(usdtToMxn(ask.price * ask.qty))}</span>
        </div>
    `).join("");

    const bidsHtml = bids.map((bid) => `
        <div class="order-row bids">
            <span class="price-cell">${formatMxn(usdtToMxn(bid.price))}</span>
            <span class="amount-cell">${formatUsdt(bid.qty, 4)}</span>
            <span class="total-cell">${formatMxn(usdtToMxn(bid.price * bid.qty))}</span>
        </div>
    `).join("");

    document.getElementById("orderBookAsks").innerHTML = asksHtml;
    document.getElementById("orderBookBids").innerHTML = bidsHtml;

    if (asks.length && bids.length) {
        const spread = asks[0].price - bids[0].price;
        const spreadPct = (spread / asks[0].price) * 100;
        document.getElementById("spread").textContent = `Spread: ${formatMxn(usdtToMxn(spread))} (${spreadPct.toFixed(3)}%)`;

        const bidQty = bids.reduce((sum, x) => sum + x.qty, 0);
        const askQty = asks.reduce((sum, x) => sum + x.qty, 0);
        const total = bidQty + askQty || 1;
        document.getElementById("depthBid").style.width = `${(bidQty / total) * 100}%`;
        document.getElementById("depthAsk").style.width = `${(askQty / total) * 100}%`;
    }
}

function renderBalanceAndTotal() {
    const balanceEl = document.getElementById("balance");
    balanceEl.textContent = `${formatMxn(appState.balanceMxn)}`;

    const priceMxn = Number(document.getElementById("priceInput").value || 0);
    const amount = Number(document.getElementById("amountInput").value || 0);
    const totalMxn = priceMxn * amount;
    document.getElementById("totalAmount").textContent = `${formatMxn(totalMxn)}`;
}

function renderPositions() {
    const container = document.getElementById("positions");
    const rows = [];

    Object.entries(appState.spotPositions).forEach(([symbol, pos]) => {
        if (!pos || pos.qty <= 0) return;
        const price = market.get(symbol)?.lastPrice || pos.entry;
        const pnl = (price - pos.entry) * pos.qty;
        rows.push({
            label: `${symbol} Spot`,
            qty: pos.qty,
            entry: pos.entry,
            pnl
        });
    });

    appState.perpPositions.forEach((pos) => {
        const mark = market.get(pos.symbol)?.lastPrice || pos.entry;
        const raw = pos.side === "LONG" ? (mark - pos.entry) * pos.qty : (pos.entry - mark) * pos.qty;
        const pnl = raw * pos.leverage;
        rows.push({
            label: `${pos.symbol} ${pos.side}`,
            qty: pos.qty,
            entry: pos.entry,
            pnl
        });
    });

    if (!rows.length) {
        container.innerHTML = '<div class="position-empty">Sin posiciones abiertas</div>';
        return;
    }

    container.innerHTML = rows.map((row) => `
        <div class="position-item">
            <span>${row.label}</span>
            <span>${formatUsdt(row.qty, 4)}</span>
            <span>${formatMxn(usdtToMxn(row.entry))}</span>
            <span class="${row.pnl >= 0 ? "pnl-positive" : "pnl-negative"}">${formatMxn(usdtToMxn(row.pnl))}</span>
        </div>
    `).join("");
}

function updateTickerMarketData(rawTickers) {
    rawTickers.forEach((t) => {
        market.set(t.symbol, {
            lastPrice: Number(t.lastPrice),
            changePct: Number(t.priceChangePercent),
            high: Number(t.highPrice),
            low: Number(t.lowPrice)
        });
        lastPriceBySymbol.set(t.symbol, Number(t.lastPrice));
    });
}

async function loadInitialMarket() {
    const query = encodeURIComponent(JSON.stringify(TOP_SYMBOLS));
    const [tickers, usdtMxnRaw] = await Promise.all([
        fetchBinance(`/ticker/24hr?symbols=${query}`),
        fetchBinance("/ticker/price?symbol=USDTMXN").catch(() => ({ price: FALLBACK_USDT_MXN }))
    ]);

    updateTickerMarketData(tickers);
    appState.usdtMxn = Number(usdtMxnRaw.price) || FALLBACK_USDT_MXN;
    saveState();

    renderTickerBar();
    renderHeaderPrice();
}

function startTickerPolling() {
    if (tickerPoll) clearInterval(tickerPoll);
    tickerPoll = setInterval(async () => {
        try {
            const query = encodeURIComponent(JSON.stringify(TOP_SYMBOLS));
            const tickers = await fetchBinance(`/ticker/24hr?symbols=${query}`);
            updateTickerMarketData(tickers);
            renderTickerBar();
            renderHeaderPrice();
            renderPositions();
        } catch (_err) {
            // keep UI running
        }
    }, 4000);
}

function wireEvents() {
    document.querySelectorAll(".timeframe-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            document.querySelectorAll(".timeframe-btn").forEach((x) => x.classList.remove("active"));
            btn.classList.add("active");
            appState.timeframe = btn.dataset.timeframe;
            saveState();
            await refreshSymbolData();
        });
    });

    document.getElementById("leverageSelect").addEventListener("change", (e) => {
        appState.leverage = Number(e.target.value);
        saveState();
    });

    document.getElementById("priceInput").addEventListener("input", renderBalanceAndTotal);
    document.getElementById("amountInput").addEventListener("input", renderBalanceAndTotal);

    document.getElementById("buyBTCBtn").addEventListener("click", () => executeSpot("BUY"));
    document.getElementById("sellBTCBtn").addEventListener("click", () => executeSpot("SELL"));
    document.getElementById("buyLongBtn").addEventListener("click", () => executePerp("LONG"));
    document.getElementById("sellShortBtn").addEventListener("click", () => executePerp("SHORT"));
}

function executeSpot(side) {
    const symbol = appState.selectedSymbol;
    const priceMxn = Number(document.getElementById("priceInput").value || 0);
    const price = priceMxn / appState.usdtMxn;
    const qty = Number(document.getElementById("amountInput").value || 0);
    if (!price || !qty) return;

    const costUsdt = price * qty;
    const costMxn = usdtToMxn(costUsdt);

    const current = appState.spotPositions[symbol] || { qty: 0, entry: 0 };

    if (side === "BUY") {
        if (costMxn > appState.balanceMxn) return;
        const prevValue = current.qty * current.entry;
        current.qty += qty;
        current.entry = (prevValue + costUsdt) / current.qty;
        appState.balanceMxn -= costMxn;
    } else {
        if (qty > current.qty) return;
        current.qty -= qty;
        appState.balanceMxn += costMxn;
        if (current.qty <= 0) current.entry = 0;
    }

    appState.spotPositions[symbol] = current;
    saveState();
    renderBalanceAndTotal();
    renderPositions();
}

function executePerp(side) {
    const symbol = appState.selectedSymbol;
    const priceMxn = Number(document.getElementById("priceInput").value || 0);
    const price = priceMxn / appState.usdtMxn;
    const qty = Number(document.getElementById("amountInput").value || 0);
    if (!price || !qty) return;

    const marginMxn = usdtToMxn((price * qty) / Math.max(appState.leverage, 1));
    if (marginMxn > appState.balanceMxn) return;

    appState.balanceMxn -= marginMxn;
    appState.perpPositions.unshift({
        symbol,
        side,
        qty,
        entry: price,
        leverage: appState.leverage,
        marginMxn,
        openedAt: new Date().toISOString()
    });
    appState.perpPositions = appState.perpPositions.slice(0, 15);

    saveState();
    renderBalanceAndTotal();
    renderPositions();
}

function buildMentorInsights() {
    const symbol = appState.selectedSymbol;
    const ticker = market.get(symbol);
    const lines = [];
    if (!ticker || candles.length < 30) {
        lines.push("Aun no hay suficientes datos para una lectura completa. Espera unos segundos.");
        return lines;
    }

    const close = candles[candles.length - 1].close;
    const prev = candles[candles.length - 2]?.close || close;
    const ma7 = calcMA(candles, 7).at(-1)?.value;
    const ma25 = calcMA(candles, 25).at(-1)?.value;
    const ma99 = calcMA(candles, 99).at(-1)?.value;
    const move = ((close - prev) / prev) * 100;

    lines.push(`${symbol}: ${formatMxn(usdtToMxn(close))} (${ticker.changePct >= 0 ? "+" : ""}${ticker.changePct.toFixed(2)}% 24h).`);
    lines.push(`Movimiento de la ultima vela: ${move >= 0 ? "+" : ""}${move.toFixed(2)}%.`);

    if (ma7 && ma25) {
        lines.push(ma7 > ma25
            ? "Tendencia corta alcista: MA(7) arriba de MA(25)."
            : "Tendencia corta bajista: MA(7) debajo de MA(25).");
    }
    if (ma99) {
        lines.push(close > ma99
            ? "Precio por arriba de MA(99): sesgo estructural alcista."
            : "Precio por debajo de MA(99): sesgo estructural defensivo.");
    }

    const spot = appState.spotPositions[symbol];
    if (spot && spot.qty > 0) {
        const pnl = (close - spot.entry) * spot.qty;
        lines.push(`Tu spot en ${symbol}: ${spot.qty.toFixed(4)} con PnL no realizado de ${formatMxn(usdtToMxn(pnl))}.`);
    } else {
        lines.push("No tienes spot abierto en este par. Puedes practicar con entradas pequeñas.");
    }

    lines.push(`Riesgo sugerido: no arriesgues mas de 1% a 2% de tu saldo por operación.`);
    return lines;
}

function openMentor() {
    const overlay = document.getElementById("mentorOverlay");
    const list = document.getElementById("mentorList");
    if (!overlay || !list) return;
    list.innerHTML = buildMentorInsights().map((line) => `<li>${line}</li>`).join("");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    mentorOpen = true;
}

function closeMentor() {
    const overlay = document.getElementById("mentorOverlay");
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    mentorOpen = false;
}

function wireMentorHotkeys() {
    const closeBtn = document.getElementById("mentorCloseBtn");
    const overlay = document.getElementById("mentorOverlay");
    closeBtn?.addEventListener("click", closeMentor);
    overlay?.addEventListener("click", (e) => {
        if (e.target === overlay) closeMentor();
    });

    document.addEventListener("keydown", (e) => {
        const isToggle = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
        if (isToggle) {
            e.preventDefault();
            if (mentorOpen) closeMentor();
            else openMentor();
        }
        if (e.key === "Escape" && mentorOpen) {
            closeMentor();
        }
    });
}

async function refreshSymbolData() {
    renderHeaderPrice();
    await Promise.allSettled([loadCandles(), loadDepthSnapshot()]);
    connectKlineSocket();
    connectDepthSocket();
}

async function initialize() {
    loadState();

    document.getElementById("leverageSelect").value = String(appState.leverage || 20);
    document.querySelectorAll(".timeframe-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.timeframe === appState.timeframe);
    });

    initChart();
    wireEvents();
    wireMentorHotkeys();

    await loadInitialMarket();
    await refreshSymbolData();
    startTickerPolling();
    renderBalanceAndTotal();
    renderPositions();
}

window.addEventListener("DOMContentLoaded", () => {
    initialize().catch((err) => {
        console.error("init error", err);
    });
});
