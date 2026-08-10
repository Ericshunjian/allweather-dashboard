(() => {
  "use strict";

  const AUTH = window.PORTFOLIO_VAULT_AUTH;
  const SYNC_CONFIG = window.PORTFOLIO_SYNC_CONFIG || {};
  const STORAGE_KEY = "allweather.portfolio.vault.v1";
  const LOCAL_USER_DATA_KEY = "allweather.portfolio.vault.has-user-data.v1";
  const SYNC_SESSION_KEY = "allweather.portfolio.sync.session.v1";
  const SYNC_LAST_AT_KEY = "allweather.portfolio.sync.last-at.v1";
  const VAULT_AAD = "allweather-portfolio-vault-data-v1";
  const AUTH_PLAINTEXT = "allweather-portfolio-vault-unlocked-v1";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const QUOTE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const commonUsQuotes = Object.freeze({ SPY: "usSPY", QQQ: "usQQQ" });
  const mainlandIndexQuoteIds = Object.freeze({
    "000001": "tencent:sh000001",
    "000016": "tencent:sh000016",
    "000300": "tencent:sh000300",
    "000510": "tencent:sh000510",
    "000688": "tencent:sh000688",
    "000852": "tencent:sh000852",
    "000905": "tencent:sh000905",
    "000922": "tencent:sh000922",
    "000985": "tencent:sh000985",
    "399001": "tencent:sz399001",
    "399006": "tencent:sz399006",
    "930955": "tencent:sh512890",
    "931446": "tencent:sh512890"
  });
  const domesticFundProxyRules = Object.freeze([
    { pattern: /中证\s*A\s*500|(?:^|\s)A500(?:$|\s)/i, quoteId: "tencent:sh000510" },
    { pattern: /沪深\s*300/i, quoteId: "tencent:sh000300" },
    { pattern: /中证\s*1000/i, quoteId: "tencent:sh000852" },
    { pattern: /中证\s*500/i, quoteId: "tencent:sh000905" },
    { pattern: /科创\s*50/i, quoteId: "tencent:sh000688" },
    { pattern: /创业板/i, quoteId: "tencent:sz399006" },
    { pattern: /上证\s*50/i, quoteId: "tencent:sh000016" },
    { pattern: /东方红.*红利.*低波|红利.*低波|低波.*红利/i, quoteId: "tencent:sh512890" },
    { pattern: /中证红利/i, quoteId: "tencent:sh000922" },
    { pattern: /中证全指/i, quoteId: "tencent:sh000985" },
    { pattern: /深证成指/i, quoteId: "tencent:sz399001" },
    { pattern: /上证综指|上证指数/i, quoteId: "tencent:sh000001" }
  ]);
  const tencentQuoteEndpoint = "https://qt.gtimg.cn/q=";
  const sinaFuturesFrame = "sina-quote-frame.html";
  const typeLabels = Object.freeze({
    stock: "股票",
    etf: "ETF",
    fund: "场外基金",
    gold: "黄金",
    bond: "债券",
    wealth: "银行理财",
    deposit: "存款",
    cash: "现金",
    futures: "期货",
    option: "期权",
    other: "其他"
  });
  const bucketLabels = Object.freeze({
    gold: "黄金",
    dividend: "红利低波",
    a500: "国内宽基",
    bond_futures: "国债期货",
    cash: "现金理财",
    other: "其他"
  });
  const classLabels = Object.freeze({
    equity: "权益",
    bond: "债券",
    gold: "黄金",
    cash: "现金理财",
    other: "其他"
  });
  const genericContributionLabels = new Set([
    "美股", "港股", "国内权益", "权益", "股票", "ETF", "场外基金", "基金",
    "黄金", "债券", "现金", "现金理财", "国内宽基", "红利低波", "国债期货",
    "其他", "未纳入策略"
  ].map((label) => label.toLocaleLowerCase("zh-CN")));
  const donutPalette = Object.freeze(["#24679c", "#0b7a61", "#b77b17", "#8b5c9c", "#b34f2e", "#78909c"]);
  const classColors = Object.freeze({ equity: "#24679c", gold: "#b77b17", bond: "#0b7a61", cash: "#78909c", other: "#8b5c9c" });
  const strategyColors = Object.freeze({ gold: "#b77b17", dividend: "#b34f2e", a500: "#24679c", bond_futures: "#0b7a61", cash: "#78909c" });

  let sessionKey = null;
  let vault = null;
  let strategyTarget = null;
  let activeFilter = "all";
  let holdingGroupingMode = "underlying";
  let pendingConfirmation = null;
  let lockTimer = null;
  let toastTimer = null;
  let cloudSession = null;
  let cloudSyncPromise = null;
  let cloudUploadTimer = null;
  let pendingEncryptedVault = null;
  let hadLocalVault = false;
  let localVaultHasUserChanges = false;
  let historyPeriod = "day";
  let quoteRefreshTimer = null;
  let summaryValuesVisible = false;
  const expandedHoldingGroups = new Set();
  const expandedDailyContributionGroups = new Set();

  const $ = (id) => document.getElementById(id);
  const lockScreen = $("lock-screen");
  const app = $("vault-app");
  const unlockForm = $("unlock-form");
  const passwordInput = $("vault-password");
  const unlockButton = $("unlock-button");
  const unlockError = $("unlock-error");
  const holdingDialog = $("holding-dialog");
  const holdingForm = $("holding-form");
  const tradeDialog = $("trade-dialog");
  const tradeForm = $("trade-form");
  const confirmDialog = $("confirm-dialog");
  const syncDialog = $("sync-dialog");

  function bytesFromBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function base64FromBytes(value) {
    let binary = "";
    const bytes = new Uint8Array(value);
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  async function deriveKey(password) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: bytesFromBase64(AUTH.salt),
        iterations: Number(AUTH.iterations)
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function verifyKey(key) {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesFromBase64(AUTH.iv),
        additionalData: encoder.encode(AUTH.aad)
      },
      key,
      bytesFromBase64(AUTH.ciphertext)
    );
    return decoder.decode(plaintext) === AUTH_PLAINTEXT;
  }

  async function encryptVault(data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(VAULT_AAD)
      },
      sessionKey,
      plaintext
    );
    return JSON.stringify({
      version: 1,
      iv: base64FromBytes(iv),
      ciphertext: base64FromBytes(ciphertext)
    });
  }

  async function decryptVault(raw) {
    const bundle = JSON.parse(raw);
    if (bundle.version !== 1 || !bundle.iv || !bundle.ciphertext) {
      throw new Error("不支持的加密数据格式");
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesFromBase64(bundle.iv),
        additionalData: encoder.encode(VAULT_AAD)
      },
      sessionKey,
      bytesFromBase64(bundle.ciphertext)
    );
    const parsed = JSON.parse(decoder.decode(plaintext));
    validateVault(parsed);
    return parsed;
  }

  function validateVault(candidate) {
    if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.holdings)) {
      throw new Error("资产备份格式无效");
    }
    if (!Array.isArray(candidate.snapshots)) {
      candidate.snapshots = [];
    }
    if (!Array.isArray(candidate.transactions)) {
      candidate.transactions = [];
    }
  }

  function createEmptyVault() {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      holdings: [],
      transactions: [],
      snapshots: [],
      fxRates: { CNY: 1, USD: null, HKD: null, updatedAt: null }
    };
  }

  async function persistVault(options = {}) {
    if (!sessionKey || !vault) return;
    vault.updatedAt = new Date().toISOString();
    const encrypted = await encryptVault(vault);
    localStorage.setItem(STORAGE_KEY, encrypted);
    hadLocalVault = true;
    if (options.cloud !== false) queueCloudUpload(encrypted);
  }

  async function loadVault() {
    const stored = localStorage.getItem(STORAGE_KEY);
    hadLocalVault = Boolean(stored);
    localVaultHasUserChanges = localStorage.getItem(LOCAL_USER_DATA_KEY) === "true";
    if (!stored) {
      vault = createEmptyVault();
      localStorage.setItem(STORAGE_KEY, await encryptVault(vault));
      return;
    }
    vault = await decryptVault(stored);
    if (vault.holdings.length > 0) localVaultHasUserChanges = true;
  }

  function markLocalUserChange() {
    localVaultHasUserChanges = true;
    localStorage.setItem(LOCAL_USER_DATA_KEY, "true");
  }

  function syncConfigured() {
    try {
      const url = new URL(String(SYNC_CONFIG.url || ""));
      return url.protocol === "https:" && Boolean(String(SYNC_CONFIG.publishableKey || "").trim());
    } catch (error) {
      return false;
    }
  }

  function syncBaseUrl() {
    return String(SYNC_CONFIG.url || "").replace(/\/$/, "");
  }

  function setSyncStatus(state, label) {
    const status = $("sync-status");
    status.dataset.state = state;
    status.textContent = label;
  }

  function formatSyncTime(value) {
    if (!value) return "尚未同步";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "尚未同步";
    return `上次同步 ${date.toLocaleString("zh-CN", { hour12: false })}`;
  }

  function normalizeCloudSession(payload, fallback = {}) {
    const expiresIn = Number(payload.expires_in || fallback.expires_in || 3600);
    return {
      accessToken: payload.access_token || fallback.accessToken,
      refreshToken: payload.refresh_token || fallback.refreshToken,
      expiresAt: Number(payload.expires_at || 0) || Math.floor(Date.now() / 1000) + expiresIn,
      user: payload.user || fallback.user
    };
  }

  function saveCloudSession(session) {
    cloudSession = session;
    if (session?.accessToken && session?.refreshToken && session?.user?.id) {
      localStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(SYNC_SESSION_KEY);
    }
    renderSyncAccount();
  }

  function clearCloudSession() {
    cloudSession = null;
    localStorage.removeItem(SYNC_SESSION_KEY);
    renderSyncAccount();
    setSyncStatus(syncConfigured() ? "local" : "error", syncConfigured() ? "未登录" : "未配置");
  }

  async function cloudRequest(path, options = {}) {
    if (!syncConfigured()) throw new Error("云同步尚未配置");
    const headers = {
      apikey: String(SYNC_CONFIG.publishableKey),
      Authorization: `Bearer ${options.accessToken || String(SYNC_CONFIG.publishableKey)}`,
      ...options.headers
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${syncBaseUrl()}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch (error) { payload = text; }
    }
    if (!response.ok) {
      const message = payload?.msg || payload?.message || payload?.error_description || `HTTP ${response.status}`;
      const requestError = new Error(message);
      requestError.status = response.status;
      throw requestError;
    }
    return payload;
  }

  async function refreshCloudSession() {
    if (!cloudSession?.refreshToken) return null;
    try {
      const payload = await cloudRequest("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: cloudSession.refreshToken }
      });
      saveCloudSession(normalizeCloudSession(payload, cloudSession));
      return cloudSession;
    } catch (error) {
      clearCloudSession();
      throw new Error("同步账户登录已失效，请重新登录");
    }
  }

  async function ensureCloudSession() {
    if (!cloudSession) return null;
    if (cloudSession.expiresAt > Math.floor(Date.now() / 1000) + 60) return cloudSession;
    return refreshCloudSession();
  }

  async function restoreCloudSession() {
    if (!syncConfigured()) {
      setSyncStatus("error", "未配置");
      return null;
    }
    try {
      const stored = JSON.parse(localStorage.getItem(SYNC_SESSION_KEY) || "null");
      if (!stored?.accessToken || !stored?.refreshToken || !stored?.user?.id) {
        setSyncStatus("local", "未登录");
        return null;
      }
      cloudSession = stored;
      await ensureCloudSession();
      renderSyncAccount();
      return cloudSession;
    } catch (error) {
      clearCloudSession();
      return null;
    }
  }

  async function signInCloud(email, password) {
    const payload = await cloudRequest("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password }
    });
    saveCloudSession(normalizeCloudSession(payload));
    return cloudSession;
  }

  async function signUpCloud(email, password) {
    const payload = await cloudRequest("/auth/v1/signup", {
      method: "POST",
      body: { email, password }
    });
    if (payload?.access_token && payload?.refresh_token) {
      saveCloudSession(normalizeCloudSession(payload));
      return true;
    }
    return false;
  }

  async function fetchRemoteVault() {
    const session = await ensureCloudSession();
    if (!session) throw new Error("请先登录同步账户");
    const userId = encodeURIComponent(session.user.id);
    const rows = await cloudRequest(`/rest/v1/portfolio_vaults?select=vault,client_updated_at,updated_at&user_id=eq.${userId}&limit=1`, {
      accessToken: session.accessToken
    });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function uploadRemoteVault(encrypted, clientUpdatedAt) {
    const session = await ensureCloudSession();
    if (!session) throw new Error("请先登录同步账户");
    await cloudRequest("/rest/v1/portfolio_vaults?on_conflict=user_id", {
      method: "POST",
      accessToken: session.accessToken,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: {
        user_id: session.user.id,
        vault: JSON.parse(encrypted),
        client_updated_at: clientUpdatedAt
      }
    });
  }

  function markSyncComplete() {
    const now = new Date().toISOString();
    localStorage.setItem(SYNC_LAST_AT_KEY, now);
    setSyncStatus("synced", "已同步");
    renderSyncAccount();
  }

  async function synchronizeVault(options = {}) {
    if (!sessionKey || !vault || !cloudSession || !syncConfigured()) return;
    if (cloudSyncPromise) return cloudSyncPromise;
    cloudSyncPromise = (async () => {
      setSyncStatus("syncing", "同步中");
      try {
        const remote = await fetchRemoteVault();
        const localRaw = localStorage.getItem(STORAGE_KEY);
        if (!remote?.vault) {
          if (localRaw) await uploadRemoteVault(localRaw, vault.updatedAt);
          markSyncComplete();
          if (!options.silent) showToast("本机加密台账已上传");
          return;
        }
        const remoteRaw = JSON.stringify(remote.vault);
        const remoteVault = await decryptVault(remoteRaw);
        const remoteTime = Date.parse(remoteVault.updatedAt || remote.client_updated_at || 0) || 0;
        const localTime = Date.parse(vault.updatedAt || 0) || 0;
        if (!localVaultHasUserChanges || !hadLocalVault || remoteTime > localTime) {
          vault = remoteVault;
          localStorage.setItem(STORAGE_KEY, remoteRaw);
          hadLocalVault = true;
          markLocalUserChange();
          renderAll();
          if (!options.silent) showToast("已下载云端较新的资产数据");
        } else if (localTime > remoteTime && localRaw) {
          await uploadRemoteVault(localRaw, vault.updatedAt);
          if (!options.silent) showToast("本机较新的资产数据已上传");
        } else if (!options.silent) {
          showToast("本机与云端已经一致");
        }
        markSyncComplete();
      } catch (error) {
        setSyncStatus("error", "同步失败");
        $("sync-panel-error").textContent = error.message;
        if (!options.silent) showToast(`同步失败：${error.message}`);
        throw error;
      } finally {
        cloudSyncPromise = null;
      }
    })();
    return cloudSyncPromise;
  }

  function queueCloudUpload(encrypted) {
    if (!cloudSession || !syncConfigured()) return;
    pendingEncryptedVault = encrypted;
    clearTimeout(cloudUploadTimer);
    setSyncStatus("syncing", "待同步");
    cloudUploadTimer = setTimeout(async () => {
      const payload = pendingEncryptedVault;
      const clientUpdatedAt = vault?.updatedAt || new Date().toISOString();
      pendingEncryptedVault = null;
      try {
        await uploadRemoteVault(payload, clientUpdatedAt);
        markSyncComplete();
      } catch (error) {
        setSyncStatus("error", "同步失败");
        pendingEncryptedVault = payload;
      }
    }, 800);
  }

  function renderSyncAccount() {
    if (!syncDialog) return;
    const configured = syncConfigured();
    $("sync-unavailable").hidden = configured;
    $("sync-auth-form").hidden = !configured || Boolean(cloudSession);
    $("sync-account-panel").hidden = !configured || !cloudSession;
    $("sync-account-email").textContent = cloudSession?.user?.email || "—";
    $("sync-last-time").textContent = formatSyncTime(localStorage.getItem(SYNC_LAST_AT_KEY));
  }

  function openSyncDialog() {
    $("sync-auth-error").textContent = "";
    $("sync-panel-error").textContent = "";
    renderSyncAccount();
    syncDialog.showModal();
    if (syncConfigured() && !cloudSession) $("sync-email").focus();
  }

  function resetLockTimer() {
    if (!sessionKey) return;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(lockVault, SESSION_TIMEOUT_MS);
  }

  function lockVault() {
    clearTimeout(lockTimer);
    clearInterval(quoteRefreshTimer);
    sessionKey = null;
    vault = null;
    summaryValuesVisible = false;
    expandedHoldingGroups.clear();
    expandedDailyContributionGroups.clear();
    [holdingDialog, tradeDialog, syncDialog, confirmDialog].forEach((dialog) => {
      if (dialog?.open) dialog.close();
    });
    pendingConfirmation = null;
    app.hidden = true;
    lockScreen.hidden = false;
    passwordInput.value = "";
    passwordInput.type = "password";
    $("toggle-password").textContent = "显示";
    $("toggle-password").setAttribute("aria-label", "显示密码");
    passwordInput.focus();
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function chinaDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function fundNavDate(item) {
    return item.quoteTime ? chinaDate(item.quoteTime) : "";
  }

  function fundNavDailyPending(item) {
    return item.pricingMode === "auto"
      && holdingUsesFundNav(item)
      && fundNavDate(item) !== chinaDate();
  }

  function fundQuotePresentation(item) {
    const navDate = fundNavDate(item);
    if (item.pricingMode !== "auto" || !holdingUsesFundNav(item) || !navDate) {
      return { text: item.quoteStatus || "待刷新", pending: false };
    }
    if (fundNavDailyPending(item)) {
      const proxyMove = currentIntradayProxyMove(item);
      return {
        text: proxyMove
          ? `盘中估 · ${proxyMove.name} ${(proxyMove.rate * 100).toFixed(2)}% · 净值 ${navDate}`
          : `待更新 · 净值 ${navDate}${fundUsesEstimatedShares(item) ? " · 估算份额" : ""}`,
        pending: true
      };
    }
    return { text: `${item.quoteStatus || "基金净值"} · ${navDate}`, pending: false };
  }

  function formatMoney(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    const absolute = Math.abs(number);
    const formatted = new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(absolute);
    return `${number < 0 ? "-" : ""}¥${formatted}`;
  }

  function formatNative(value, currency) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "CNY",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(number);
  }

  function formatPercent(value, digits = 1) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : "--";
  }

  function formatNumber(value, digits = 2) {
    return Number.isFinite(Number(value))
      ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(Number(value))
      : "--";
  }

  function formatQuotePrice(value, currency = "CNY") {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "--";
    const symbol = { CNY: "¥", USD: "$", HKD: "HK$" }[currency] || `${currency} `;
    const digits = number < 10 ? 4 : 3;
    return `${symbol}${new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    }).format(number)}`;
  }

  function numeric(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function assetClass(item) {
    if (item.strategyBucket === "gold" || item.assetType === "gold") return "gold";
    if (item.strategyBucket === "bond_futures" || item.assetType === "bond" || item.assetType === "futures") return "bond";
    if (item.strategyBucket === "cash" || ["cash", "wealth", "deposit"].includes(item.assetType)) return "cash";
    if (["a500", "dividend"].includes(item.strategyBucket) || ["stock", "etf", "fund"].includes(item.assetType)) return "equity";
    return "other";
  }

  function transactionsForHolding(holdingId) {
    return (vault?.transactions || [])
      .filter((transaction) => transaction.holdingId === holdingId)
      .sort((left, right) => `${left.date || ""}|${left.createdAt || ""}`.localeCompare(`${right.date || ""}|${right.createdAt || ""}`));
  }

  function holdingHasTransactions(holdingId) {
    return Boolean(holdingId) && (vault?.transactions || []).some((transaction) => transaction.holdingId === holdingId);
  }

  function holdingHasTransactionReferences(holdingId) {
    return Boolean(holdingId) && (vault?.transactions || []).some((transaction) => (
      transaction.holdingId === holdingId || transaction.cashHoldingId === holdingId
    ));
  }

  function isTradeableHolding(item) {
    return Boolean(item)
      && item.includeNav
      && !["cash", "wealth", "deposit", "futures", "option"].includes(item.assetType)
      && !["fixed", "interest"].includes(item.pricingMode);
  }

  function transactionCapitalFlowBetween(startExclusive, endInclusive) {
    return (vault?.transactions || []).reduce((sum, transaction) => {
      const date = String(transaction.date || "");
      if (!date || date > endInclusive || (startExclusive && date <= startExclusive)) return sum;
      return sum + numeric(transaction.capitalFlowCny);
    }, 0);
  }

  function tradedHoldingDailyPnl(item, currentPrice, previousClose, multiplier) {
    const todayTrades = transactionsForHolding(item.id).filter((transaction) => transaction.date === chinaDate());
    if (!todayTrades.length) return numeric(item.quantity) * (currentPrice - previousClose) * multiplier;

    const buys = todayTrades.filter((transaction) => transaction.type === "buy").reduce((sum, transaction) => sum + numeric(transaction.quantity), 0);
    const sells = todayTrades.filter((transaction) => transaction.type === "sell").reduce((sum, transaction) => sum + numeric(transaction.quantity), 0);
    const startingQuantity = numeric(item.quantity) - buys + sells;
    if (startingQuantity < -1e-8) return numeric(item.quantity) * (currentPrice - previousClose) * multiplier;

    const lots = startingQuantity > 1e-8 ? [{ quantity: startingQuantity, basis: previousClose }] : [];
    let realized = 0;
    for (const transaction of todayTrades) {
      const quantity = numeric(transaction.quantity);
      const tradePrice = numeric(transaction.price);
      if (transaction.type === "buy") {
        lots.push({ quantity, basis: tradePrice });
        continue;
      }
      let remaining = quantity;
      for (const lot of lots) {
        if (!(remaining > 1e-8)) break;
        const used = Math.min(lot.quantity, remaining);
        realized += used * (tradePrice - lot.basis);
        lot.quantity -= used;
        remaining -= used;
      }
      if (remaining > 1e-8) return numeric(item.quantity) * (currentPrice - previousClose) * multiplier;
    }
    const unrealized = lots.reduce((sum, lot) => sum + Math.max(0, lot.quantity) * (currentPrice - lot.basis), 0);
    return (realized + unrealized) * multiplier;
  }

  function accruedFixedValue(item) {
    const principal = numeric(item.fixedValue);
    if (item.pricingMode !== "interest" || !item.valuationDate) return principal;
    const base = new Date(`${item.valuationDate}T00:00:00+08:00`);
    const now = new Date();
    const days = Math.max(0, (now - base) / 86400000);
    return principal * (1 + numeric(item.annualRate) * days / 365);
  }

  function calculateHolding(item) {
    const fx = item.currency === "CNY" ? 1 : numeric(vault.fxRates?.[item.currency], NaN);
    const quantity = numeric(item.quantity);
    const price = numeric(item.price);
    const previousClose = numeric(item.previousClose, price);
    const entry = numeric(item.entryPrice, price);
    const multiplier = Math.max(numeric(item.multiplier, 1), 0);
    const direction = numeric(item.direction, 1) < 0 ? -1 : 1;
    const derivative = item.assetType === "futures" || item.assetType === "option";
    let nativeValue = 0;
    let nativeExposure = 0;
    let nativePnl = 0;
    let nativeDailyPnl = 0;
    let realizedPnlCny = 0;

    if (["fixed", "interest"].includes(item.pricingMode)) {
      nativeValue = accruedFixedValue(item);
      const dailyRate = numeric(item.annualRate) / 365;
      nativeDailyPnl = item.pricingMode === "interest" ? nativeValue * dailyRate : 0;
      nativePnl = nativeValue - numeric(item.fixedValue);
      nativeExposure = item.strategyBucket === "cash" ? 0 : nativeValue;
    } else if (item.assetType === "futures") {
      nativeExposure = direction * quantity * price * multiplier;
      nativePnl = direction * quantity * (price - entry) * multiplier;
      nativeDailyPnl = direction * quantity * (price - previousClose) * multiplier;
      nativeValue = item.includeNav ? nativePnl : 0;
    } else if (item.assetType === "option") {
      const optionDelta = numeric(item.delta);
      const underlyingPrice = numeric(item.underlyingPrice);
      nativeExposure = direction * optionDelta * quantity * underlyingPrice * multiplier;
      nativePnl = direction * quantity * (price - entry) * multiplier;
      nativeDailyPnl = direction * quantity * (price - previousClose) * multiplier;
      nativeValue = item.includeNav ? direction * quantity * price * multiplier : 0;
    } else {
      nativeValue = quantity * price * multiplier;
      nativeExposure = item.strategyBucket === "cash" ? 0 : nativeValue;
      nativePnl = quantity * (price - entry) * multiplier;
      nativeDailyPnl = tradedHoldingDailyPnl(item, price, previousClose, multiplier);
      realizedPnlCny = numeric(item.realizedPnlCny);
    }

    const navDailyPending = fundNavDailyPending(item);
    const intradayProxyMove = navDailyPending ? currentIntradayProxyMove(item) : null;
    const dailyPnlEstimated = Boolean(intradayProxyMove);
    const dailyPnlPending = navDailyPending && !dailyPnlEstimated;
    if (dailyPnlEstimated) nativeDailyPnl = nativeValue * intradayProxyMove.rate;
    else if (dailyPnlPending) nativeDailyPnl = 0;

    const validFx = Number.isFinite(fx) && fx > 0;
    return {
      nativeValue,
      nativeExposure,
      nativePnl,
      nativeDailyPnl,
      valueCny: item.includeNav && validFx ? nativeValue * fx : 0,
      exposureCny: validFx ? nativeExposure * fx : 0,
      pnlCny: (validFx ? nativePnl * fx : 0) + realizedPnlCny,
      dailyPnlCny: validFx ? nativeDailyPnl * fx : 0,
      fx,
      validFx,
      derivative,
      dailyPnlPending,
      dailyPnlEstimated,
      intradayProxyMove
    };
  }

  function portfolioMetrics() {
    const rows = vault.holdings.map((item) => ({ item, calc: calculateHolding(item) }));
    const totalAssets = rows.reduce((sum, row) => sum + row.calc.valueCny, 0);
    const dailyPnl = rows.reduce((sum, row) => sum + row.calc.dailyPnlCny, 0);
    const grossExposure = rows.reduce((sum, row) => sum + Math.abs(row.calc.exposureCny), 0);
    const includedCount = rows.filter((row) => row.item.includeNav).length;
    const derivativeCount = rows.filter((row) => row.calc.derivative).length;
    const estimatedDailyCount = rows.filter((row) => row.calc.dailyPnlEstimated).length;
    return { rows, totalAssets, dailyPnl, grossExposure, includedCount, derivativeCount, estimatedDailyCount };
  }

  function inferQuoteId(item) {
    const explicit = String(item.quoteId || "").trim();
    if (explicit) {
      if (/^(?:tencent|sina):/i.test(explicit)) return explicit;
      if (/^(?:sh|sz|hk|us|jj|wh)\w+/i.test(explicit)) return `tencent:${explicit}`;
      if (item.assetType === "futures" && /^(?:T|TF|TS|TL)(?:0|\d{3,4})(?:\.CFE)?$/i.test(explicit)) {
        return `sina:${explicit.replace(/\.CFE$/i, "").toUpperCase()}`;
      }
      return inferQuoteId({ ...item, quoteId: "", code: explicit });
    }
    let code = String(item.code || "").trim().toUpperCase();
    if (!code) return "";
    if (item.assetType === "futures") {
      let futuresCode = code.replace(/\.CFE$/i, "");
      if (/^(?:T|TF|TS|TL)$/.test(futuresCode)) futuresCode += "0";
      return /^(?:T|TF|TS|TL)(?:0|\d{3,4})$/.test(futuresCode) ? `sina:${futuresCode}` : "";
    }
    if (item.assetType === "option") return "";
    if (item.assetType === "fund") {
      code = code.replace(/\.OF$/i, "");
      if (/^\d{6}$/.test(code)) return `tencent:jj${code}`;
    }
    if (item.assetType === "etf" && item.fundInputMode === "amount") {
      code = code.replace(/\.OF$/i, "");
      if (/^0\d{5}$/.test(code)) return `tencent:jj${code}`;
    }
    const mainlandMatch = code.match(/^(\d{6})\.(SH|SZ)$/i);
    if (mainlandMatch) return `tencent:${mainlandMatch[2].toLowerCase()}${mainlandMatch[1]}`;
    const usMatch = code.match(/^([A-Z][A-Z0-9.-]{0,14})\.US$/i);
    if (usMatch) return `tencent:us${usMatch[1]}`;
    if (/^[569]\d{5}$/.test(code)) return `tencent:sh${code}`;
    if (/^[0123]\d{5}$/.test(code)) return `tencent:sz${code}`;
    if (commonUsQuotes[code]) return `tencent:${commonUsQuotes[code]}`;
    if (/^[A-Z][A-Z0-9.-]{0,14}$/.test(code)) return `tencent:us${code}`;
    if (code.endsWith(".HK")) code = code.slice(0, -3).padStart(5, "0");
    if (/^\d{5}$/.test(code)) return `tencent:hk${code}`;
    if (/^\d{6}$/.test(code)) return `tencent:${/^[5689]/.test(code) ? "sh" : "sz"}${code}`;
    return "";
  }

  function parseTencentTimestamp(value) {
    const text = String(value || "").trim();
    const compact = text.replace(/\D/g, "");
    if (compact.length >= 14) {
      const date = new Date(
        Number(compact.slice(0, 4)),
        Number(compact.slice(4, 6)) - 1,
        Number(compact.slice(6, 8)),
        Number(compact.slice(8, 10)),
        Number(compact.slice(10, 12)),
        Number(compact.slice(12, 14))
      );
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const parsed = new Date(text.replace(/\//g, "-"));
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  async function fetchTencentQuote(symbol) {
    const url = `${tencentQuoteEndpoint}${encodeURIComponent(symbol)}&_=${Date.now()}`;
    const response = await fetch(url, { cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = new TextDecoder("gb18030").decode(await response.arrayBuffer());
    const firstQuote = payload.indexOf('"');
    const lastQuote = payload.lastIndexOf('"');
    if (firstQuote < 0 || lastQuote <= firstQuote) throw new Error("无有效行情");
    const fields = payload.slice(firstQuote + 1, lastQuote).split("~");
    const isFund = symbol.toLowerCase().startsWith("jj");
    const isForex = symbol.toLowerCase().startsWith("wh");
    const price = numeric(isFund ? fields[5] : fields[3], NaN);
    const fundChangeRate = numeric(fields[7], NaN);
    const fundPrevious = Number.isFinite(fundChangeRate) && Math.abs(1 + fundChangeRate / 100) > 1e-8
      ? price / (1 + fundChangeRate / 100)
      : price;
    const previousClose = numeric(isFund ? fundPrevious : (isForex ? fields[6] : fields[4]), price);
    const timeValue = isFund ? fields[8] : (isForex ? fields[5] : fields[30]);
    if (!Number.isFinite(price) || price <= 0) throw new Error("无有效收盘价");
    return {
      price,
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : price,
      name: String(fields[1] || fields[2] || symbol),
      quoteTime: parseTencentTimestamp(timeValue),
      quoteLabel: isFund ? "基金净值" : (isForex ? "汇率" : "实时行情")
    };
  }

  function fetchSinaFuturesQuote(symbol) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const iframe = document.createElement("iframe");
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        iframe.remove();
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("期货行情超时"));
      }, 12000);
      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.data?.requestId !== requestId) return;
        window.clearTimeout(timer);
        cleanup();
        if (!event.data.ok) {
          reject(new Error("期货行情加载失败"));
          return;
        }
        if (event.data.quote) {
          const price = numeric(event.data.quote.price, NaN);
          const previousClose = numeric(event.data.quote.previousClose, price);
          if (!(price > 0)) {
            reject(new Error("无有效期货行情"));
            return;
          }
          resolve({
            price,
            previousClose: previousClose > 0 ? previousClose : price,
            name: String(event.data.quote.name || symbol.toUpperCase()),
            quoteTime: String(event.data.quote.quoteTime || new Date().toISOString()),
            quoteLabel: event.data.quote.quoteLabel || "延时行情"
          });
          return;
        }
        const observations = Array.isArray(event.data.rows)
          ? event.data.rows.filter((row) => row && row.d && row.c)
          : [];
        const latest = observations.at(-1);
        const previous = observations.at(-2);
        const price = numeric(latest?.c, NaN);
        if (!Number.isFinite(price) || price <= 0) {
          reject(new Error("无有效期货收盘价"));
          return;
        }
        resolve({
          price,
          previousClose: numeric(previous?.c, price),
          name: symbol.toUpperCase(),
          quoteTime: parseTencentTimestamp(latest.d),
          quoteLabel: "最新收盘"
        });
      };
      window.addEventListener("message", onMessage);
      iframe.hidden = true;
      iframe.title = "期货行情沙箱";
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.referrerPolicy = "no-referrer";
      iframe.src = `${sinaFuturesFrame}?symbol=${encodeURIComponent(symbol)}&request=${encodeURIComponent(requestId)}`;
      document.body.appendChild(iframe);
    });
  }

  async function fetchQuote(quoteId) {
    const separator = quoteId.indexOf(":");
    const provider = separator > 0 ? quoteId.slice(0, separator).toLowerCase() : "tencent";
    const symbol = separator > 0 ? quoteId.slice(separator + 1) : quoteId;
    if (provider === "sina") return fetchSinaFuturesQuote(symbol);
    return fetchTencentQuote(symbol);
  }

  function linkedFundFallbackQuoteId(item, primaryQuoteId) {
    const code = String(item.code || "").trim().toUpperCase().replace(/\.OF$/i, "");
    if (item.assetType !== "etf" || !/^0\d{5}$/.test(code)) return "";
    const fallbackQuoteId = `tencent:jj${code}`;
    return fallbackQuoteId === primaryQuoteId ? "" : fallbackQuoteId;
  }

  async function fetchHoldingQuote(item) {
    const primaryQuoteId = inferQuoteId(item);
    if (!primaryQuoteId) throw new Error("代码不支持");
    try {
      return { quote: await fetchQuote(primaryQuoteId), quoteId: primaryQuoteId };
    } catch (primaryError) {
      const fallbackQuoteId = linkedFundFallbackQuoteId(item, primaryQuoteId);
      if (!fallbackQuoteId) throw primaryError;
      try {
        const quote = await fetchQuote(fallbackQuoteId);
        item.quoteId = fallbackQuoteId;
        return { quote, quoteId: fallbackQuoteId };
      } catch (fallbackError) {
        throw primaryError;
      }
    }
  }

  async function loadStrategyTarget() {
    try {
      const response = await fetch(`strategy-target.json?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      strategyTarget = await response.json();
    } catch (error) {
      strategyTarget = null;
    }
  }

  function fundUsesEstimatedShares(item) {
    return ["fund", "etf"].includes(item.assetType) && item.fundInputMode === "amount";
  }

  function holdingUsesFundNav(item) {
    return item.assetType === "fund"
      || /(?:^|:)jj\d{6}$/i.test(String(item.quoteId || item.resolvedQuoteId || inferQuoteId(item) || ""));
  }

  function domesticFundIntradayEligible(item) {
    return item.assetType === "fund"
      && item.pricingMode === "auto"
      && item.intradayEstimateEnabled !== false
      && (item.currency || "CNY") === "CNY"
      && item.strategyBucket !== "gold"
      && assetClass(item) === "equity"
      && marketClassification(item).key === "cn-equity";
  }

  function quoteIdForIntradayProxyCode(value) {
    const raw = String(value || "").trim().toUpperCase();
    if (!raw) return "";
    if (/^(?:TENCENT|SINA):/i.test(raw)) return raw.toLowerCase().startsWith("tencent:")
      ? `tencent:${raw.slice(raw.indexOf(":") + 1).toLowerCase()}`
      : raw.toLowerCase();
    if (/^(?:SH|SZ)\d{6}$/i.test(raw)) return `tencent:${raw.toLowerCase()}`;
    const mainlandMatch = raw.match(/^(\d{6})\.(SH|SZ)$/i);
    if (mainlandMatch) return `tencent:${mainlandMatch[2].toLowerCase()}${mainlandMatch[1]}`;
    if (mainlandIndexQuoteIds[raw]) return mainlandIndexQuoteIds[raw];
    return inferQuoteId({ assetType: "etf", fundInputMode: "shares", quoteId: "", code: raw });
  }

  function inferIntradayProxyQuoteId(item) {
    if (!domesticFundIntradayEligible(item)) return "";
    const explicit = quoteIdForIntradayProxyCode(item.intradayProxyCode);
    if (explicit) return explicit;
    const descriptor = [item.name, item.code, item.quoteName, item.underlyingName].filter(Boolean).join(" ");
    const matchedRule = domesticFundProxyRules.find((rule) => rule.pattern.test(descriptor));
    if (matchedRule) return matchedRule.quoteId;
    if (item.strategyBucket === "dividend") return "tencent:sh512890";
    if (item.strategyBucket === "a500") return "tencent:sh000510";
    return "";
  }

  function clearIntradayProxyQuote(item, error = "") {
    item.intradayProxyPrice = 0;
    item.intradayProxyPreviousClose = 0;
    item.intradayProxyQuoteTime = "";
    item.intradayProxyQuoteName = "";
    item.intradayProxyResolvedQuoteId = "";
    item.intradayProxyError = error;
  }

  function applyIntradayProxyQuote(item, quote, quoteId) {
    item.intradayProxyPrice = quote.price;
    item.intradayProxyPreviousClose = quote.previousClose;
    item.intradayProxyQuoteTime = quote.quoteTime;
    item.intradayProxyQuoteName = quote.name;
    item.intradayProxyResolvedQuoteId = quoteId;
    item.intradayProxyError = "";
  }

  function currentIntradayProxyMove(item) {
    if (!domesticFundIntradayEligible(item) || !fundNavDailyPending(item)) return null;
    if (chinaDate(item.intradayProxyQuoteTime) !== chinaDate()) return null;
    const price = numeric(item.intradayProxyPrice, NaN);
    const previousClose = numeric(item.intradayProxyPreviousClose, NaN);
    if (!(price > 0) || !(previousClose > 0)) return null;
    const rate = price / previousClose - 1;
    if (!Number.isFinite(rate) || Math.abs(rate) > 0.25) return null;
    return { rate, quoteId: item.intradayProxyResolvedQuoteId, name: item.intradayProxyQuoteName || "参考指数" };
  }

  function fundNeedsCalibration(item) {
    return fundUsesEstimatedShares(item)
      && !holdingHasTransactions(item.id)
      && (!(numeric(item.quantity) > 0) || !item.fundCalibratedAt);
  }

  function applyQuoteToHolding(item, quote, quoteId) {
    if (fundNeedsCalibration(item)) {
      const seedAmount = numeric(item.fundSeedAmount);
      if (!(seedAmount > 0) || !(quote.price > 0)) throw new Error("缺少可用于估算份额的金额或净值");
      item.quantity = seedAmount / quote.price;
      item.entryPrice = quote.price;
      item.fundCalibrationNav = quote.price;
      item.fundCalibratedAt = quote.quoteTime;
    }
    item.price = quote.price;
    item.previousClose = quote.previousClose;
    item.quoteName = quote.name;
    item.quoteTime = quote.quoteTime;
    item.quoteStatus = fundUsesEstimatedShares(item)
      ? `${quote.quoteLabel || "基金净值"} · 估算份额`
      : (quote.quoteLabel || "已更新");
    item.quoteError = "";
    item.resolvedQuoteId = quoteId;
    if (item.assetType === "etf" && /黄金|\bGOLD\b/i.test(`${item.name || ""} ${item.code || ""} ${quote.name || ""}`)) {
      if (!item.underlyingName) item.underlyingName = "黄金";
      item.strategyBucket = "gold";
    }
  }

  async function refreshIntradayProxyQuote(item, requestCache) {
    if (!domesticFundIntradayEligible(item)) {
      clearIntradayProxyQuote(item);
      return;
    }
    if (!fundNavDailyPending(item)) {
      clearIntradayProxyQuote(item);
      return;
    }
    const quoteId = inferIntradayProxyQuoteId(item);
    if (!quoteId) {
      clearIntradayProxyQuote(item, "未识别对应的场内 ETF 或指数，请在编辑资产时填写盘中参考代码");
      return;
    }
    try {
      if (!requestCache.has(quoteId)) requestCache.set(quoteId, fetchQuote(quoteId));
      const quote = await requestCache.get(quoteId);
      applyIntradayProxyQuote(item, quote, quoteId);
    } catch (error) {
      clearIntradayProxyQuote(item, error?.message || "盘中参考行情暂不可用");
      item.intradayProxyResolvedQuoteId = quoteId;
    }
  }

  async function refreshQuotes(options = {}) {
    if (!vault) return;
    const button = $("refresh-quotes");
    button.disabled = true;
    button.textContent = "刷新中";
    let success = 0;
    let attempted = 0;
    const intradayProxyRequests = new Map();

    const fxRequests = [
      ["USD", "tencent:whUSDCNY"],
      ["HKD", "tencent:whHKDCNY"]
    ];
    await Promise.all(fxRequests.map(async ([currency, quoteId]) => {
      try {
        const quote = await fetchQuote(quoteId);
        vault.fxRates[currency] = quote.price;
        vault.fxRates.updatedAt = quote.quoteTime;
      } catch (error) {
        // Retain the last encrypted FX observation when the endpoint is unavailable.
      }
    }));

    await Promise.all(vault.holdings.map(async (item) => {
      if (item.pricingMode !== "auto") return;
      const quoteId = inferQuoteId(item);
      attempted += 1;
      if (!quoteId) {
        item.quoteStatus = "代码不支持";
        item.quoteError = "请检查资产类型和代码";
        item.resolvedQuoteId = "";
        return;
      }
      try {
        const result = await fetchHoldingQuote(item);
        applyQuoteToHolding(item, result.quote, result.quoteId);
        success += 1;
      } catch (error) {
        item.quoteStatus = "更新失败";
        item.quoteError = error?.message || "行情接口暂不可用";
        item.resolvedQuoteId = quoteId;
      }
      await refreshIntradayProxyQuote(item, intradayProxyRequests);
    }));

    await persistVault();
    renderAll();
    await recordSnapshot();
    button.disabled = false;
    button.textContent = "刷新行情";
    if (!options.silent) showToast(`行情更新完成：${success}/${attempted}`);
  }

  function startQuoteAutoRefresh() {
    clearInterval(quoteRefreshTimer);
    quoteRefreshTimer = setInterval(() => {
      if (document.visibilityState === "visible" && sessionKey && !$("refresh-quotes").disabled) {
        refreshQuotes({ silent: true });
      }
    }, QUOTE_REFRESH_INTERVAL_MS);
  }

  async function recordSnapshot(options = {}) {
    const metrics = portfolioMetrics();
    if (!(metrics.totalAssets > 0)) {
      if (options.notify) showToast("暂无可记录的总资产");
      return;
    }
    const date = chinaDate();
    const previousSnapshot = vault.snapshots
      .filter((item) => item?.date && item.date < date && Number.isFinite(Number(item.totalAssets)))
      .sort((left, right) => left.date.localeCompare(right.date))
      .at(-1);
    const capitalFlowCny = previousSnapshot ? transactionCapitalFlowBetween(previousSnapshot.date, date) : 0;
    const snapshot = {
      date,
      totalAssets: metrics.totalAssets,
      dailyPnl: previousSnapshot ? metrics.totalAssets - numeric(previousSnapshot.totalAssets) - capitalFlowCny : metrics.dailyPnl,
      marketDailyPnl: metrics.dailyPnl,
      capitalFlowCny,
      grossExposure: metrics.grossExposure
    };
    const existingIndex = vault.snapshots.findIndex((item) => item.date === date);
    if (existingIndex >= 0) vault.snapshots[existingIndex] = snapshot;
    else vault.snapshots.push(snapshot);
    vault.snapshots = vault.snapshots
      .filter((item) => item && item.date && Number.isFinite(Number(item.totalAssets)))
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-750);
    await persistVault();
    renderHistory();
    if (options.notify) showToast(`已记录 ${date} 总资产`);
  }

  function setSignedClass(element, value) {
    element.classList.remove("positive", "negative");
    if (value > 0) element.classList.add("positive");
    if (value < 0) element.classList.add("negative");
  }

  function setSummaryValue(id, value, signedValue = null) {
    const element = $(id);
    element.textContent = summaryValuesVisible ? value : "******";
    element.classList.remove("positive", "negative");
    if (summaryValuesVisible && signedValue !== null) setSignedClass(element, signedValue);
  }

  function updateSummaryPrivacyButton() {
    const button = $("toggle-summary-privacy");
    button.textContent = summaryValuesVisible ? "隐藏" : "显示";
    button.setAttribute("aria-pressed", String(summaryValuesVisible));
    button.setAttribute("aria-label", summaryValuesVisible ? "隐藏资产摘要" : "显示资产摘要");
  }

  function renderSummary(metrics) {
    setSummaryValue("total-assets", formatMoney(metrics.totalAssets));
    setSummaryValue("daily-pnl", `${metrics.estimatedDailyCount ? "估 " : ""}${formatMoney(metrics.dailyPnl)}`, metrics.dailyPnl);
    setSummaryValue("gross-exposure", metrics.totalAssets > 0
      ? `${(metrics.grossExposure / metrics.totalAssets).toFixed(2)}x`
      : "0.00x");
    updateSummaryPrivacyButton();
    $("included-count").textContent = `${metrics.includedCount}项计入净资产`;
    $("derivative-count").textContent = `${metrics.derivativeCount}项衍生品`;
    const automatic = vault.holdings.filter((item) => item.pricingMode === "auto");
    const covered = automatic.filter((item) => item.quoteTime && item.quoteStatus !== "更新失败").length;
    $("quote-coverage").textContent = `行情覆盖 ${covered}/${automatic.length}`;
    const latestTimes = vault.holdings
      .flatMap((item) => [item.quoteTime, item.intradayProxyQuoteTime])
      .filter(Boolean)
      .sort();
    $("valuation-time").textContent = latestTimes.length
      ? `最近行情 ${new Date(latestTimes.at(-1)).toLocaleString("zh-CN", { hour12: false })}`
      : `台账更新 ${new Date(vault.updatedAt).toLocaleString("zh-CN", { hour12: false })}`;
  }

  function createBarRow(label, value, maxValue, target = null, valueLabel = null) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const labelNode = document.createElement("span");
    labelNode.className = "bar-label";
    labelNode.textContent = label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = `${Math.min(100, Math.abs(value) / Math.max(maxValue, 1e-12) * 100)}%`;
    track.appendChild(fill);
    if (target !== null) {
      const targetBar = document.createElement("span");
      targetBar.className = "bar-target";
      targetBar.style.width = `${Math.min(100, Math.abs(target) / Math.max(maxValue, 1e-12) * 100)}%`;
      track.appendChild(targetBar);
    }
    const valueNode = document.createElement("span");
    valueNode.className = "bar-value";
    valueNode.textContent = valueLabel || formatPercent(value);
    row.append(labelNode, track, valueNode);
    return row;
  }

  function renderAllocation(metrics) {
    const container = $("allocation-bars");
    container.replaceChildren();
    if (!(metrics.totalAssets > 0)) {
      const empty = document.createElement("div");
      empty.className = "bar-empty";
      empty.textContent = "录入资产后显示构成";
      container.appendChild(empty);
      return;
    }
    const totals = { equity: 0, bond: 0, gold: 0, cash: 0, other: 0 };
    metrics.rows.forEach(({ item, calc }) => {
      if (item.includeNav) totals[assetClass(item)] += calc.valueCny;
    });
    Object.entries(totals)
      .filter(([, value]) => Math.abs(value) > 0.01)
      .sort((left, right) => right[1] - left[1])
      .forEach(([key, value]) => {
        container.appendChild(createBarRow(classLabels[key], value / metrics.totalAssets, 1, null, `${formatPercent(value / metrics.totalAssets)} · ${formatMoney(value)}`));
      });
  }

  function targetBuckets() {
    if (!strategyTarget?.latest_scaled_weights) return null;
    const weights = strategyTarget.latest_scaled_weights;
    const marginRate = numeric(strategyTarget.futures_margin_rate, 0.02);
    const targets = {
      gold: numeric(weights["518880.SH"]),
      dividend: numeric(weights["921446.CSI"]),
      a500: numeric(weights["000510CNY010"]),
      bond_futures: numeric(weights["T.CFE"])
    };
    targets.cash = Math.max(0, 1 - targets.gold - targets.dividend - targets.a500 - Math.abs(targets.bond_futures) * marginRate);
    return targets;
  }

  function renderStrategy(metrics) {
    const container = $("strategy-bars");
    container.replaceChildren();
    const targets = targetBuckets();
    $("strategy-date").textContent = strategyTarget?.latest_date || "暂无目标";
    if (!targets || !(metrics.totalAssets > 0)) {
      const empty = document.createElement("div");
      empty.className = "bar-empty";
      empty.textContent = metrics.totalAssets > 0 ? "目标数据暂不可用" : "录入资产后显示偏离";
      container.appendChild(empty);
      setSummaryValue("largest-gap", "待录入");
      return;
    }
    const actual = { gold: 0, dividend: 0, a500: 0, bond_futures: 0, cash: 0 };
    metrics.rows.forEach(({ item, calc }) => {
      const bucket = item.strategyBucket;
      if (!(bucket in actual)) return;
      if (bucket === "cash") actual[bucket] += calc.valueCny / metrics.totalAssets;
      else actual[bucket] += calc.exposureCny / metrics.totalAssets;
    });
    const keys = ["gold", "dividend", "a500", "bond_futures", "cash"];
    const scale = Math.max(1, ...keys.flatMap((key) => [Math.abs(actual[key]), Math.abs(targets[key])]));
    let largest = { key: "", gap: 0 };
    keys.forEach((key) => {
      const gap = actual[key] - targets[key];
      if (Math.abs(gap) > Math.abs(largest.gap)) largest = { key, gap };
      container.appendChild(createBarRow(
        bucketLabels[key],
        actual[key],
        scale,
        targets[key],
        `${formatPercent(actual[key])} / ${formatPercent(targets[key])}`
      ));
    });
    setSummaryValue("largest-gap", `${bucketLabels[largest.key]} ${largest.gap >= 0 ? "+" : ""}${formatPercent(largest.gap)}`);
  }

  function platformClassification(item) {
    const label = String(item.account || "").trim() || "未填写平台";
    return { key: normalizedGroupToken(label) || "unassigned", label };
  }

  function isEquityInstrument(item) {
    return ["stock", "etf", "fund", "option"].includes(item.assetType);
  }

  function inferredEquityMarket(item) {
    const descriptor = [item.name, item.code, item.quoteName, item.underlyingName].filter(Boolean).join(" ");
    if (/标普|S\s*&\s*P|纳斯达克|纳指|NASDAQ|美股|美国|(?:^|\s)(?:SPY|VOO|IVV|SPLG|QQQ|QQQM)(?:\.US)?(?:$|\s)/i.test(descriptor)) {
      return { key: "us-equity", label: "美股" };
    }
    if (/恒生|港股|香港|(?:^|\s)(?:HSI|HSCEI)(?:$|\s)/i.test(descriptor)) {
      return { key: "hk-equity", label: "港股" };
    }
    return null;
  }

  function marketClassification(item) {
    const currency = item.currency || "CNY";
    const broadClass = assetClass(item);
    if (broadClass !== "equity") return { key: broadClass, label: classLabels[broadClass] || "其他" };
    const inferredMarket = isEquityInstrument(item) ? inferredEquityMarket(item) : null;
    if (inferredMarket) return inferredMarket;
    if (isEquityInstrument(item) && currency === "USD") return { key: "us-equity", label: "美股" };
    if (isEquityInstrument(item) && currency === "HKD") return { key: "hk-equity", label: "港股" };
    if (isEquityInstrument(item) && currency === "CNY") return { key: "cn-equity", label: "国内权益" };
    return { key: broadClass, label: classLabels[broadClass] || "其他" };
  }

  function hasOverseasEquityDescriptor(item) {
    const descriptor = [item.name, item.code, item.quoteName, item.underlyingName].filter(Boolean).join(" ");
    return Boolean(inferredEquityMarket(item)) || /全球/i.test(descriptor);
  }

  function strategyClassification(item) {
    const bucket = item.strategyBucket;
    if (!["gold", "dividend", "a500", "bond_futures", "cash"].includes(bucket)) return null;
    if (["dividend", "a500"].includes(bucket) && ((item.currency || "CNY") !== "CNY" || hasOverseasEquityDescriptor(item))) return null;
    return { key: bucket, label: bucketLabels[bucket] };
  }

  function categoryTotals(rows, classifier, valueForRow) {
    const totals = new Map();
    rows.forEach((row) => {
      const category = classifier(row.item);
      const value = Number(valueForRow(row, category));
      if (!category || !(value > 0)) return;
      const current = totals.get(category.key) || { ...category, value: 0 };
      current.value += value;
      totals.set(category.key, current);
    });
    return [...totals.values()].sort((left, right) => right.value - left.value);
  }

  function limitDonutSegments(segments, limit, otherLabel) {
    if (segments.length <= limit) return segments;
    const visible = segments.slice(0, limit - 1);
    const otherValue = segments.slice(limit - 1).reduce((sum, item) => sum + item.value, 0);
    return [...visible, { key: "other", label: otherLabel, value: otherValue }];
  }

  function formatCompactMoney(value) {
    return `¥${new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
  }

  function renderDonut(containerId, rawSegments, options) {
    const container = $(containerId);
    container.replaceChildren();
    const segments = rawSegments
      .filter((item) => item.value > 0)
      .map((item, index) => ({ ...item, color: item.color || donutPalette[index % donutPalette.length] }));
    const total = segments.reduce((sum, item) => sum + item.value, 0);
    if (!(total > 0)) {
      const empty = document.createElement("div");
      empty.className = "donut-empty";
      empty.textContent = options.emptyMessage;
      container.appendChild(empty);
      return;
    }

    const layout = document.createElement("div");
    layout.className = "donut-layout";
    const ring = document.createElement("div");
    ring.className = "donut-ring";
    ring.setAttribute("role", "group");
    ring.setAttribute("aria-label", segments.map((item) => `${item.label}${formatPercent(item.value / total)}`).join("，"));
    ring.title = "悬停查看金额和占比；手机点按可固定显示";
    const svgNamespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.classList.add("donut-svg");
    svg.setAttribute("viewBox", "0 0 42 42");
    const background = document.createElementNS(svgNamespace, "circle");
    background.classList.add("donut-background");
    background.setAttribute("cx", "21");
    background.setAttribute("cy", "21");
    background.setAttribute("r", "15.9155");
    background.setAttribute("pathLength", "100");
    svg.appendChild(background);
    const center = document.createElement("div");
    center.className = "donut-center";
    const centerValue = document.createElement("strong");
    centerValue.textContent = formatCompactMoney(total);
    const centerLabel = document.createElement("span");
    centerLabel.textContent = options.centerLabel;
    center.append(centerValue, centerLabel);
    ring.append(svg, center);

    const legend = document.createElement("ul");
    legend.className = "donut-legend";
    const detail = document.createElement("div");
    detail.className = "donut-detail-line";
    detail.setAttribute("aria-live", "polite");
    const segmentNodes = new Map();
    const legendButtons = new Map();
    let pinnedKey = "";

    const renderDetail = (item = null) => {
      const activeKey = item?.key || "";
      detail.textContent = item
        ? `${item.label}｜金额 ${formatMoney(item.value)}｜占比 ${formatPercent(item.value / total)}${pinnedKey === item.key ? "｜已选择" : ""}`
        : `合计 ${formatMoney(total)}｜悬停饼图查看；手机点按可固定`;
      centerValue.textContent = formatCompactMoney(item?.value ?? total);
      centerLabel.textContent = item?.label || options.centerLabel;
      segmentNodes.forEach((node, key) => {
        node.classList.toggle("is-active", key === activeKey);
        node.setAttribute("aria-pressed", String(key === pinnedKey));
      });
      legendButtons.forEach((button, key) => {
        button.classList.toggle("is-active", key === activeKey);
        button.setAttribute("aria-pressed", String(key === pinnedKey));
      });
    };
    const restoreDetail = () => renderDetail(segments.find((item) => item.key === pinnedKey) || null);
    const toggleDetail = (item) => {
      pinnedKey = pinnedKey === item.key ? "" : item.key;
      restoreDetail();
    };
    const pointAt = (percentage) => {
      const radians = (percentage * 3.6 - 90) * Math.PI / 180;
      return {
        x: 21 + 20 * Math.cos(radians),
        y: 21 + 20 * Math.sin(radians)
      };
    };
    const wedgePath = (startPercentage, endPercentage) => {
      if (endPercentage - startPercentage >= 99.999) {
        return "M 21 21 L 21 1 A 20 20 0 1 1 21 41 A 20 20 0 1 1 21 1 Z";
      }
      const start = pointAt(startPercentage);
      const end = pointAt(endPercentage);
      const largeArc = endPercentage - startPercentage > 50 ? 1 : 0;
      return `M 21 21 L ${start.x} ${start.y} A 20 20 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
    };

    let cursor = 0;
    segments.forEach((item) => {
      const share = item.value / total * 100;
      const segment = document.createElementNS(svgNamespace, "path");
      segment.classList.add("donut-segment");
      segment.setAttribute("d", wedgePath(cursor, cursor + share));
      segment.setAttribute("fill", item.color);
      segment.setAttribute("role", "button");
      segment.setAttribute("tabindex", "0");
      segment.setAttribute("aria-label", `${item.label}，${formatMoney(item.value)}，${formatPercent(item.value / total)}`);
      const segmentTitle = document.createElementNS(svgNamespace, "title");
      segmentTitle.textContent = `${item.label} · ${formatMoney(item.value)} · ${formatPercent(item.value / total)}`;
      segment.appendChild(segmentTitle);
      segment.addEventListener("pointerenter", () => renderDetail(item));
      segment.addEventListener("pointerleave", restoreDetail);
      segment.addEventListener("focus", () => renderDetail(item));
      segment.addEventListener("blur", restoreDetail);
      segment.addEventListener("click", () => toggleDetail(item));
      segment.addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        toggleDetail(item);
      });
      svg.appendChild(segment);
      segmentNodes.set(item.key, segment);
      cursor += share;

      const legendItem = document.createElement("li");
      const legendButton = document.createElement("button");
      legendButton.className = "donut-legend-button";
      legendButton.type = "button";
      legendButton.setAttribute("aria-label", `${item.label}，${formatMoney(item.value)}，${formatPercent(item.value / total)}`);
      const swatch = document.createElement("span");
      swatch.className = "donut-swatch";
      swatch.style.background = item.color;
      const label = document.createElement("span");
      label.className = "donut-legend-label";
      label.textContent = item.label;
      label.title = item.label;
      const value = document.createElement("span");
      value.className = "donut-legend-value";
      value.textContent = formatPercent(item.value / total);
      legendButton.append(swatch, label, value);
      legendButton.addEventListener("pointerenter", () => renderDetail(item));
      legendButton.addEventListener("pointerleave", restoreDetail);
      legendButton.addEventListener("focus", () => renderDetail(item));
      legendButton.addEventListener("blur", restoreDetail);
      legendButton.addEventListener("click", () => toggleDetail(item));
      legendButtons.set(item.key, legendButton);
      legendItem.appendChild(legendButton);
      legend.appendChild(legendItem);
    });
    layout.append(ring, legend, detail);
    container.appendChild(layout);
    renderDetail();
  }

  function renderHoldingInsights(metrics) {
    const netAssetValue = ({ item, calc }) => item.includeNav ? Math.max(0, calc.valueCny) : 0;
    const platforms = limitDonutSegments(categoryTotals(metrics.rows, platformClassification, netAssetValue), 6, "其他平台");
    const classes = categoryTotals(metrics.rows, (item) => {
      const key = assetClass(item);
      return { key, label: classLabels[key] };
    }, netAssetValue).map((item) => ({ ...item, color: classColors[item.key] }));
    const strategies = categoryTotals(metrics.rows, strategyClassification, ({ item, calc }, category) => {
      if (!category) return 0;
      return category.key === "cash" ? Math.max(0, calc.valueCny) : Math.abs(calc.exposureCny);
    }).map((item) => ({ ...item, color: strategyColors[item.key] }));

    renderDonut("platform-donut", platforms, { centerLabel: "总资产", emptyMessage: "录入资产后显示平台分布" });
    renderDonut("class-donut", classes, { centerLabel: "总资产", emptyMessage: "录入资产后显示类别分布" });
    renderDonut("strategy-donut", strategies, { centerLabel: "总敞口", emptyMessage: "尚无已归类的策略资产" });
  }

  function dailyContributionDetails(group) {
    const detailsByUnderlying = new Map();
    group.rows.forEach(({ item: holding, calc }) => {
      const identity = dailyContributionIdentity(holding, group.label);
      const detailItem = detailsByUnderlying.get(identity.key) || { ...identity, value: 0, estimated: false };
      detailItem.value += calc.dailyPnlCny;
      detailItem.estimated ||= calc.dailyPnlEstimated;
      detailsByUnderlying.set(identity.key, detailItem);
    });
    return [...detailsByUnderlying.values()]
      .filter((item) => group.value > 0 ? item.value > 0 : item.value < 0)
      .sort((left, right) => group.value > 0 ? right.value - left.value : left.value - right.value)
      .slice(0, 5);
  }

  function createDailyContributionDetails(group, panelId) {
    const positive = group.value > 0;
    const directionLabel = positive ? "盈利" : "亏损";
    const details = dailyContributionDetails(group);
    const directionalTotal = details.reduce((sum, item) => sum + Math.abs(item.value), 0);
    const panel = document.createElement("div");
    panel.id = panelId;
    panel.className = "daily-contribution-details";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", `${group.label}${directionLabel}贡献前五品种`);
    const heading = document.createElement("div");
    heading.className = "daily-contribution-details-heading";
    const title = document.createElement("strong");
    title.textContent = `${directionLabel}贡献前五品种`;
    const mergeNote = document.createElement("span");
    mergeNote.textContent = "同品种跨平台合并";
    heading.append(title, mergeNote);
    const list = document.createElement("ol");
    list.className = "daily-contribution-details-list";
    details.forEach((detail, index) => {
      const listItem = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "daily-contribution-detail-rank";
      rank.textContent = String(index + 1);
      const identity = document.createElement("div");
      identity.className = "daily-contribution-detail-identity";
      const label = document.createElement("strong");
      label.textContent = detail.label;
      label.title = detail.label;
      const share = document.createElement("small");
      share.textContent = directionalTotal > 0
        ? `${detail.estimated ? "盘中参考 · " : ""}占所列${directionLabel}贡献 ${formatPercent(Math.abs(detail.value) / directionalTotal)}`
        : directionLabel;
      identity.append(label, share);
      const value = document.createElement("strong");
      value.className = detail.value > 0 ? "positive" : "negative";
      value.textContent = `${detail.estimated ? "估 " : ""}${detail.value > 0 ? `+${formatMoney(detail.value)}` : formatMoney(detail.value)}`;
      listItem.append(rank, identity, value);
      list.appendChild(listItem);
    });
    const hint = document.createElement("p");
    hint.className = "daily-contribution-details-hint";
    hint.textContent = "仅显示同方向贡献最大的五个品种";
    panel.append(heading, list, hint);
    return panel;
  }

  function renderDailyContribution(metrics) {
    const chart = $("daily-contribution-chart");
    chart.replaceChildren();
    const grouped = new Map();
    metrics.rows.forEach((row) => {
      const strategyCategory = strategyClassification(row.item);
      const category = strategyCategory || marketClassification(row.item);
      const groupKey = `daily:${category.key}`;
      const current = grouped.get(groupKey) || { ...category, key: groupKey, value: 0, rows: [], estimated: false };
      current.rows.push(row);
      const { calc } = row;
      current.value += calc.dailyPnlCny;
      current.estimated ||= calc.dailyPnlEstimated;
      grouped.set(groupKey, current);
    });
    const contributions = [...grouped.values()].filter((item) => Math.abs(item.value) >= 0.005);
    const gains = contributions
      .filter((item) => item.value > 0)
      .sort((left, right) => right.value - left.value)
      .slice(0, 3);
    const losses = contributions
      .filter((item) => item.value < 0)
      .sort((left, right) => left.value - right.value)
      .slice(0, 3);
    const selected = [...gains, ...losses];
    if (!selected.length) {
      const empty = document.createElement("div");
      empty.className = "daily-contribution-empty";
      empty.textContent = vault.holdings.length ? "今日暂无可显示的价格变动" : "录入并刷新行情后显示当日贡献";
      chart.appendChild(empty);
      return;
    }

    const axis = document.createElement("div");
    axis.className = "daily-contribution-axis";
    const axisTrack = document.createElement("div");
    axisTrack.className = "daily-contribution-axis-track";
    const lossLabel = document.createElement("span");
    lossLabel.textContent = "亏损 ←";
    const gainLabel = document.createElement("span");
    gainLabel.textContent = "→ 盈利";
    axisTrack.append(lossLabel, gainLabel);
    axis.append(document.createElement("span"), axisTrack, document.createElement("span"));
    chart.appendChild(axis);

    const maxAbsolute = Math.max(...selected.map((item) => Math.abs(item.value)), 1e-12);
    selected.forEach((item) => {
      const expanded = expandedDailyContributionGroups.has(item.key);
      const panelId = `daily-contribution-details-${item.key.replace(/[^a-z0-9_-]+/gi, "-")}`;
      const row = document.createElement("button");
      row.className = "daily-contribution-row";
      row.type = "button";
      row.classList.toggle("is-expanded", expanded);
      row.setAttribute("aria-expanded", String(expanded));
      row.setAttribute("aria-controls", panelId);
      row.title = `${expanded ? "收起" : "展开"}${item.label}${item.value > 0 ? "盈利" : "亏损"}贡献前五品种`;
      const labelWrap = document.createElement("span");
      labelWrap.className = "daily-contribution-label-wrap";
      const chevron = document.createElement("span");
      chevron.className = "daily-contribution-chevron";
      chevron.textContent = "›";
      const label = document.createElement("span");
      label.className = "daily-contribution-label";
      label.textContent = item.label;
      label.title = item.label;
      labelWrap.append(chevron, label);
      const track = document.createElement("div");
      track.className = "daily-contribution-track";
      const bar = document.createElement("span");
      const direction = item.value > 0 ? "positive" : "negative";
      bar.className = `daily-contribution-bar ${direction}`;
      bar.style.width = `${Math.abs(item.value) / maxAbsolute * 50}%`;
      track.appendChild(bar);
      const value = document.createElement("strong");
      value.className = `daily-contribution-value ${direction}`;
      value.textContent = `${item.estimated ? "估 " : ""}${item.value > 0 ? `+${formatMoney(item.value)}` : formatMoney(item.value)}`;
      row.setAttribute("aria-label", `${item.label} ${item.value > 0 ? "盈利贡献" : "亏损贡献"}${value.textContent}`);
      row.append(labelWrap, track, value);
      row.addEventListener("click", () => {
        if (expanded) expandedDailyContributionGroups.delete(item.key);
        else {
          expandedDailyContributionGroups.clear();
          expandedDailyContributionGroups.add(item.key);
        }
        renderDailyContribution(metrics);
      });
      chart.appendChild(row);
      if (expanded) chart.appendChild(createDailyContributionDetails(item, panelId));
    });
  }

  function appendCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    row.appendChild(cell);
    return cell;
  }

  function normalizedGroupToken(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s·_\-—/()（）&.]+/g, "");
  }

  function meaningfulContributionLabel(value, groupLabel = "") {
    const label = String(value || "").trim();
    if (!label) return "";
    const token = normalizedGroupToken(label);
    if (!token || token === normalizedGroupToken(groupLabel)) return "";
    return genericContributionLabels.has(token) ? "" : label;
  }

  function canonicalInstrumentCode(item) {
    let code = String(item.code || item.resolvedQuoteId || item.quoteId || "").trim().toUpperCase();
    code = code
      .replace(/^(?:TENCENT|SINA):/i, "")
      .replace(/^(?:US|SH|SZ|HK|JJ)(?=[A-Z0-9])/i, "")
      .replace(/\.(?:US|SH|SZ|HK|OF|CFE)$/i, "");
    return code;
  }

  function knownUnderlyingIdentity(item) {
    const descriptor = [item.name, item.code, item.quoteName, item.underlyingName].filter(Boolean).join(" ");
    const knownUnderlyings = [
      { label: "标普500", pattern: /标普\s*500|S\s*&\s*P\s*500|S\s*P\s*500|(?:^|\s)(?:SPY|VOO|IVV|SPLG)(?:\.US)?(?:$|\s)/i },
      { label: "纳斯达克100", pattern: /纳斯达克\s*100|纳指\s*100|NASDAQ\s*100|(?:^|\s)QQQ(?:M)?(?:\.US)?(?:$|\s)/i },
      { label: "沪深300", pattern: /沪深\s*300|CSI\s*300/i },
      { label: "中证A500", pattern: /中证\s*A\s*500|(?:^|\s)A500(?:$|\s)/i }
    ];
    const known = knownUnderlyings.find((rule) => rule.pattern.test(descriptor));
    return known ? { key: `known:${normalizedGroupToken(known.label)}`, label: known.label } : null;
  }

  function dailyContributionIdentity(item, groupLabel) {
    const code = canonicalInstrumentCode(item);
    const specificLabel = meaningfulContributionLabel(item.name, groupLabel)
      || meaningfulContributionLabel(item.quoteName, groupLabel)
      || meaningfulContributionLabel(item.underlyingName, groupLabel)
      || code
      || "未命名资产";

    if (["stock", "futures", "option"].includes(item.assetType)) {
      return {
        key: `instrument:${item.assetType}:${normalizedGroupToken(code || specificLabel || item.id)}`,
        label: specificLabel
      };
    }

    const explicitUnderlying = meaningfulContributionLabel(item.underlyingName, groupLabel);
    if (explicitUnderlying) {
      return { key: `underlying:${normalizedGroupToken(explicitUnderlying)}`, label: explicitUnderlying };
    }
    const knownUnderlying = knownUnderlyingIdentity(item);
    if (knownUnderlying && meaningfulContributionLabel(knownUnderlying.label, groupLabel)) return knownUnderlying;
    return {
      key: `instrument:${item.assetType || "other"}:${normalizedGroupToken(code || specificLabel || item.id)}`,
      label: specificLabel
    };
  }

  function holdingGroupIdentity(item) {
    const explicit = String(item.underlyingName || "").trim();
    if (explicit) return { key: `underlying:${normalizedGroupToken(explicit)}`, label: explicit };
    const known = knownUnderlyingIdentity(item);
    if (known) return known;

    const code = normalizedGroupToken(item.code);
    if (code) return { key: `code:${code}`, label: item.name || item.code };
    const name = normalizedGroupToken(item.name);
    if (name) return { key: `name:${name}`, label: item.name };
    return null;
  }

  function presentationGroupIdentity(item, mode) {
    if (mode === "platform") {
      const category = platformClassification(item);
      return { key: `platform:${category.key}`, label: category.label, alwaysGroup: true };
    }
    if (mode === "market") {
      const category = marketClassification(item);
      return { key: `market:${category.key}`, label: category.label, alwaysGroup: true };
    }
    if (mode === "strategy") {
      const category = strategyClassification(item);
      return category
        ? { key: `strategy:${category.key}`, label: category.label, alwaysGroup: true }
        : { key: "strategy:unassigned", label: "未纳入策略", alwaysGroup: true, unassigned: true };
    }
    const identity = holdingGroupIdentity(item);
    return identity ? { ...identity, key: `underlying:${identity.key}`, alwaysGroup: false } : null;
  }

  function holdingPresentationEntries(rows, mode = "underlying") {
    const grouped = new Map();
    rows.forEach((row, index) => {
      const identity = presentationGroupIdentity(row.item, mode);
      if (!identity) {
        grouped.set(`item:${row.item.id}`, { key: `item:${row.item.id}`, label: row.item.name, rows: [row], index, mode });
        return;
      }
      if (!grouped.has(identity.key)) grouped.set(identity.key, { ...identity, rows: [], index, mode });
      grouped.get(identity.key).rows.push(row);
    });
    const entries = [...grouped.values()];
    if (mode === "underlying") return entries.sort((left, right) => left.index - right.index);
    return entries.sort((left, right) => {
      if (left.unassigned !== right.unassigned) return left.unassigned ? 1 : -1;
      const total = (group) => group.rows.reduce((sum, { item, calc }) => {
        if (mode === "strategy") {
          const category = strategyClassification(item);
          if (category) return sum + (category.key === "cash" ? Math.max(0, calc.valueCny) : Math.abs(calc.exposureCny));
        }
        return sum + Math.max(0, calc.valueCny);
      }, 0);
      return total(right) - total(left) || left.label.localeCompare(right.label, "zh-CN");
    });
  }

  function createHoldingIdentity(item) {
    const identity = document.createElement("div");
    const name = document.createElement("span");
    name.className = "holding-name";
    name.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "holding-meta";
    meta.textContent = [item.account, item.code, typeLabels[item.assetType], fundUsesEstimatedShares(item) ? "份额估算" : ""].filter(Boolean).join(" · ");
    identity.append(name, meta);
    return identity;
  }

  function createHoldingRow({ item, calc }, metrics, options = {}) {
    const row = document.createElement("tr");
    if (options.child) row.className = "holding-child-row";
    appendCell(row, "资产", createHoldingIdentity(item));

    let positionText;
    if (["fixed", "interest"].includes(item.pricingMode)) positionText = formatNative(accruedFixedValue(item), item.currency);
    else positionText = `${formatNumber(item.quantity)} ${calc.derivative ? "手" : "份"}${fundUsesEstimatedShares(item) ? "（估）" : ""}`;
    appendCell(row, "持仓", positionText);
    const latestPrice = ["fixed", "interest"].includes(item.pricingMode)
      ? "--"
      : formatQuotePrice(item.price, item.currency);
    appendCell(row, "最新价", latestPrice);
    appendCell(row, "当前价值", item.includeNav ? formatMoney(calc.valueCny) : "不计入");
    const dailyCell = appendCell(row, "当日变动", calc.dailyPnlPending
      ? "待净值"
      : `${calc.dailyPnlEstimated ? "估 " : ""}${formatMoney(calc.dailyPnlCny)}`);
    if (calc.dailyPnlPending) dailyCell.title = `最近净值日期 ${fundNavDate(item)}，当日盈亏暂不计算`;
    else {
      setSignedClass(dailyCell, calc.dailyPnlCny);
      if (calc.dailyPnlEstimated) {
        dailyCell.title = `按 ${calc.intradayProxyMove.name} 当日涨跌 ${formatPercent(calc.intradayProxyMove.rate, 2)} 估算；正式净值公布后自动替换`;
      }
    }
    appendCell(row, "风险敞口", formatMoney(calc.exposureCny));
    appendCell(row, "资产权重", metrics.totalAssets > 0 && item.includeNav ? formatPercent(calc.valueCny / metrics.totalAssets) : "--");
    const pnlCell = appendCell(row, "累计盈亏", formatMoney(calc.pnlCny));
    setSignedClass(pnlCell, calc.pnlCny);
    if (fundUsesEstimatedShares(item)) {
      pnlCell.title = `自 ${String(item.fundCalibratedAt || "首次录入").slice(0, 10)} 金额校准后估算`;
    }

    const quote = document.createElement("span");
    const quoteSucceeded = item.quoteTime && item.quoteStatus !== "更新失败";
    const fundStatus = fundQuotePresentation(item);
    quote.className = `quote-status${fundStatus.pending ? " pending" : (quoteSucceeded ? " ok" : "")}`;
    quote.textContent = item.pricingMode === "auto" ? fundStatus.text : "本地估值";
    if (item.pricingMode === "auto") {
      const calibration = fundUsesEstimatedShares(item) && item.fundCalibratedAt
        ? `校准 ${String(item.fundCalibratedAt).slice(0, 10)} · ${holdingUsesFundNav(item) ? "净值" : "价格"} ${formatQuotePrice(item.fundCalibrationNav, item.currency)}`
        : "";
      const navDate = holdingUsesFundNav(item) && fundNavDate(item) ? `净值日期 ${fundNavDate(item)}` : "";
      const intradayProxy = item.intradayProxyResolvedQuoteId
        ? `盘中参考 ${item.intradayProxyQuoteName || item.intradayProxyResolvedQuoteId}${item.intradayProxyQuoteTime ? ` · ${new Date(item.intradayProxyQuoteTime).toLocaleString("zh-CN", { hour12: false })}` : ""}`
        : "";
      const details = [item.resolvedQuoteId, navDate, calibration, intradayProxy, item.intradayProxyError, item.quoteError].filter(Boolean).join(" · ");
      if (details) quote.title = details;
    }
    appendCell(row, "行情", quote);

    const actions = document.createElement("div");
    actions.className = "table-actions";
    if (isTradeableHolding(item)) {
      const trade = document.createElement("button");
      trade.className = "table-action trade";
      trade.type = "button";
      trade.textContent = "买卖";
      trade.dataset.action = "trade";
      trade.dataset.id = item.id;
      actions.appendChild(trade);
    }
    const edit = document.createElement("button");
    edit.className = "table-action";
    edit.type = "button";
    edit.textContent = "编辑";
    edit.dataset.action = "edit";
    edit.dataset.id = item.id;
    const remove = document.createElement("button");
    remove.className = "table-action";
    remove.type = "button";
    remove.textContent = "删除";
    remove.dataset.action = "delete";
    remove.dataset.id = item.id;
    remove.disabled = holdingHasTransactionReferences(item.id);
    if (remove.disabled) remove.title = "已有买卖记录或关联现金，不能直接删除";
    actions.append(edit, remove);
    appendCell(row, "操作", actions);
    return row;
  }

  function createHoldingGroupRow(group, metrics) {
    const expanded = expandedHoldingGroups.has(group.key);
    const row = document.createElement("tr");
    row.className = `holding-group-row${expanded ? " is-expanded" : ""}`;
    row.dataset.groupKey = group.key;

    const toggle = document.createElement("button");
    toggle.className = "holding-group-toggle";
    toggle.type = "button";
    toggle.dataset.action = "toggle-group";
    toggle.dataset.groupKey = group.key;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${group.label}的${group.rows.length}笔持仓`);
    const chevron = document.createElement("span");
    chevron.className = "holding-group-chevron";
    chevron.textContent = "›";
    const identity = document.createElement("span");
    const name = document.createElement("span");
    name.className = "holding-name";
    name.textContent = group.label;
    const accounts = new Set(group.rows.map(({ item }) => item.account).filter(Boolean));
    const assetTypes = new Set(group.rows.map(({ item }) => typeLabels[item.assetType]).filter(Boolean));
    const estimatedFunds = group.rows.filter(({ item }) => fundUsesEstimatedShares(item)).length;
    const currencies = [...new Set(group.rows.map(({ item }) => item.currency || "CNY"))];
    const currencyText = currencies.some((currency) => currency !== "CNY")
      ? `${currencies.join("/")} · 已折算人民币`
      : "人民币口径";
    const meta = document.createElement("span");
    meta.className = "holding-meta";
    meta.textContent = [
      `${group.rows.length}笔持仓`,
      group.mode === "platform" ? `${assetTypes.size}类资产` : (accounts.size ? `${accounts.size}个平台` : ""),
      estimatedFunds ? `${estimatedFunds}笔份额估算` : "",
      group.unassigned ? "不计入策略饼图" : "",
      currencyText
    ].filter(Boolean).join(" · ");
    identity.append(name, meta);
    toggle.append(chevron, identity);
    appendCell(row, "资产", toggle);

    const totals = group.rows.reduce((sum, { calc }) => ({
      value: sum.value + calc.valueCny,
      daily: sum.daily + calc.dailyPnlCny,
      exposure: sum.exposure + calc.exposureCny,
      pnl: sum.pnl + calc.pnlCny,
      estimatedDailyCount: sum.estimatedDailyCount + (calc.dailyPnlEstimated ? 1 : 0),
      pendingDailyCount: sum.pendingDailyCount + (calc.dailyPnlPending ? 1 : 0)
    }), { value: 0, daily: 0, exposure: 0, pnl: 0, estimatedDailyCount: 0, pendingDailyCount: 0 });
    appendCell(row, "持仓", `${group.rows.length}笔`);
    appendCell(row, "最新价", "展开查看");
    appendCell(row, "当前价值", formatMoney(totals.value));
    const dailyCell = appendCell(row, "当日变动", `${totals.estimatedDailyCount ? "估 " : ""}${formatMoney(totals.daily)}`);
    setSignedClass(dailyCell, totals.daily);
    if (totals.estimatedDailyCount) dailyCell.title = `${totals.estimatedDailyCount}笔场外基金使用场内行情估算`;
    else if (totals.pendingDailyCount) dailyCell.title = `${totals.pendingDailyCount}笔基金等待净值或参考行情`;
    appendCell(row, "风险敞口", formatMoney(totals.exposure));
    appendCell(row, "资产权重", metrics.totalAssets > 0 ? formatPercent(totals.value / metrics.totalAssets) : "--");
    const pnlCell = appendCell(row, "累计盈亏", formatMoney(totals.pnl));
    setSignedClass(pnlCell, totals.pnl);

    const automatic = group.rows.filter(({ item }) => item.pricingMode === "auto");
    const successful = automatic.filter(({ item }) => item.quoteTime && item.quoteStatus !== "更新失败").length;
    const pendingFunds = automatic.filter(({ calc }) => calc.dailyPnlPending).length;
    const intradayEstimatedFunds = group.rows.filter(({ calc }) => calc.dailyPnlEstimated).length;
    const quote = document.createElement("span");
    quote.className = `quote-status${pendingFunds || intradayEstimatedFunds ? " pending" : (automatic.length && successful === automatic.length ? " ok" : "")}`;
    quote.textContent = automatic.length
      ? (intradayEstimatedFunds
        ? `盘中估 ${intradayEstimatedFunds}笔${pendingFunds ? ` · 待净值 ${pendingFunds}笔` : ""}`
        : (pendingFunds ? `待净值 ${pendingFunds}/${automatic.length}` : `行情 ${successful}/${automatic.length}`))
      : "本地估值";
    quote.title = "各项价值已按最新汇率换算为人民币";
    appendCell(row, "行情", quote);
    const actionHint = document.createElement("span");
    actionHint.className = "holding-group-action";
    actionHint.textContent = expanded ? "收起" : "展开";
    const actionCell = appendCell(row, "操作", actionHint);
    actionCell.className = "holding-group-action-cell";
    return row;
  }

  function renderHoldings(metrics) {
    const body = $("holdings-body");
    body.replaceChildren();
    const visible = metrics.rows.filter(({ item }) => activeFilter === "all" || assetClass(item) === activeFilter);
    $("holdings-empty").hidden = vault.holdings.length > 0;
    $("holdings-table-wrap").hidden = vault.holdings.length === 0;
    holdingPresentationEntries(visible, holdingGroupingMode).forEach((group) => {
      if (!group.alwaysGroup && group.rows.length < 2) {
        body.appendChild(createHoldingRow(group.rows[0], metrics));
        return;
      }
      body.appendChild(createHoldingGroupRow(group, metrics));
      if (expandedHoldingGroups.has(group.key)) {
        group.rows.forEach((holding) => body.appendChild(createHoldingRow(holding, metrics, { child: true })));
      }
    });
  }

  function transactionTimestamp(transaction) {
    const createdAt = new Date(transaction.createdAt || `${transaction.date}T00:00:00+08:00`);
    if (!Number.isFinite(createdAt.getTime())) return transaction.date || "--";
    return createdAt.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function renderTransactions() {
    const transactions = [...(vault?.transactions || [])]
      .filter((transaction) => transaction?.id && transaction?.holdingId)
      .sort((left, right) => `${right.date || ""}|${right.createdAt || ""}`.localeCompare(`${left.date || ""}|${left.createdAt || ""}`));
    $("transaction-count").textContent = `${transactions.length}笔记录`;
    $("transactions-empty").hidden = transactions.length > 0;
    $("transactions-table-wrap").hidden = transactions.length === 0;
    $("transactions-limit-note").hidden = transactions.length <= 30;
    const body = $("transactions-body");
    body.replaceChildren();
    const latestByHolding = new Map();
    transactions.forEach((transaction) => {
      if (!latestByHolding.has(transaction.holdingId)) latestByHolding.set(transaction.holdingId, transaction.id);
    });

    transactions.slice(0, 30).forEach((transaction) => {
      const holding = vault.holdings.find((item) => item.id === transaction.holdingId);
      const row = document.createElement("tr");
      appendCell(row, "时间", transactionTimestamp(transaction));

      const identity = document.createElement("div");
      const name = document.createElement("span");
      name.className = "transaction-asset-name";
      name.textContent = holding?.name || transaction.assetName || "已移除资产";
      const meta = document.createElement("span");
      meta.className = "transaction-asset-meta";
      meta.textContent = [holding?.account || transaction.account, holding?.code || transaction.assetCode, transaction.currency].filter(Boolean).join(" · ");
      identity.append(name, meta);
      appendCell(row, "资产", identity);

      const type = document.createElement("span");
      type.className = `transaction-type ${transaction.type}`;
      type.textContent = transaction.type === "sell" ? "卖出" : "买入";
      appendCell(row, "方向", type);
      appendCell(row, "成交数量", `${formatNumber(transaction.quantity, 4)} 份${transaction.quantityEstimated ? "（估）" : ""}`);
      appendCell(row, "成交价", formatQuotePrice(transaction.price, transaction.currency));

      const amount = document.createElement("div");
      const nativeAmount = document.createElement("span");
      nativeAmount.textContent = formatNative(transaction.amountNative, transaction.currency);
      amount.appendChild(nativeAmount);
      if (transaction.currency !== "CNY") {
        const cnyAmount = document.createElement("span");
        cnyAmount.className = "transaction-subvalue";
        cnyAmount.textContent = `折合 ${formatMoney(transaction.amountCny)}`;
        amount.appendChild(cnyAmount);
      }
      appendCell(row, "成交额", amount);
      appendCell(row, "成交后持仓", `${formatNumber(transaction.afterQuantity, 4)} 份`);

      const actions = document.createElement("div");
      actions.className = "table-actions";
      if (latestByHolding.get(transaction.holdingId) === transaction.id) {
        const undo = document.createElement("button");
        undo.className = "table-action";
        undo.type = "button";
        undo.textContent = "撤销";
        undo.dataset.action = "undo-trade";
        undo.dataset.id = transaction.id;
        actions.appendChild(undo);
      }
      appendCell(row, "操作", actions);
      body.appendChild(row);
    });
  }

  function sortedSnapshots() {
    return (vault?.snapshots || [])
      .filter((item) => item?.date && Number.isFinite(Number(item.totalAssets)))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  function weekStart(dateText) {
    const date = new Date(`${dateText}T00:00:00Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    return date.toISOString().slice(0, 10);
  }

  function periodKey(dateText, period) {
    if (period === "month") return dateText.slice(0, 7);
    if (period === "week") return weekStart(dateText);
    return dateText;
  }

  function periodLabel(key, period) {
    if (period === "month") return key.slice(2).replace("-", "/");
    if (period === "week") return `${key.slice(5).replace("-", "/")}周`;
    return key.slice(5).replace("-", "/");
  }

  function aggregateSnapshots(snapshots, period) {
    const groups = new Map();
    snapshots.forEach((snapshot) => groups.set(periodKey(snapshot.date, period), snapshot));
    const limits = { day: 90, week: 52, month: 36 };
    return [...groups.entries()].map(([key, snapshot], index, entries) => {
      const previous = index > 0 ? entries[index - 1][1] : null;
      return {
        key,
        label: periodLabel(key, period),
        date: snapshot.date,
        totalAssets: numeric(snapshot.totalAssets),
        change: previous
          ? numeric(snapshot.totalAssets) - numeric(previous.totalAssets) - transactionCapitalFlowBetween(previous.date, snapshot.date)
          : null
      };
    }).slice(-limits[period]);
  }

  function changeFromBaseline(snapshots, startDate, fallbackPrevious = false) {
    if (!snapshots.length) return null;
    const latest = snapshots.at(-1);
    let baseline = snapshots.filter((item) => item.date < startDate).at(-1);
    if (!baseline && fallbackPrevious && snapshots.length > 1) baseline = snapshots.at(-2);
    if (!baseline) return null;
    const baseValue = numeric(baseline.totalAssets);
    const capitalFlowCny = transactionCapitalFlowBetween(baseline.date, latest.date);
    const change = numeric(latest.totalAssets) - baseValue - capitalFlowCny;
    const investedBase = baseValue + Math.max(0, capitalFlowCny);
    return { change, rate: investedBase ? change / investedBase : null };
  }

  function setHistoryChange(id, result) {
    const value = $(`history-${id}-change`);
    const rate = $(`history-${id}-rate`);
    value.textContent = result ? formatMoney(result.change) : "--";
    rate.textContent = result && Number.isFinite(result.rate) ? formatPercent(result.rate, 2) : "--";
    setSignedClass(value, result?.change || 0);
    setSignedClass(rate, result?.change || 0);
  }

  function createSvgNode(name, attributes = {}, text = "") {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text) node.textContent = text;
    return node;
  }

  function renderAssetLine(points) {
    const chart = $("history-chart");
    chart.replaceChildren();
    if (points.length < 2) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "产生两个以上日终记录后显示走势";
      chart.appendChild(empty);
      return;
    }
    const width = 760;
    const height = 240;
    const padding = { left: 16, right: 16, top: 18, bottom: 30 };
    const values = points.map((point) => point.totalAssets);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const margin = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.006, 1);
    const minimum = rawMin - margin;
    const maximum = rawMax + margin;
    const range = Math.max(maximum - minimum, 1);
    const x = (index) => padding.left + index / (points.length - 1) * (width - padding.left - padding.right);
    const y = (value) => padding.top + (maximum - value) / range * (height - padding.top - padding.bottom);
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.totalAssets).toFixed(2)}`).join(" ");
    const area = `${path} L${x(points.length - 1)},${height - padding.bottom} L${x(0)},${height - padding.bottom} Z`;
    const svg = createSvgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "总资产走势折线图" });
    const defs = createSvgNode("defs");
    const gradient = createSvgNode("linearGradient", { id: "history-area-gradient", x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(
      createSvgNode("stop", { offset: "0%", "stop-color": "#24679c", "stop-opacity": "0.22" }),
      createSvgNode("stop", { offset: "100%", "stop-color": "#24679c", "stop-opacity": "0.01" })
    );
    defs.appendChild(gradient);
    svg.appendChild(defs);
    [0.25, 0.5, 0.75].forEach((ratio) => {
      const gridY = padding.top + ratio * (height - padding.top - padding.bottom);
      svg.appendChild(createSvgNode("line", { x1: padding.left, x2: width - padding.right, y1: gridY, y2: gridY, class: "history-grid-line" }));
    });
    svg.appendChild(createSvgNode("path", { d: area, fill: "url(#history-area-gradient)" }));
    svg.appendChild(createSvgNode("path", { d: path, class: "history-line-path" }));
    if (points.length <= 32) {
      points.forEach((point, index) => {
        const dot = createSvgNode("circle", { cx: x(index), cy: y(point.totalAssets), r: 3, class: "history-line-dot" });
        dot.appendChild(createSvgNode("title", {}, `${point.date} ${formatMoney(point.totalAssets)}`));
        svg.appendChild(dot);
      });
    }
    svg.append(
      createSvgNode("text", { x: padding.left, y: height - 8, class: "history-axis-label" }, points[0].label),
      createSvgNode("text", { x: width - padding.right, y: height - 8, "text-anchor": "end", class: "history-axis-label" }, points.at(-1).label)
    );
    chart.appendChild(svg);
  }

  function renderDeltaBars(points) {
    const chart = $("history-delta-chart");
    chart.replaceChildren();
    const changes = points.filter((point) => Number.isFinite(point.change));
    if (!changes.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "下一条记录产生后显示资产变动";
      chart.appendChild(empty);
      return;
    }
    const maximum = Math.max(...changes.map((point) => Math.abs(point.change)), 1);
    const axis = document.createElement("span");
    axis.className = "history-delta-axis";
    chart.appendChild(axis);
    changes.forEach((point, index) => {
      const column = document.createElement("div");
      column.className = "history-delta-column";
      column.title = `${point.label} ${formatMoney(point.change)}`;
      const track = document.createElement("div");
      track.className = "history-delta-track";
      const bar = document.createElement("span");
      bar.className = `history-delta-bar ${point.change >= 0 ? "positive" : "negative"}`;
      bar.style.height = `${Math.max(3, Math.abs(point.change) / maximum * 46)}%`;
      track.appendChild(bar);
      const label = document.createElement("small");
      const labelEvery = Math.max(1, Math.ceil(changes.length / 6));
      label.textContent = index % labelEvery === 0 || index === changes.length - 1 ? point.label : "";
      column.append(track, label);
      chart.appendChild(column);
    });
  }

  function renderHistory() {
    const snapshots = sortedSnapshots();
    $("snapshot-count").textContent = `${snapshots.length}个交易日`;
    $("history-latest-total").textContent = snapshots.length ? formatMoney(snapshots.at(-1).totalAssets) : "--";
    const latestDate = snapshots.at(-1)?.date;
    setHistoryChange("day", latestDate ? changeFromBaseline(snapshots, latestDate, true) : null);
    setHistoryChange("week", latestDate ? changeFromBaseline(snapshots, weekStart(latestDate)) : null);
    setHistoryChange("month", latestDate ? changeFromBaseline(snapshots, `${latestDate.slice(0, 7)}-01`) : null);
    const points = aggregateSnapshots(snapshots, historyPeriod);
    renderAssetLine(points);
    renderDeltaBars(points);
  }

  function renderAll() {
    if (!vault) return;
    const metrics = portfolioMetrics();
    renderSummary(metrics);
    renderAllocation(metrics);
    renderStrategy(metrics);
    renderDailyContribution(metrics);
    renderHoldingInsights(metrics);
    renderHoldings(metrics);
    renderTransactions();
    renderHistory();
  }

  function tradeableHoldings() {
    return (vault?.holdings || [])
      .filter(isTradeableHolding)
      .sort((left, right) => `${left.account || ""}|${left.name || ""}`.localeCompare(`${right.account || ""}|${right.name || ""}`, "zh-CN"));
  }

  function currentTradeHolding() {
    return vault?.holdings.find((item) => item.id === $("trade-holding").value) || null;
  }

  function tradeCashHolding(item) {
    const accountKey = normalizedGroupToken(item.account);
    return vault.holdings.find((holding) => (
      holding.assetType === "cash"
      && holding.pricingMode === "fixed"
      && holding.currency === item.currency
      && normalizedGroupToken(holding.account) === accountKey
    )) || null;
  }

  function createTradeCashHolding(item) {
    const now = new Date().toISOString();
    const account = String(item.account || "").trim();
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      account,
      name: account ? `${account}现金` : `${item.currency || "CNY"}现金`,
      underlyingName: "",
      code: "",
      assetType: "cash",
      strategyBucket: "cash",
      currency: item.currency || "CNY",
      pricingMode: "fixed",
      quoteId: "",
      quantity: 0,
      price: 0,
      previousClose: 0,
      entryPrice: 0,
      direction: 1,
      multiplier: 1,
      delta: 0,
      underlyingPrice: 0,
      fixedValue: 0,
      fundInputMode: "",
      fundSeedAmount: 0,
      annualRate: 0,
      valuationDate: chinaDate(),
      notes: "买卖记录自动生成",
      includeNav: true,
      updatedAt: now
    };
  }

  function populateTradeHoldingOptions(preselectedId = "") {
    const select = $("trade-holding");
    select.replaceChildren();
    tradeableHoldings().forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = [item.account, item.name, `${formatNumber(item.quantity, 4)}份`].filter(Boolean).join(" · ");
      select.appendChild(option);
    });
    if (preselectedId && [...select.options].some((option) => option.value === preselectedId)) select.value = preselectedId;
  }

  function updateTradeFormForHolding(options = {}) {
    const item = currentTradeHolding();
    if (!item) return;
    $("trade-position-hint").textContent = `当前持仓 ${formatNumber(item.quantity, 4)} 份 · 最新价 ${formatQuotePrice(item.price, item.currency)} · ${item.currency}`;
    $("trade-price").value = numeric(item.price) > 0 ? String(item.price) : "";
    $("trade-input-mode").value = fundUsesEstimatedShares(item) ? "amount" : "quantity";
    if (options.clearInputs !== false) {
      $("trade-quantity").value = "";
      $("trade-amount").value = "";
    }
    updateTradeInputVisibility();
  }

  function updateTradeInputVisibility() {
    const amountMode = $("trade-input-mode").value === "amount";
    document.querySelectorAll(".trade-quantity-field").forEach((node) => { node.hidden = amountMode; });
    document.querySelectorAll(".trade-amount-field").forEach((node) => { node.hidden = !amountMode; });
    updateTradePreview();
  }

  function tradeFormValues() {
    const item = currentTradeHolding();
    const mode = $("trade-input-mode").value;
    const price = numeric($("trade-price").value);
    const multiplier = Math.max(numeric(item?.multiplier, 1), 1e-12);
    const enteredAmount = numeric($("trade-amount").value);
    const enteredQuantity = numeric($("trade-quantity").value);
    const quantity = mode === "amount" && price > 0 ? enteredAmount / price / multiplier : enteredQuantity;
    const amountNative = quantity * price * multiplier;
    return { item, mode, price, multiplier, enteredAmount, enteredQuantity, quantity, amountNative };
  }

  function updateTradePreview() {
    const preview = $("trade-preview");
    const { item, mode, price, quantity, amountNative } = tradeFormValues();
    $("trade-form-error").textContent = "";
    if (!item) {
      preview.textContent = "请先添加可交易资产";
      return;
    }
    const type = $("trade-type").value;
    if (!(price > 0) || !(quantity > 0)) {
      preview.textContent = `${type === "sell" ? "卖出" : "买入"} ${item.name} · 当前持仓 ${formatNumber(item.quantity, 4)} 份`;
      return;
    }
    if (type === "sell" && quantity - numeric(item.quantity) > 1e-8) {
      preview.textContent = `卖出数量超过当前持仓 ${formatNumber(item.quantity, 4)} 份，请减少数量`;
      return;
    }
    const afterQuantity = numeric(item.quantity) + (type === "buy" ? quantity : -quantity);
    const quantityLabel = mode === "amount" ? `估算份额 ${formatNumber(quantity, 4)}` : `${formatNumber(quantity, 4)} 份`;
    const cashNote = type === "sell"
      ? "卖出款将计入同平台现金"
      : "优先扣同平台现金，不足部分视为新增投入";
    preview.textContent = `${type === "sell" ? "卖出" : "买入"} ${quantityLabel} · 成交额 ${formatNative(amountNative, item.currency)} · 成交后 ${formatNumber(afterQuantity, 4)} 份 · ${cashNote}`;
  }

  function openTradeDialog(preselectedId = "") {
    if (!tradeableHoldings().length) {
      showToast("请先添加股票、基金、ETF、黄金或债券资产");
      return;
    }
    tradeForm.reset();
    $("trade-type").value = "buy";
    $("trade-form-error").textContent = "";
    populateTradeHoldingOptions(preselectedId);
    updateTradeFormForHolding();
    tradeDialog.showModal();
    const amountMode = $("trade-input-mode").value === "amount";
    $(amountMode ? "trade-amount" : "trade-quantity").focus();
  }

  async function saveTrade(event) {
    event.preventDefault();
    const values = tradeFormValues();
    const { item, mode, price, quantity, amountNative } = values;
    const type = $("trade-type").value;
    const error = $("trade-form-error");
    error.textContent = "";
    if (!isTradeableHolding(item)) {
      error.textContent = "请选择可交易资产";
      return;
    }
    if (!(price > 0)) {
      error.textContent = "请填写成交价格或净值";
      return;
    }
    if (!(quantity > 0) || !(amountNative > 0)) {
      error.textContent = mode === "amount" ? "请填写成交金额" : "请填写成交数量";
      return;
    }
    const currentQuantity = numeric(item.quantity);
    if (type === "sell" && quantity - currentQuantity > 1e-8) {
      error.textContent = `卖出数量不能超过当前持仓 ${formatNumber(currentQuantity, 4)} 份`;
      return;
    }
    const fxRate = item.currency === "CNY" ? 1 : numeric(vault.fxRates?.[item.currency], NaN);
    if (!(fxRate > 0)) {
      error.textContent = `暂时没有 ${item.currency}/CNY 汇率，请先刷新行情`;
      return;
    }

    const saveButton = $("save-trade");
    saveButton.disabled = true;
    saveButton.textContent = "正在保存";
    try {
      const now = new Date().toISOString();
      const beforeEntryPrice = numeric(item.entryPrice) > 0 ? numeric(item.entryPrice) : price;
      const beforeRealizedPnlCny = numeric(item.realizedPnlCny);
      const afterQuantity = type === "buy" ? currentQuantity + quantity : Math.max(0, currentQuantity - quantity);
      let afterEntryPrice = beforeEntryPrice;
      let afterRealizedPnlCny = beforeRealizedPnlCny;
      if (type === "buy") {
        afterEntryPrice = afterQuantity > 0
          ? (currentQuantity * beforeEntryPrice + quantity * price) / afterQuantity
          : price;
      } else {
        afterRealizedPnlCny += quantity * (price - beforeEntryPrice) * values.multiplier * fxRate;
        if (!(afterQuantity > 1e-8)) afterEntryPrice = 0;
      }

      let cash = tradeCashHolding(item);
      let cashHoldingCreated = false;
      let cashDeltaNative = 0;
      let capitalFlowCny = 0;
      if (type === "buy") {
        const cashUsed = cash ? Math.min(Math.max(0, numeric(cash.fixedValue)), amountNative) : 0;
        if (cashUsed > 0) {
          cash.fixedValue = numeric(cash.fixedValue) - cashUsed;
          cash.updatedAt = now;
          cashDeltaNative = -cashUsed;
        }
        capitalFlowCny = (amountNative - cashUsed) * fxRate;
      } else {
        if (!cash) {
          cash = createTradeCashHolding(item);
          vault.holdings.push(cash);
          cashHoldingCreated = true;
        }
        cash.fixedValue = numeric(cash.fixedValue) + amountNative;
        cash.updatedAt = now;
        cashDeltaNative = amountNative;
      }

      item.quantity = afterQuantity;
      item.entryPrice = afterEntryPrice;
      item.realizedPnlCny = afterRealizedPnlCny;
      if (!(numeric(item.price) > 0)) item.price = price;
      if (!(numeric(item.previousClose) > 0)) item.previousClose = price;
      item.updatedAt = now;

      const transaction = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        holdingId: item.id,
        type,
        date: chinaDate(),
        createdAt: now,
        assetName: item.name,
        assetCode: item.code,
        account: item.account,
        currency: item.currency,
        quantity,
        quantityEstimated: mode === "amount",
        price,
        multiplier: values.multiplier,
        amountNative,
        fxRate,
        amountCny: amountNative * fxRate,
        capitalFlowCny,
        beforeQuantity: currentQuantity,
        afterQuantity,
        beforeEntryPrice,
        afterEntryPrice,
        beforeRealizedPnlCny,
        afterRealizedPnlCny,
        cashHoldingId: cash?.id || "",
        cashHoldingCreated,
        cashDeltaNative
      };
      vault.transactions.push(transaction);
      markLocalUserChange();
      await persistVault();
      await recordSnapshot();
      tradeDialog.close();
      renderAll();
      showToast(`${type === "sell" ? "卖出" : "买入"}已记录：${formatNumber(quantity, 4)} 份`);
    } catch (saveError) {
      error.textContent = `保存失败：${saveError?.message || "请稍后重试"}`;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "保存买卖";
    }
  }

  async function undoTrade(transactionId) {
    const transaction = (vault.transactions || []).find((item) => item.id === transactionId);
    if (!transaction) return;
    const latest = transactionsForHolding(transaction.holdingId).at(-1);
    if (latest?.id !== transaction.id) {
      showToast("请先撤销该资产更晚的买卖记录");
      return;
    }
    const holding = vault.holdings.find((item) => item.id === transaction.holdingId);
    if (!holding || Math.abs(numeric(holding.quantity) - numeric(transaction.afterQuantity)) > 1e-7) {
      showToast("当前持仓与交易记录不一致，无法安全撤销");
      return;
    }
    const cash = transaction.cashHoldingId
      ? vault.holdings.find((item) => item.id === transaction.cashHoldingId)
      : null;
    if (Math.abs(numeric(transaction.cashDeltaNative)) > 1e-8 && !cash) {
      showToast("关联现金资产不存在，无法安全撤销");
      return;
    }
    if (cash && numeric(cash.fixedValue) - numeric(transaction.cashDeltaNative) < -1e-8) {
      showToast("现金余额不足，无法撤销这笔卖出");
      return;
    }

    holding.quantity = numeric(transaction.beforeQuantity);
    holding.entryPrice = numeric(transaction.beforeEntryPrice);
    holding.realizedPnlCny = numeric(transaction.beforeRealizedPnlCny);
    holding.updatedAt = new Date().toISOString();
    if (cash) {
      cash.fixedValue = Math.max(0, numeric(cash.fixedValue) - numeric(transaction.cashDeltaNative));
      cash.updatedAt = new Date().toISOString();
    }
    vault.transactions = vault.transactions.filter((item) => item.id !== transaction.id);
    if (cash && transaction.cashHoldingCreated && !(numeric(cash.fixedValue) > 1e-8)) {
      const stillReferenced = vault.transactions.some((item) => item.cashHoldingId === cash.id);
      if (!stillReferenced) vault.holdings = vault.holdings.filter((item) => item.id !== cash.id);
    }
    markLocalUserChange();
    await persistVault();
    await recordSnapshot();
    renderAll();
    showToast("买卖记录已撤销");
  }

  function setFieldVisibility() {
    const type = $("holding-type").value;
    const supportsAmountInput = ["fund", "etf"].includes(type);
    const amountFund = supportsAmountInput && $("holding-fund-input-mode").value === "amount";
    const supportsIntradayReference = type === "fund"
      && $("holding-currency").value === "CNY"
      && $("holding-bucket").value !== "gold";
    const intradayReferenceEnabled = supportsIntradayReference && $("holding-intraday-estimate-enabled").checked;
    if (amountFund) $("holding-pricing-mode").value = "auto";
    const pricing = $("holding-pricing-mode").value;
    const derivative = type === "futures" || type === "option";
    document.querySelectorAll(".fund-mode-field").forEach((node) => { node.hidden = !supportsAmountInput; });
    document.querySelectorAll(".fund-amount-field").forEach((node) => { node.hidden = !amountFund; });
    document.querySelectorAll(".fund-reference-field").forEach((node) => { node.hidden = !supportsIntradayReference; });
    document.querySelectorAll(".fund-reference-code-field").forEach((node) => { node.hidden = !intradayReferenceEnabled; });
    document.querySelectorAll(".quantity-field").forEach((node) => { node.hidden = amountFund || ["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".price-field").forEach((node) => { node.hidden = amountFund || ["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".fixed-field").forEach((node) => { node.hidden = !["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".interest-field").forEach((node) => { node.hidden = pricing !== "interest"; });
    document.querySelectorAll(".derivative-field").forEach((node) => { node.hidden = !derivative; });
    document.querySelectorAll(".multiplier-field").forEach((node) => { node.hidden = !derivative; });
    document.querySelectorAll(".option-field").forEach((node) => { node.hidden = type !== "option"; });
    $("pricing-mode-field").hidden = amountFund;
    const linkedFundCode = type === "etf" && /^0\d{5}(?:\.OF)?$/i.test($("holding-code").value.trim());
    $("share-price-note").textContent = type === "etf" && !linkedFundCode
      ? "场内 ETF 按最新市场价格估算；份额仅作为金额换算口径"
      : type === "etf"
        ? "该代码按 ETF 联接基金净值计算，不使用盘中黄金价格"
      : "场外基金不是盘中实时价；QDII净值通常会更晚";
    updateFundCalibrationHint();
  }

  function updateFundCalibrationHint() {
    const hint = $("fund-calibration-hint");
    const existing = vault?.holdings.find((item) => item.id === $("holding-id").value);
    const amount = numeric($("holding-fund-seed-amount").value);
    const formUsesFundNav = $("holding-type").value === "fund"
      || /^0\d{5}(?:\.OF)?$/i.test($("holding-code").value.trim());
    const unchanged = existing && fundUsesEstimatedShares(existing)
      && Math.abs(amount - numeric(existing.fundSeedAmount)) < 0.005
      && existing.fundCalibratedAt;
    hint.textContent = unchanged
      ? `已按 ${String(existing.fundCalibratedAt).slice(0, 10)} ${holdingUsesFundNav(existing) ? "净值" : "价格"} ${formatQuotePrice(existing.fundCalibrationNav, existing.currency)} 估算；修改金额会重新校准`
      : `保存时按最新${formUsesFundNav ? "已公布净值" : "价格"}估算份额`;
  }

  function applyTypeDefaults() {
    const type = $("holding-type").value;
    if (["cash", "wealth", "deposit"].includes(type)) {
      $("holding-bucket").value = "cash";
      $("holding-pricing-mode").value = type === "deposit" ? "interest" : "fixed";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    } else if (type === "futures") {
      $("holding-bucket").value = "bond_futures";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "10000";
      $("holding-include-nav").checked = false;
    } else if (type === "option") {
      $("holding-bucket").value = "a500";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "100";
      $("holding-include-nav").checked = false;
    } else if (type === "gold") {
      $("holding-bucket").value = "gold";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    } else if (["fund", "etf"].includes(type)) {
      $("holding-fund-input-mode").value = "amount";
      if (type === "fund") $("holding-currency").value = "CNY";
      $("holding-intraday-estimate-enabled").checked = type === "fund";
      $("holding-intraday-proxy-code").value = "";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    } else {
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    }
    setFieldVisibility();
  }

  function setHoldingLedgerLock(locked) {
    [
      "holding-account",
      "holding-type",
      "holding-fund-input-mode",
      "holding-currency",
      "holding-pricing-mode",
      "holding-fund-seed-amount",
      "holding-quantity",
      "holding-entry-price",
      "holding-fixed-value",
      "holding-multiplier",
      "holding-include-nav"
    ].forEach((id) => { $(id).disabled = locked; });
    $("holding-ledger-notice").hidden = !locked;
  }

  function resetHoldingForm() {
    holdingForm.reset();
    setHoldingLedgerLock(false);
    $("holding-id").value = "";
    $("holding-type").value = "stock";
    $("holding-bucket").value = "other";
    $("holding-fund-input-mode").value = "amount";
    $("holding-currency").value = "CNY";
    $("holding-pricing-mode").value = "auto";
    $("holding-intraday-estimate-enabled").checked = true;
    $("holding-intraday-proxy-code").value = "";
    $("holding-direction").value = "1";
    $("holding-multiplier").value = "1";
    $("holding-valuation-date").value = chinaDate();
    $("holding-include-nav").checked = true;
    $("holding-form-error").textContent = "";
    $("dialog-title").textContent = "添加资产";
    setFieldVisibility();
  }

  function openHoldingDialog(item = null) {
    resetHoldingForm();
    if (item) {
      $("dialog-title").textContent = "编辑资产";
      $("holding-id").value = item.id;
      $("holding-account").value = item.account || "";
      $("holding-name").value = item.name || "";
      $("holding-underlying-name").value = item.underlyingName || "";
      $("holding-code").value = item.code || "";
      $("holding-type").value = item.assetType || "other";
      $("holding-bucket").value = item.strategyBucket || "other";
      $("holding-fund-input-mode").value = item.fundInputMode || "shares";
      $("holding-currency").value = item.currency || "CNY";
      $("holding-pricing-mode").value = item.pricingMode || "manual";
      $("holding-quantity").value = item.quantity ?? "";
      $("holding-price").value = item.price ?? "";
      $("holding-entry-price").value = item.entryPrice ?? "";
      $("holding-direction").value = String(item.direction ?? 1);
      $("holding-multiplier").value = item.multiplier ?? 1;
      $("holding-delta").value = item.delta ?? "";
      $("holding-underlying-price").value = item.underlyingPrice ?? "";
      $("holding-fixed-value").value = item.fixedValue ?? "";
      $("holding-fund-seed-amount").value = item.fundSeedAmount ?? "";
      $("holding-intraday-estimate-enabled").checked = item.intradayEstimateEnabled !== false;
      $("holding-intraday-proxy-code").value = item.intradayProxyCode || "";
      $("holding-annual-rate").value = numeric(item.annualRate) * 100 || "";
      $("holding-valuation-date").value = item.valuationDate || chinaDate();
      $("holding-notes").value = item.notes || "";
      $("holding-include-nav").checked = Boolean(item.includeNav);
      setFieldVisibility();
      setHoldingLedgerLock(holdingHasTransactionReferences(item.id));
    }
    holdingDialog.showModal();
    $("holding-name").focus();
  }

  function formItem() {
    const id = $("holding-id").value;
    const existing = vault.holdings.find((item) => item.id === id) || {};
    const assetType = $("holding-type").value;
    const code = $("holding-code").value.trim().toUpperCase();
    const keepExistingQuoteId = Boolean(existing.id)
      && existing.assetType === assetType
      && String(existing.code || "").trim().toUpperCase() === code;
    const fundInputMode = ["fund", "etf"].includes(assetType) ? $("holding-fund-input-mode").value : "";
    const fundSeedAmount = numeric($("holding-fund-seed-amount").value);
    const intradayEstimateEnabled = assetType === "fund" && $("holding-intraday-estimate-enabled").checked;
    const intradayProxyCode = assetType === "fund" ? $("holding-intraday-proxy-code").value.trim().toUpperCase() : "";
    const amountFund = ["fund", "etf"].includes(assetType) && fundInputMode === "amount";
    const resetFundCalibration = amountFund && (
      !fundUsesEstimatedShares(existing)
      || Math.abs(fundSeedAmount - numeric(existing.fundSeedAmount)) >= 0.005
      || !existing.fundCalibratedAt
    );
    const item = {
      ...existing,
      id: id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
      account: $("holding-account").value.trim(),
      name: $("holding-name").value.trim(),
      underlyingName: $("holding-underlying-name").value.trim(),
      code,
      assetType,
      strategyBucket: $("holding-bucket").value,
      currency: $("holding-currency").value,
      pricingMode: $("holding-pricing-mode").value,
      quoteId: keepExistingQuoteId ? (existing.quoteId || "") : "",
      quantity: amountFund ? numeric(existing.quantity) : numeric($("holding-quantity").value),
      price: amountFund ? numeric(existing.price) : numeric($("holding-price").value),
      entryPrice: amountFund ? numeric(existing.entryPrice) : numeric($("holding-entry-price").value),
      direction: numeric($("holding-direction").value, 1),
      multiplier: numeric($("holding-multiplier").value, 1),
      delta: numeric($("holding-delta").value),
      underlyingPrice: numeric($("holding-underlying-price").value),
      fixedValue: numeric($("holding-fixed-value").value),
      fundInputMode,
      fundSeedAmount: amountFund ? fundSeedAmount : 0,
      fundCalibrationNav: amountFund ? existing.fundCalibrationNav : null,
      fundCalibratedAt: amountFund ? existing.fundCalibratedAt : null,
      intradayEstimateEnabled,
      intradayProxyCode,
      annualRate: numeric($("holding-annual-rate").value) / 100,
      valuationDate: $("holding-valuation-date").value,
      notes: $("holding-notes").value.trim(),
      includeNav: $("holding-include-nav").checked,
      updatedAt: new Date().toISOString()
    };
    if (resetFundCalibration) {
      item.quantity = 0;
      item.price = 0;
      item.previousClose = 0;
      item.entryPrice = 0;
      item.fundCalibrationNav = null;
      item.fundCalibratedAt = null;
    }
    if (!intradayEstimateEnabled || intradayProxyCode !== String(existing.intradayProxyCode || "").trim().toUpperCase()) {
      clearIntradayProxyQuote(item);
    }
    return item;
  }

  function validateItem(item) {
    const estimatedFund = fundUsesEstimatedShares(item);
    if (!item.name && !estimatedFund) return "请填写资产名称";
    if (item.intradayProxyCode && !quoteIdForIntradayProxyCode(item.intradayProxyCode)) return "无法识别盘中参考代码，请填写 ETF 或指数代码";
    if (estimatedFund) {
      if (item.pricingMode !== "auto") return "金额估算模式需要使用自动行情";
      if (!(item.fundSeedAmount > 0)) return "请填写平台显示的当前金额";
      if (!inferQuoteId(item)) return item.assetType === "etf" ? "无法识别 ETF 代码，请检查代码" : "无法识别基金代码，请填写6位基金代码";
      return "";
    }
    if (["fixed", "interest"].includes(item.pricingMode)) {
      if (!(item.fixedValue >= 0)) return "请填写当前金额";
    } else {
      if (!(item.quantity > 0) && !holdingHasTransactions(item.id)) return "数量、份额或手数必须大于0";
      if (item.pricingMode === "manual" && !(item.price > 0)) return "请填写当前价格";
      if (item.pricingMode === "auto" && !inferQuoteId(item)) return "无法自动识别行情，请检查资产类型和代码";
    }
    if ((item.assetType === "futures" || item.assetType === "option") && !(item.multiplier > 0)) return "合约乘数必须大于0";
    if (item.assetType === "option" && Math.abs(item.delta) > 1) return "期权Delta必须在-1到1之间";
    return "";
  }

  async function saveHolding(event) {
    event.preventDefault();
    const item = formItem();
    const error = validateItem(item);
    if (error) {
      $("holding-form-error").textContent = error;
      return;
    }
    const saveButton = $("save-holding");
    const calibratingFund = fundNeedsCalibration(item);
    if (calibratingFund) {
      saveButton.disabled = true;
      saveButton.textContent = holdingUsesFundNav(item) ? "正在读取净值" : "正在读取行情";
      $("holding-form-error").textContent = "";
      try {
        const result = await fetchHoldingQuote(item);
        applyQuoteToHolding(item, result.quote, result.quoteId);
        await refreshIntradayProxyQuote(item, new Map());
        if (!item.name) item.name = result.quote.name || `${item.assetType === "etf" ? "ETF" : "基金"} ${item.code}`;
      } catch (calibrationError) {
        $("holding-form-error").textContent = `暂时没有取到${holdingUsesFundNav(item) ? "基金净值" : " ETF 行情"}：${calibrationError?.message || "请稍后重试"}`;
        saveButton.disabled = false;
        saveButton.textContent = "保存资产";
        return;
      }
    }
    if (!item.name) item.name = item.quoteName || `${item.assetType === "etf" ? "ETF" : "基金"} ${item.code}`;
    const index = vault.holdings.findIndex((holding) => holding.id === item.id);
    if (index >= 0) vault.holdings[index] = item;
    else vault.holdings.push(item);
    markLocalUserChange();
    await persistVault();
    holdingDialog.close();
    renderAll();
    saveButton.disabled = false;
    saveButton.textContent = "保存资产";
    showToast(calibratingFund ? `已按${holdingUsesFundNav(item) ? "净值" : "价格"} ${formatQuotePrice(item.fundCalibrationNav, item.currency)} 估算 ${formatNumber(item.quantity)} 份` : (index >= 0 ? "资产已更新" : "资产已添加"));
    if (item.pricingMode === "auto" && !calibratingFund) refreshQuotes({ silent: true });
  }

  async function deleteHolding(id) {
    if (holdingHasTransactionReferences(id)) {
      showToast("该资产已有买卖记录或关联现金，不能直接删除");
      return;
    }
    vault.holdings = vault.holdings.filter((item) => item.id !== id);
    markLocalUserChange();
    await persistVault();
    renderAll();
    showToast("资产已删除");
  }

  function requestConfirmation({ title, message, confirmLabel, action }) {
    pendingConfirmation = action;
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    $("confirm-action").textContent = confirmLabel;
    confirmDialog.returnValue = "";
    confirmDialog.showModal();
  }

  async function exportBackup() {
    await persistVault();
    const encrypted = localStorage.getItem(STORAGE_KEY);
    const backup = {
      format: "allweather-portfolio-vault-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      vault: JSON.parse(encrypted)
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `portfolio-vault-${chinaDate()}.encrypted.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    showToast("加密备份已导出");
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (backup?.format !== "allweather-portfolio-vault-backup" || !backup.vault) throw new Error("备份格式不正确");
      const raw = JSON.stringify(backup.vault);
      const imported = await decryptVault(raw);
      vault = imported;
      markLocalUserChange();
      await persistVault();
      renderAll();
      showToast("加密备份已导入");
    } catch (error) {
      showToast("导入失败：密码或备份不匹配");
    } finally {
      $("import-file").value = "";
    }
  }

  async function unlock(event) {
    event.preventDefault();
    if (!window.isSecureContext || !crypto?.subtle) {
      unlockError.textContent = "当前浏览器环境不支持安全加密";
      return;
    }
    unlockError.textContent = "";
    unlockButton.disabled = true;
    unlockButton.textContent = "验证中";
    try {
      const key = await deriveKey(passwordInput.value);
      if (!(await verifyKey(key))) throw new Error("invalid password");
      sessionKey = key;
      await loadVault();
      passwordInput.value = "";
      lockScreen.hidden = true;
      app.hidden = false;
      resetLockTimer();
      await loadStrategyTarget();
      renderAll();
    } catch (error) {
      sessionKey = null;
      unlockError.textContent = "密码不正确";
      passwordInput.select();
      return;
    } finally {
      unlockButton.disabled = false;
      unlockButton.textContent = "解锁台账";
    }
    await restoreCloudSession();
    if (cloudSession) {
      try { await synchronizeVault({ silent: true }); } catch (error) { /* Local vault remains available offline. */ }
    }
    refreshQuotes({ silent: true });
    startQuoteAutoRefresh();
  }

  async function handleSyncSignIn(event) {
    event.preventDefault();
    const email = $("sync-email").value.trim();
    const password = $("sync-password").value;
    $("sync-auth-error").textContent = "";
    $("sign-in-sync").disabled = true;
    $("create-sync-account").disabled = true;
    try {
      await signInCloud(email, password);
      $("sync-password").value = "";
      await synchronizeVault();
    } catch (error) {
      $("sync-auth-error").textContent = error.message;
      setSyncStatus("error", "登录失败");
    } finally {
      $("sign-in-sync").disabled = false;
      $("create-sync-account").disabled = false;
    }
  }

  async function handleSyncSignUp() {
    const email = $("sync-email").value.trim();
    const password = $("sync-password").value;
    if (!email || password.length < 8) {
      $("sync-auth-error").textContent = "请填写邮箱和至少 8 位的同步账户密码";
      return;
    }
    $("sync-auth-error").textContent = "";
    $("sign-in-sync").disabled = true;
    $("create-sync-account").disabled = true;
    try {
      const signedIn = await signUpCloud(email, password);
      $("sync-password").value = "";
      if (signedIn) {
        await synchronizeVault();
      } else {
        $("sync-auth-error").textContent = "账户已创建，请先到邮箱完成验证，再回来登录同步";
        showToast("验证邮件已发送");
      }
    } catch (error) {
      $("sync-auth-error").textContent = error.message;
    } finally {
      $("sign-in-sync").disabled = false;
      $("create-sync-account").disabled = false;
    }
  }

  async function disconnectCloud() {
    const accessToken = cloudSession?.accessToken;
    try {
      if (accessToken) await cloudRequest("/auth/v1/logout", { method: "POST", accessToken });
    } catch (error) {
      // Clearing the local session is sufficient even if the network is unavailable.
    }
    clearCloudSession();
    $("sync-panel-error").textContent = "";
    showToast("已退出同步账户；本机加密数据仍保留");
  }

  unlockForm.addEventListener("submit", unlock);
  $("toggle-password").addEventListener("click", () => {
    const visible = passwordInput.type === "text";
    passwordInput.type = visible ? "password" : "text";
    $("toggle-password").textContent = visible ? "显示" : "隐藏";
    $("toggle-password").setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
  });
  $("lock-vault").addEventListener("click", lockVault);
  $("toggle-summary-privacy").addEventListener("click", () => {
    summaryValuesVisible = !summaryValuesVisible;
    renderAll();
  });
  $("refresh-quotes").addEventListener("click", () => refreshQuotes());
  $("add-holding").addEventListener("click", () => openHoldingDialog());
  $("record-trade").addEventListener("click", () => openTradeDialog());
  $("open-sync").addEventListener("click", openSyncDialog);
  $("close-sync-dialog").addEventListener("click", () => syncDialog.close());
  $("sync-auth-form").addEventListener("submit", handleSyncSignIn);
  $("create-sync-account").addEventListener("click", handleSyncSignUp);
  $("sync-now").addEventListener("click", async () => {
    $("sync-panel-error").textContent = "";
    $("sync-now").disabled = true;
    try { await synchronizeVault(); } catch (error) { /* Error is rendered by synchronizeVault. */ }
    finally { $("sync-now").disabled = false; }
  });
  $("disconnect-sync").addEventListener("click", disconnectCloud);
  $("export-vault").addEventListener("click", exportBackup);
  $("import-file").addEventListener("change", (event) => importBackup(event.target.files?.[0]));
  $("close-dialog").addEventListener("click", () => holdingDialog.close());
  $("cancel-holding").addEventListener("click", () => holdingDialog.close());
  $("holding-type").addEventListener("change", applyTypeDefaults);
  $("holding-fund-input-mode").addEventListener("change", setFieldVisibility);
  $("holding-fund-seed-amount").addEventListener("input", updateFundCalibrationHint);
  $("holding-code").addEventListener("input", setFieldVisibility);
  $("holding-bucket").addEventListener("change", setFieldVisibility);
  $("holding-currency").addEventListener("change", setFieldVisibility);
  $("holding-intraday-estimate-enabled").addEventListener("change", setFieldVisibility);
  $("holding-pricing-mode").addEventListener("change", setFieldVisibility);
  holdingForm.addEventListener("submit", saveHolding);
  $("close-trade-dialog").addEventListener("click", () => tradeDialog.close());
  $("cancel-trade").addEventListener("click", () => tradeDialog.close());
  $("trade-holding").addEventListener("change", () => updateTradeFormForHolding());
  $("trade-type").addEventListener("change", updateTradePreview);
  $("trade-input-mode").addEventListener("change", updateTradeInputVisibility);
  ["trade-quantity", "trade-amount", "trade-price"].forEach((id) => {
    $(id).addEventListener("input", updateTradePreview);
  });
  tradeForm.addEventListener("submit", saveTrade);

  $("holdings-body").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const groupRow = event.target.closest("tr[data-group-key]");
    const groupKey = button?.dataset.action === "toggle-group" ? button.dataset.groupKey : groupRow?.dataset.groupKey;
    if (groupKey) {
      const key = groupKey;
      if (expandedHoldingGroups.has(key)) expandedHoldingGroups.delete(key);
      else expandedHoldingGroups.add(key);
      renderHoldings(portfolioMetrics());
      return;
    }
    if (!button) return;
    const item = vault.holdings.find((holding) => holding.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.action === "trade") {
      openTradeDialog(item.id);
      return;
    }
    if (button.dataset.action === "edit") openHoldingDialog(item);
    if (button.dataset.action === "delete") {
      requestConfirmation({
        title: "删除这项资产？",
        message: `将从台账中移除“${item.name}”。`,
        confirmLabel: "删除",
        action: () => deleteHolding(item.id)
      });
    }
  });

  $("transactions-body").addEventListener("click", (event) => {
    const button = event.target.closest('button[data-action="undo-trade"]');
    if (!button) return;
    const transaction = vault.transactions.find((item) => item.id === button.dataset.id);
    if (!transaction) return;
    requestConfirmation({
      title: "撤销这笔买卖？",
      message: `将撤销${transaction.type === "sell" ? "卖出" : "买入"} ${formatNumber(transaction.quantity, 4)} 份，并同步恢复持仓和现金。`,
      confirmLabel: "撤销",
      action: () => undoTrade(transaction.id)
    });
  });

  confirmDialog.addEventListener("close", async () => {
    const action = pendingConfirmation;
    pendingConfirmation = null;
    if (confirmDialog.returnValue !== "confirm" || !action) return;
    try {
      await action();
    } catch (error) {
      showToast(`操作失败：${error?.message || "请稍后重试"}`);
    }
  });

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((node) => node.classList.toggle("active", node === button));
      renderHoldings(portfolioMetrics());
    });
  });

  document.querySelectorAll(".group-mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      holdingGroupingMode = button.dataset.groupMode;
      document.querySelectorAll(".group-mode-button").forEach((node) => node.classList.toggle("active", node === button));
      renderHoldings(portfolioMetrics());
    });
  });

  $("record-today").addEventListener("click", () => recordSnapshot({ notify: true }));
  document.querySelectorAll(".history-period-button").forEach((button) => {
    button.addEventListener("click", () => {
      historyPeriod = button.dataset.period;
      document.querySelectorAll(".history-period-button").forEach((node) => {
        node.classList.toggle("active", node === button);
      });
      renderHistory();
    });
  });

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, resetLockTimer, { passive: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && sessionKey && cloudSession) {
      synchronizeVault({ silent: true }).catch(() => {});
    }
  });

  setSyncStatus(syncConfigured() ? "local" : "error", syncConfigured() ? "未登录" : "未配置");
})();
