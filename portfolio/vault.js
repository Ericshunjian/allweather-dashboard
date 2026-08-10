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
    a500: "宽基权益",
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

  let sessionKey = null;
  let vault = null;
  let strategyTarget = null;
  let activeFilter = "all";
  let pendingDeleteId = null;
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

  const $ = (id) => document.getElementById(id);
  const lockScreen = $("lock-screen");
  const app = $("vault-app");
  const unlockForm = $("unlock-form");
  const passwordInput = $("vault-password");
  const unlockButton = $("unlock-button");
  const unlockError = $("unlock-error");
  const holdingDialog = $("holding-dialog");
  const holdingForm = $("holding-form");
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
  }

  function createEmptyVault() {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      holdings: [],
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
    if (syncDialog?.open) syncDialog.close();
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

  function chinaDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
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
      nativeDailyPnl = quantity * (price - previousClose) * multiplier;
    }

    const validFx = Number.isFinite(fx) && fx > 0;
    return {
      nativeValue,
      nativeExposure,
      nativePnl,
      nativeDailyPnl,
      valueCny: item.includeNav && validFx ? nativeValue * fx : 0,
      exposureCny: validFx ? nativeExposure * fx : 0,
      pnlCny: validFx ? nativePnl * fx : 0,
      dailyPnlCny: validFx ? nativeDailyPnl * fx : 0,
      fx,
      validFx,
      derivative
    };
  }

  function portfolioMetrics() {
    const rows = vault.holdings.map((item) => ({ item, calc: calculateHolding(item) }));
    const totalAssets = rows.reduce((sum, row) => sum + row.calc.valueCny, 0);
    const dailyPnl = rows.reduce((sum, row) => sum + row.calc.dailyPnlCny, 0);
    const grossExposure = rows.reduce((sum, row) => sum + Math.abs(row.calc.exposureCny), 0);
    const includedCount = rows.filter((row) => row.item.includeNav).length;
    const derivativeCount = rows.filter((row) => row.calc.derivative).length;
    return { rows, totalAssets, dailyPnl, grossExposure, includedCount, derivativeCount };
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
      if (/^5\d{5}$/.test(code)) return `tencent:sh${code}`;
      if (/^1[568]\d{4}$/.test(code)) return `tencent:sz${code}`;
      if (/^\d{6}$/.test(code)) return `tencent:jj${code}`;
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
    const payload = await response.text();
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

  async function loadStrategyTarget() {
    try {
      const response = await fetch(`strategy-target.json?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      strategyTarget = await response.json();
    } catch (error) {
      strategyTarget = null;
    }
  }

  async function refreshQuotes(options = {}) {
    if (!vault) return;
    const button = $("refresh-quotes");
    button.disabled = true;
    button.textContent = "刷新中";
    let success = 0;
    let attempted = 0;

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
        item.quoteError = "请检查资产类型和代码，或填写行情标识";
        item.resolvedQuoteId = "";
        return;
      }
      try {
        const quote = await fetchQuote(quoteId);
        item.price = quote.price;
        item.previousClose = quote.previousClose;
        item.quoteName = quote.name;
        item.quoteTime = quote.quoteTime;
        item.quoteStatus = quote.quoteLabel || "已更新";
        item.quoteError = "";
        item.resolvedQuoteId = quoteId;
        success += 1;
      } catch (error) {
        item.quoteStatus = "更新失败";
        item.quoteError = error?.message || "行情接口暂不可用";
        item.resolvedQuoteId = quoteId;
      }
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
    const snapshot = {
      date,
      totalAssets: metrics.totalAssets,
      dailyPnl: previousSnapshot ? metrics.totalAssets - numeric(previousSnapshot.totalAssets) : metrics.dailyPnl,
      marketDailyPnl: metrics.dailyPnl,
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

  function renderSummary(metrics) {
    $("total-assets").textContent = formatMoney(metrics.totalAssets);
    $("daily-pnl").textContent = formatMoney(metrics.dailyPnl);
    setSignedClass($("daily-pnl"), metrics.dailyPnl);
    $("gross-exposure").textContent = metrics.totalAssets > 0
      ? `${(metrics.grossExposure / metrics.totalAssets).toFixed(2)}x`
      : "0.00x";
    $("included-count").textContent = `${metrics.includedCount}项计入净资产`;
    $("derivative-count").textContent = `${metrics.derivativeCount}项衍生品`;
    const automatic = vault.holdings.filter((item) => item.pricingMode === "auto");
    const covered = automatic.filter((item) => item.quoteTime && item.quoteStatus !== "更新失败").length;
    $("quote-coverage").textContent = `行情覆盖 ${covered}/${automatic.length}`;
    const latestTimes = vault.holdings.map((item) => item.quoteTime).filter(Boolean).sort();
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
      $("largest-gap").textContent = "待录入";
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
    $("largest-gap").textContent = `${bucketLabels[largest.key]} ${largest.gap >= 0 ? "+" : ""}${formatPercent(largest.gap)}`;
  }

  function appendCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    row.appendChild(cell);
    return cell;
  }

  function renderHoldings(metrics) {
    const body = $("holdings-body");
    body.replaceChildren();
    const visible = metrics.rows.filter(({ item }) => activeFilter === "all" || assetClass(item) === activeFilter);
    $("holdings-empty").hidden = vault.holdings.length > 0;
    $("holdings-table-wrap").hidden = vault.holdings.length === 0;
    visible.forEach(({ item, calc }) => {
      const row = document.createElement("tr");
      const identity = document.createElement("div");
      const name = document.createElement("span");
      name.className = "holding-name";
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "holding-meta";
      meta.textContent = [item.account, item.code, typeLabels[item.assetType]].filter(Boolean).join(" · ");
      identity.append(name, meta);
      appendCell(row, "资产", identity);

      let positionText;
      if (["fixed", "interest"].includes(item.pricingMode)) positionText = formatNative(accruedFixedValue(item), item.currency);
      else positionText = `${formatNumber(item.quantity)} ${calc.derivative ? "手" : "份"}`;
      appendCell(row, "持仓", positionText);
      const latestPrice = ["fixed", "interest"].includes(item.pricingMode)
        ? "--"
        : formatQuotePrice(item.price, item.currency);
      appendCell(row, "最新价", latestPrice);
      appendCell(row, "当前价值", item.includeNav ? formatMoney(calc.valueCny) : "不计入");
      appendCell(row, "风险敞口", formatMoney(calc.exposureCny));
      appendCell(row, "资产权重", metrics.totalAssets > 0 && item.includeNav ? formatPercent(calc.valueCny / metrics.totalAssets) : "--");
      const pnlCell = appendCell(row, "累计盈亏", formatMoney(calc.pnlCny));
      setSignedClass(pnlCell, calc.pnlCny);

      const quote = document.createElement("span");
      const quoteSucceeded = item.quoteTime && item.quoteStatus !== "更新失败";
      quote.className = `quote-status${quoteSucceeded ? " ok" : ""}`;
      quote.textContent = item.pricingMode === "auto" ? (item.quoteStatus || "待刷新") : "本地估值";
      if (item.pricingMode === "auto") {
        const details = [item.resolvedQuoteId, item.quoteError].filter(Boolean).join(" · ");
        if (details) quote.title = details;
      }
      appendCell(row, "行情", quote);

      const actions = document.createElement("div");
      actions.className = "table-actions";
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
      actions.append(edit, remove);
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
        change: previous ? numeric(snapshot.totalAssets) - numeric(previous.totalAssets) : null
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
    const change = numeric(latest.totalAssets) - baseValue;
    return { change, rate: baseValue ? change / baseValue : null };
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
    renderHoldings(metrics);
    renderHistory();
  }

  function setFieldVisibility() {
    const type = $("holding-type").value;
    const pricing = $("holding-pricing-mode").value;
    const derivative = type === "futures" || type === "option";
    document.querySelectorAll(".quantity-field").forEach((node) => { node.hidden = ["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".price-field").forEach((node) => { node.hidden = ["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".fixed-field").forEach((node) => { node.hidden = !["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".interest-field").forEach((node) => { node.hidden = pricing !== "interest"; });
    document.querySelectorAll(".derivative-field").forEach((node) => { node.hidden = !derivative; });
    document.querySelectorAll(".multiplier-field").forEach((node) => { node.hidden = !derivative; });
    document.querySelectorAll(".option-field").forEach((node) => { node.hidden = type !== "option"; });
    $("quote-id-field").hidden = pricing !== "auto";
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
    } else {
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    }
    setFieldVisibility();
  }

  function resetHoldingForm() {
    holdingForm.reset();
    $("holding-id").value = "";
    $("holding-type").value = "stock";
    $("holding-bucket").value = "a500";
    $("holding-currency").value = "CNY";
    $("holding-pricing-mode").value = "auto";
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
      $("holding-code").value = item.code || "";
      $("holding-type").value = item.assetType || "other";
      $("holding-bucket").value = item.strategyBucket || "other";
      $("holding-currency").value = item.currency || "CNY";
      $("holding-pricing-mode").value = item.pricingMode || "manual";
      $("holding-quote-id").value = item.quoteId || "";
      $("holding-quantity").value = item.quantity ?? "";
      $("holding-price").value = item.price ?? "";
      $("holding-entry-price").value = item.entryPrice ?? "";
      $("holding-direction").value = String(item.direction ?? 1);
      $("holding-multiplier").value = item.multiplier ?? 1;
      $("holding-delta").value = item.delta ?? "";
      $("holding-underlying-price").value = item.underlyingPrice ?? "";
      $("holding-fixed-value").value = item.fixedValue ?? "";
      $("holding-annual-rate").value = numeric(item.annualRate) * 100 || "";
      $("holding-valuation-date").value = item.valuationDate || chinaDate();
      $("holding-notes").value = item.notes || "";
      $("holding-include-nav").checked = Boolean(item.includeNav);
      setFieldVisibility();
    }
    holdingDialog.showModal();
    $("holding-name").focus();
  }

  function formItem() {
    const id = $("holding-id").value;
    const existing = vault.holdings.find((item) => item.id === id) || {};
    return {
      ...existing,
      id: id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
      account: $("holding-account").value.trim(),
      name: $("holding-name").value.trim(),
      code: $("holding-code").value.trim().toUpperCase(),
      assetType: $("holding-type").value,
      strategyBucket: $("holding-bucket").value,
      currency: $("holding-currency").value,
      pricingMode: $("holding-pricing-mode").value,
      quoteId: $("holding-quote-id").value.trim(),
      quantity: numeric($("holding-quantity").value),
      price: numeric($("holding-price").value),
      entryPrice: numeric($("holding-entry-price").value),
      direction: numeric($("holding-direction").value, 1),
      multiplier: numeric($("holding-multiplier").value, 1),
      delta: numeric($("holding-delta").value),
      underlyingPrice: numeric($("holding-underlying-price").value),
      fixedValue: numeric($("holding-fixed-value").value),
      annualRate: numeric($("holding-annual-rate").value) / 100,
      valuationDate: $("holding-valuation-date").value,
      notes: $("holding-notes").value.trim(),
      includeNav: $("holding-include-nav").checked,
      updatedAt: new Date().toISOString()
    };
  }

  function validateItem(item) {
    if (!item.name) return "请填写资产名称";
    if (["fixed", "interest"].includes(item.pricingMode)) {
      if (!(item.fixedValue >= 0)) return "请填写当前金额";
    } else {
      if (!(item.quantity > 0)) return "数量、份额或手数必须大于0";
      if (item.pricingMode === "manual" && !(item.price > 0)) return "请填写当前价格";
      if (item.pricingMode === "auto" && !inferQuoteId(item)) return "无法自动识别行情，请填写行情标识";
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
    const index = vault.holdings.findIndex((holding) => holding.id === item.id);
    if (index >= 0) vault.holdings[index] = item;
    else vault.holdings.push(item);
    markLocalUserChange();
    await persistVault();
    holdingDialog.close();
    renderAll();
    showToast(index >= 0 ? "资产已更新" : "资产已添加");
    if (item.pricingMode === "auto") refreshQuotes({ silent: true });
  }

  async function deleteHolding(id) {
    vault.holdings = vault.holdings.filter((item) => item.id !== id);
    markLocalUserChange();
    await persistVault();
    renderAll();
    showToast("资产已删除");
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
  $("refresh-quotes").addEventListener("click", () => refreshQuotes());
  $("add-holding").addEventListener("click", () => openHoldingDialog());
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
  $("holding-pricing-mode").addEventListener("change", setFieldVisibility);
  holdingForm.addEventListener("submit", saveHolding);

  $("holdings-body").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const item = vault.holdings.find((holding) => holding.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.action === "edit") openHoldingDialog(item);
    if (button.dataset.action === "delete") {
      pendingDeleteId = item.id;
      $("confirm-message").textContent = `将从台账中移除“${item.name}”。`;
      confirmDialog.showModal();
    }
  });

  confirmDialog.addEventListener("close", () => {
    if (confirmDialog.returnValue === "confirm" && pendingDeleteId) deleteHolding(pendingDeleteId);
    pendingDeleteId = null;
  });

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((node) => node.classList.toggle("active", node === button));
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
