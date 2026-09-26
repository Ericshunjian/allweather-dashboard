(() => {
  "use strict";

  const productionHost = "ericshunjian.github.io";
  const counterRoot = location.hostname === productionHost
    ? "https://hits.sh/ericshunjian.github.io/allweather-dashboard"
    : "https://hits.sh/allweather-dashboard-preview.local";
  const counterVersion = "site-v1";
  const countedDateStorageKey = `${counterVersion}-homepage-counted-date`;

  function shanghaiDateParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      key: `${values.year}-${values.month}-${values.day}`
    };
  }

  function isoWeekKey(parts) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const isoYear = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(week).padStart(2, "0")}`;
  }

  function incrementUrl(key, label) {
    const params = new URLSearchParams({
      view: "total",
      style: "flat",
      label,
      labelColor: "6b7280",
      color: "374151"
    });
    return `${counterRoot}/${key}.svg?${params}`;
  }

  function readOnlyUrl(key, label) {
    const urn = `${counterRoot.replace("https://hits.sh/", "")}/${key}`;
    const params = new URLSearchParams({
      url: `https://hits.sh/api/urns/${urn}`,
      query: "$.total",
      style: "flat",
      label,
      labelColor: "6b7280",
      color: "374151",
      cacheSeconds: "60"
    });
    return `https://img.shields.io/badge/dynamic/json?${params}`;
  }

  function createCounterImage(key, label) {
    const image = document.createElement("img");
    image.src = readOnlyUrl(key, label);
    image.alt = `${label}访问量`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    return image;
  }

  function markDailyVisit(dateKey) {
    try {
      if (localStorage.getItem(countedDateStorageKey) === dateKey) {
        return false;
      }
      localStorage.setItem(countedDateStorageKey, dateKey);
      return true;
    } catch (_) {
      const sessionKey = `${countedDateStorageKey}-${dateKey}`;
      if (sessionStorage.getItem(sessionKey) === "1") {
        return false;
      }
      sessionStorage.setItem(sessionKey, "1");
      return true;
    }
  }

  function incrementCounter(key, label) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = resolve;
      image.src = incrementUrl(key, label);
    });
  }

  function appendCounter(date) {
    const counter = document.createElement("span");
    counter.className = "site-visitor-stats";
    counter.title = "主页访问量；同一浏览器每天只统计一次";
    counter.append(
      createCounterImage(`${counterVersion}-daily-${date.key}`, "今日"),
      createCounterImage(`${counterVersion}-weekly-${isoWeekKey(date)}`, "本周"),
      createCounterImage(`${counterVersion}-total`, "累计")
    );

    const existingFooter = document.querySelector(".footer");
    if (existingFooter) {
      existingFooter.appendChild(counter);
      return;
    }
    const footer = document.createElement("footer");
    footer.className = "site-visitor-footer";
    footer.appendChild(counter);
    document.body.appendChild(footer);
  }

  async function installCounter() {
    const date = shanghaiDateParts();
    const keys = [
      [`${counterVersion}-daily-${date.key}`, "今日"],
      [`${counterVersion}-weekly-${isoWeekKey(date)}`, "本周"],
      [`${counterVersion}-total`, "累计"]
    ];
    if (markDailyVisit(date.key)) {
      await Promise.all(keys.map(([key, label]) => incrementCounter(key, label)));
    }
    appendCounter(date);
  }

  installCounter();
})();
