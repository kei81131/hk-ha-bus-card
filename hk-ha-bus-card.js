const HK_HA_BUS_CARD_VERSION = "1.2.0";
const KMB_API = "https://data.etabus.gov.hk/v1/transport/kmb";
const GMB_API = "https://data.etagmb.gov.hk";
const CTB_API = "https://rt.data.gov.hk/v2/transport/citybus";
const NLB_API = "https://rt.data.gov.hk/v2/transport/nlb";

const OPERATOR_INFO = {
  kmb: {label: "九巴／龍運", className: "kmb"},
  ctb: {label: "城巴", className: "ctb"},
  gmb: {label: "專線小巴", className: "gmb"},
  nlb: {label: "嶼巴", className: "nlb"}
};

const operatorInfo = (operator) => OPERATOR_INFO[operator] || {
  label: String(operator || "巴士"),
  className: "other"
};

const DEFAULT_CONFIG = {
  type: "custom:hk-ha-bus-card",
  title: "HK HA Bus Card",
  session_key: "hk_ha_bus_card",
  update_interval: 30,
  session_minutes: 15,
  display_window: 30,
  max_routes: 3,
  max_arrivals: 3,
  directions: []
};

// Keep one browser-local query owner per session key. Card instances subscribe
// to it during SPA navigation, while sessionStorage lets the module resume an
// unexpired owner after browsers that reload the Home Assistant frontend.
const HK_HA_BUS_SESSIONS = window.__hkHaBusCardSessions || new Map();
window.__hkHaBusCardSessions = HK_HA_BUS_SESSIONS;

const clone = (value) => JSON.parse(JSON.stringify(value));
const finiteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;"
})[char]);

function normalizeConfig(config = {}) {
  const merged = {
    ...clone(DEFAULT_CONFIG),
    ...clone(config)
  };

  merged.update_interval = Math.max(10, finiteNumber(merged.update_interval, 30));
  merged.session_key = String(merged.session_key || "hk_ha_bus_card");
  merged.session_minutes = Math.max(1, finiteNumber(merged.session_minutes, 15));
  merged.display_window = Math.max(5, finiteNumber(merged.display_window, 30));
  merged.max_routes = Math.max(1, finiteNumber(merged.max_routes, 3));
  merged.max_arrivals = Math.max(1, finiteNumber(merged.max_arrivals, 3));
  merged.directions = Array.isArray(config.directions)
    ? clone(config.directions)
    : clone(DEFAULT_CONFIG.directions);

  merged.directions = merged.directions.map((direction, index) => ({
    id: String(direction.id || `direction_${index + 1}`),
    name: String(direction.name || `方向 ${index + 1}`),
    routes: Array.isArray(direction.routes)
      ? direction.routes.map((route) => ({
          ...route,
          operator: String(route.operator || "kmb").toLowerCase(),
          route: String(route.route || "").toUpperCase(),
          co: route.co == null ? undefined : String(route.co),
          direction: route.direction == null ? undefined : String(route.direction),
          bound: route.bound == null ? undefined : String(route.bound),
          service_type: route.service_type == null ? "1" : String(route.service_type),
          route_id: route.route_id == null ? undefined : Number(route.route_id),
          route_seq: route.route_seq == null ? undefined : Number(route.route_seq),
          stop_seq: route.stop_seq == null ? undefined : Number(route.stop_seq)
        }))
      : []
  }));

  return merged;
}

async function fetchJson(url, {signal, fresh = true} = {}) {
  const target = fresh
    ? `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`
    : url;
  const response = await fetch(target, {
    method: "GET",
    cache: fresh ? "no-store" : "default",
    signal,
    headers: {Accept: "application/json"}
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

class HkHaBusCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this._config = normalizeConfig();
    this._status = "idle";
    this._routeResults = [];
    this._activeDirection = null;
    this._updatedAt = null;
    this._expiresAt = null;
    this._errorCount = 0;
    this._sessionSerial = 0;
    this._refreshTimer = null;
    this._expiryTimer = null;
    this._clockTimer = null;
    this._requestController = null;
    this._connected = false;
    this._sessionKey = this._config.session_key;
    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  static getConfigElement() {
    return document.createElement("hk-ha-bus-card-editor");
  }

  static getStubConfig() {
    return clone(DEFAULT_CONFIG);
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid HK HA Bus Card configuration");
    }
    const normalized = normalizeConfig(config);
    if (this._sessionKey && this._sessionKey !== normalized.session_key) {
      const oldEntry = HK_HA_BUS_SESSIONS.get(this._sessionKey);
      oldEntry?.subscribers.delete(this);
      if (oldEntry?.owner === this) {
        this._invalidateSession();
        oldEntry.owner = null;
      }
    }
    this._config = normalized;
    this._sessionKey = normalized.session_key;
    if (this._connected) {
      const entry = this._sessionEntry();
      entry.subscribers.add(this);
      if (entry.owner && entry.owner !== this) {
        this._adoptSession(entry.owner);
      } else if (!entry.owner) {
        this._restorePersistedSession(entry);
      }
      this._render();
    }
  }

  set hass(value) {
    this._hass = value;
  }

  connectedCallback() {
    this._connected = true;
    document.addEventListener("visibilitychange", this._onVisibilityChange);
    const entry = this._sessionEntry();
    entry.subscribers.add(this);
    if (entry.owner && entry.owner !== this) {
      this._adoptSession(entry.owner);
    } else if (!entry.owner) {
      this._restorePersistedSession(entry);
    }
    this._render();
  }

  disconnectedCallback() {
    this._connected = false;
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this._sessionEntry().subscribers.delete(this);
  }

  getCardSize() {
    return Math.max(3, Math.min(9, 2 + Number(this._config.max_routes || 3) * 2));
  }

  getGridOptions() {
    return {
      columns: "full",
      min_columns: 6,
      rows: 6,
      min_rows: 2
    };
  }

  _invalidateSession() {
    this._sessionSerial += 1;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._expiryTimer) clearTimeout(this._expiryTimer);
    if (this._clockTimer) clearInterval(this._clockTimer);
    this._refreshTimer = null;
    this._expiryTimer = null;
    this._clockTimer = null;
    if (this._requestController) this._requestController.abort();
    this._requestController = null;
  }

  _sessionEntry() {
    const key = this._sessionKey || this._config.session_key || "hk_ha_bus_card";
    if (!HK_HA_BUS_SESSIONS.has(key)) {
      HK_HA_BUS_SESSIONS.set(key, {owner: null, subscribers: new Set()});
    }
    return HK_HA_BUS_SESSIONS.get(key);
  }

  _storageKey(key = this._sessionKey || this._config.session_key) {
    return `hk-ha-bus-card:session:${key || "hk_ha_bus_card"}`;
  }

  _persistSession() {
    const entry = this._sessionEntry();
    if (entry.owner !== this) return;
    try {
      if (this._status === "idle" || !this._activeDirection) {
        window.sessionStorage?.removeItem(this._storageKey());
        return;
      }
      window.sessionStorage?.setItem(this._storageKey(), JSON.stringify({
        version: 1,
        config: this._config,
        status: this._status,
        route_results: this._routeResults,
        active_direction_id: this._activeDirection.id,
        active_direction: this._activeDirection,
        updated_at: this._updatedAt,
        expires_at: this._expiresAt,
        error_count: this._errorCount
      }));
    } catch (error) {
      console.warn("HK HA Bus Card could not persist its browser session", error);
    }
  }

  _restorePersistedSession(entry) {
    try {
      const raw = window.sessionStorage?.getItem(this._storageKey());
      if (!raw) return false;
      const snapshot = JSON.parse(raw);
      const direction = this._config.directions.find(
        (item) => item.id === snapshot.active_direction_id
      ) || snapshot.active_direction;
      if (!direction || !snapshot.expires_at) {
        window.sessionStorage?.removeItem(this._storageKey());
        return false;
      }

      this._activeDirection = direction;
      this._routeResults = Array.isArray(snapshot.route_results)
        ? snapshot.route_results
        : [];
      this._updatedAt = snapshot.updated_at || null;
      this._expiresAt = Number(snapshot.expires_at);
      this._errorCount = Number(snapshot.error_count || 0);
      this._status = Date.now() >= this._expiresAt
        ? "expired"
        : String(snapshot.status || "loading");
      entry.owner = this;
      entry.subscribers.add(this);

      if (this._status === "expired") {
        this._routeResults = [];
        this._persistSession();
        return true;
      }

      this._sessionSerial += 1;
      const sessionId = this._sessionSerial;
      this._expiryTimer = setTimeout(
        () => this._expireSession(sessionId),
        Math.max(0, this._expiresAt - Date.now())
      );
      this._clockTimer = setInterval(() => {
        if (sessionId === this._sessionSerial) this._render();
      }, 15000);
      const staleFor = this._updatedAt ? Date.now() - this._updatedAt : Infinity;
      const nextDelay = Math.max(0, this._config.update_interval * 1000 - staleFor);
      this._refreshTimer = setTimeout(() => this._refresh(sessionId), nextDelay);
      return true;
    } catch (error) {
      console.warn("HK HA Bus Card could not restore its browser session", error);
      try { window.sessionStorage?.removeItem(this._storageKey()); } catch (_) {}
      return false;
    }
  }

  _adoptSession(owner) {
    this._status = owner._status;
    this._routeResults = clone(owner._routeResults || []);
    this._activeDirection = this._config.directions.find(
      (direction) => direction.id === owner._activeDirection?.id
    ) || (owner._activeDirection ? clone(owner._activeDirection) : null);
    this._updatedAt = owner._updatedAt;
    this._expiresAt = owner._expiresAt;
    this._errorCount = owner._errorCount;
  }

  async _startDirection(directionId) {
    const direction = this._config.directions.find((item) => item.id === directionId);
    if (!direction) return;

    const entry = this._sessionEntry();
    if (entry.owner && entry.owner !== this) {
      entry.owner._invalidateSession();
    }
    entry.owner = this;
    entry.subscribers.add(this);
    this._invalidateSession();
    const sessionId = this._sessionSerial;
    this._activeDirection = direction;
    this._routeResults = [];
    this._updatedAt = null;
    this._errorCount = 0;
    this._status = "loading";
    this._expiresAt = Date.now() + this._config.session_minutes * 60 * 1000;
    this._render();

    this._expiryTimer = setTimeout(
      () => this._expireSession(sessionId),
      Math.max(0, this._expiresAt - Date.now())
    );
    this._clockTimer = setInterval(() => {
      if (sessionId === this._sessionSerial && this._connected) this._render();
    }, 15000);

    await this._refresh(sessionId);
  }

  _expireSession(sessionId) {
    if (sessionId !== this._sessionSerial) return;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._clockTimer) clearInterval(this._clockTimer);
    this._refreshTimer = null;
    this._clockTimer = null;
    if (this._requestController) this._requestController.abort();
    this._requestController = null;
    this._status = "expired";
    this._routeResults = [];
    this._render();
  }

  async _refresh(sessionId) {
    if (
      sessionId !== this._sessionSerial ||
      !this._activeDirection ||
      Date.now() >= this._expiresAt
    ) {
      if (Date.now() >= this._expiresAt) this._expireSession(sessionId);
      return;
    }

    if (this._requestController) this._requestController.abort();
    this._requestController = new AbortController();
    const signal = this._requestController.signal;
    const routes = this._activeDirection.routes || [];

    if (!routes.length) {
      this._status = "error";
      this._errorCount = 0;
      this._routeResults = [];
      this._updatedAt = Date.now();
      this._render();
      return;
    }

    const settled = await Promise.allSettled(
      routes.map((route) => this._fetchRoute(route, signal))
    );

    if (sessionId !== this._sessionSerial || signal.aborted) return;

    this._routeResults = settled.map((result, index) => {
      const configured = routes[index];
      if (result.status === "fulfilled") return result.value;
      return {
        route: configured.route,
        operator: configured.operator,
        stop_id: configured.stop_id,
        destination: configured.destination || "",
        stop_name: configured.stop_name || "",
        status: "error",
        error_message: String(result.reason?.message || result.reason || "查詢失敗"),
        arrivals: []
      };
    });

    this._errorCount = this._routeResults.filter((route) => route.status === "error").length;
    this._status = this._errorCount === this._routeResults.length
      ? "error"
      : (this._errorCount > 0 ? "degraded" : "active");
    this._updatedAt = Date.now();
    this._render();

    if (Date.now() < this._expiresAt) {
      this._refreshTimer = setTimeout(
        () => this._refresh(sessionId),
        this._config.update_interval * 1000
      );
    } else {
      this._expireSession(sessionId);
    }
  }

  async _fetchRoute(route, signal) {
    if (route.operator === "ctb") {
      if (!route.stop_id || !route.route) {
        throw new Error(`城巴 ${route.route}: 缺少 stop_id`);
      }
      const co = String(route.co || "CTB");
      const payload = await fetchJson(
        `${CTB_API}/eta/${co}/${route.stop_id}/${route.route}`,
        {signal}
      );
      let source = Array.isArray(payload?.data) ? payload.data : null;
      if (!source) throw new Error("Invalid Citybus response");
      source = source.filter((item) => {
        if (route.bound && item.dir && String(item.dir) !== String(route.bound)) return false;
        if (route.stop_seq && item.seq && Number(item.seq) !== Number(route.stop_seq)) return false;
        return true;
      });
      return {
        route: route.route,
        operator: "ctb",
        stop_id: route.stop_id,
        destination: route.destination || source[0]?.dest_tc || "",
        stop_name: route.stop_name || "",
        status: source.length ? "ok" : "no_service",
        error_message: "",
        arrivals: source.map((item) => ({
          eta: item.eta,
          remark: String(item.rmk_tc || "")
        }))
      };
    }

    if (route.operator === "gmb") {
      if (!route.route_id || !route.route_seq || !route.stop_seq) {
        throw new Error(`小巴 ${route.route}: 缺少 route_id / route_seq / stop_seq`);
      }
      const payload = await fetchJson(
        `${GMB_API}/eta/route-stop/${route.route_id}/${route.route_seq}/${route.stop_seq}`,
        {signal}
      );
      const source = payload?.data?.eta;
      if (!Array.isArray(source)) throw new Error("Invalid GMB response");
      return {
        route: route.route,
        operator: "gmb",
        stop_id: route.stop_id,
        destination: route.destination || "",
        stop_name: route.stop_name || "",
        status: source.length ? "ok" : "no_service",
        error_message: "",
        arrivals: source.map((item) => ({
          eta: item.timestamp,
          remark: String(item.remarks_tc || "")
        }))
      };
    }

    if (route.operator === "nlb") {
      if (!route.route_id || !route.stop_id) {
        throw new Error(`嶼巴 ${route.route}: 缺少 route_id / stop_id`);
      }
      const payload = await fetchJson(
        `${NLB_API}/stop.php?action=estimatedArrivals&routeId=${encodeURIComponent(route.route_id)}&stopId=${encodeURIComponent(route.stop_id)}&language=zh`,
        {signal}
      );
      const source = payload?.estimatedArrivals;
      if (!Array.isArray(source)) throw new Error("Invalid NLB response");
      return {
        route: route.route,
        operator: "nlb",
        stop_id: route.stop_id,
        destination: route.destination || "",
        stop_name: route.stop_name || "",
        status: source.length ? "ok" : "no_service",
        error_message: "",
        arrivals: source.map((item) => {
          const rawEta = String(item.estimatedArrivalTime || "");
          const eta = rawEta && !rawEta.includes("T")
            ? `${rawEta.replace(" ", "T")}+08:00`
            : rawEta;
          const remarks = [
            item.routeVariantName,
            String(item.noGPS) === "1" ? "預定班次" : "",
            String(item.departed) === "1" ? "已開出" : ""
          ].filter(Boolean);
          return {eta, remark: remarks.join(" · ")};
        })
      };
    }

    if (!route.stop_id || !route.route) {
      throw new Error(`九巴 ${route.route}: 缺少 stop_id`);
    }
    const serviceType = String(route.service_type || "1");
    const payload = await fetchJson(
      `${KMB_API}/eta/${route.stop_id}/${route.route}/${serviceType}`,
      {signal}
    );
    let source = Array.isArray(payload?.data) ? payload.data : null;
    if (!source) throw new Error("Invalid KMB response");
    source = source.filter((item) => {
      if (route.bound && item.dir && String(item.dir) !== String(route.bound)) return false;
      if (item.service_type != null && String(item.service_type) !== serviceType) return false;
      return true;
    });
    return {
      route: route.route,
      operator: "kmb",
      stop_id: route.stop_id,
      destination: route.destination || source[0]?.dest_tc || "",
      stop_name: route.stop_name || "",
      status: source.length ? "ok" : "no_service",
      error_message: "",
      arrivals: source.map((item) => ({
        eta: item.eta,
        remark: String(item.rmk_tc || "")
      }))
    };
  }

  _handleVisibilityChange() {
    const owner = this._sessionEntry().owner;
    if (owner && owner !== this) {
      owner._handleVisibilityChange();
      return;
    }
    if (document.visibilityState !== "visible" || !this._activeDirection) return;
    if (Date.now() >= this._expiresAt) {
      this._expireSession(this._sessionSerial);
      return;
    }
    const staleFor = this._updatedAt ? Date.now() - this._updatedAt : Infinity;
    if (staleFor >= this._config.update_interval * 1000) {
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
      this._refresh(this._sessionSerial);
    }
  }

  _displayRoutes() {
    const now = Date.now();
    return this._routeResults
      .map((route, index) => {
        const arrivals = (Array.isArray(route.arrivals) ? route.arrivals : [])
          .map((arrival) => {
            const etaMs = new Date(arrival.eta).getTime();
            return {
              ...arrival,
              eta_ms: etaMs,
              minutes: Math.ceil((etaMs - now) / 60000)
            };
          })
          .filter((arrival) =>
            Number.isFinite(arrival.eta_ms) &&
            arrival.eta_ms >= now - 60000 &&
            arrival.minutes >= 0 &&
            arrival.minutes <= this._config.display_window
          )
          .sort((a, b) => a.eta_ms - b.eta_ms)
          .slice(0, this._config.max_arrivals);
        return {
          ...route,
          arrivals,
          _index: index,
          _first: arrivals.length ? arrivals[0].eta_ms : Number.POSITIVE_INFINITY
        };
      })
      .filter((route) => route.arrivals.length > 0)
      .sort((a, b) => (a._first - b._first) || (a._index - b._index))
      .slice(0, this._config.max_routes);
  }

  _statusText() {
    if (!this._config.directions.length) return "尚未設定方向及路線";
    if (this._status === "idle") return "按方向掣後才會查詢";
    if (this._status === "loading") return "正在查詢巴士到站時間…";
    if (this._status === "expired") return "資料已過期，請重新選擇方向";
    if (this._status === "error") return "全部路線查詢失敗，系統稍後仍會重試";

    const remaining = Math.max(0, Math.ceil((this._expiresAt - Date.now()) / 60000));
    const updated = this._updatedAt
      ? new Date(this._updatedAt).toLocaleTimeString("zh-HK", {hour: "2-digit", minute: "2-digit"})
      : "--:--";
    const prefix = this._status === "degraded"
      ? `部分更新失敗 (${this._errorCount})`
      : "即時更新中";
    return `${prefix} · 尚餘約 ${remaining} 分鐘 · ${updated}`;
  }

  _directionSubtitle(direction) {
    const stops = [...new Set(
      (direction.routes || []).map((route) => String(route.stop_name || "").trim()).filter(Boolean)
    )];
    if (!stops.length) return "尚未加入路線及車站";
    if (stops.length === 1) return stops[0];
    return `${stops.length} 個已選車站`;
  }

  _routeStopName(routeResult) {
    if (routeResult.stop_name) return routeResult.stop_name;
    const configured = (this._activeDirection?.routes || []).find((route) =>
      route.operator === routeResult.operator &&
      route.route === routeResult.route &&
      (!routeResult.stop_id || String(route.stop_id) === String(routeResult.stop_id))
    );
    return configured?.stop_name || "未命名車站";
  }

  _message(icon, title, detail) {
    return `<div class="message">
      <div class="message-icon">${icon}</div>
      <div class="message-title">${escapeHtml(title)}</div>
      <div class="message-detail">${escapeHtml(detail)}</div>
    </div>`;
  }

  _renderRows(routes) {
    if (!routes.length) {
      return this._message(
        "🕒",
        `未來 ${this._config.display_window} 分鐘暫無班次`,
        `只顯示最快到達的 ${this._config.max_routes} 條路線`
      );
    }

    const allMinutes = routes.flatMap((route) => route.arrivals.map((arrival) => arrival.minutes));
    const maxMinutes = allMinutes.length ? Math.max(...allMinutes) : 0;
    const horizon = Math.max(15, Math.ceil((maxMinutes + 1) / 5) * 5);
    const viewportWidth = this.clientWidth || 390;
    const collisionGap = viewportWidth <= 500 ? 26 : (viewportWidth <= 900 ? 16 : 11);
    const laneHeight = 42;

    return routes.map((route) => {
      const lanes = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      const positioned = route.arrivals.map((arrival) => {
        const rawPosition = (arrival.minutes / horizon) * 100;
        const position = Math.max(2, Math.min(98, rawPosition));
        let lane = lanes.findIndex((last) => position - last >= collisionGap);
        if (lane === -1) lane = lanes.indexOf(Math.min(...lanes));
        lanes[lane] = position;
        return {...arrival, position, lane};
      });
      const maxLane = Math.max(0, ...positioned.map((arrival) => arrival.lane));
      const points = positioned.map((arrival) => {
        const urgent = arrival.minutes <= 3;
        const label = arrival.minutes <= 1 ? "即將抵達" : `${arrival.minutes} 分鐘`;
        return `<div class="point ${urgent ? "urgent" : ""}" style="left:${arrival.position.toFixed(2)}%;--lane:${arrival.lane}">
          <span class="dot"></span>
          <div class="minutes">${escapeHtml(label)}</div>
          <div class="remark">${escapeHtml(arrival.remark || "")}</div>
        </div>`;
      }).join("");
      const operator = operatorInfo(route.operator);

      return `<section class="route-row">
        <div class="route-head">
          <div class="route-wrap">
            <div class="route-badge ${operator.className}">${escapeHtml(route.route)}</div>
            <div class="operator">${escapeHtml(operator.label)}</div>
          </div>
          <div class="direction"><span>➜</span>${escapeHtml(this._activeDirection?.name || "")}</div>
          <div class="stop">📍 ${escapeHtml(this._routeStopName(route))}</div>
        </div>
        <div class="timeline" style="min-height:${57 + maxLane * laneHeight}px">
          <div class="now">現在</div>
          <div class="line"></div>
          <div class="points">${points}</div>
        </div>
      </section>`;
    }).join("");
  }

  _renderBody() {
    if (!this._config.directions.length) {
      return this._message("⚙️", "尚未設定路線", "請開啟 Card Editor 新增方向、路線及巴士站");
    }
    if (this._status === "loading") {
      return Array.from({length: Math.min(3, Math.max(1, this._activeDirection?.routes?.length || 3))})
        .map(() => `<div class="skeleton"><div class="shimmer sk-head"></div><div class="shimmer sk-line"></div></div>`)
        .join("");
    }
    if (this._status === "idle") {
      return this._message("🚌", "準備查詢", "撳上面其中一個方向按鈕先會查詢到站時間");
    }
    if (this._status === "expired") {
      return this._message("⏱️", "資料已過期", "為免顯示過時資料，請重新選擇方向");
    }
    if (this._status === "error" && !this._routeResults.some((route) => route.status !== "error")) {
      return this._message("⚠️", "未能取得到站資料", "請檢查網絡或稍後再試");
    }
    return this._renderRows(this._displayRoutes());
  }

  _render(broadcast = true) {
    if (!this.shadowRoot) return;
    if (broadcast) {
      const entry = this._sessionEntry();
      if (entry.owner === this) {
        this._persistSession();
        entry.subscribers.forEach((subscriber) => {
          if (subscriber !== this && subscriber._connected) {
            subscriber._adoptSession(this);
            subscriber._render(false);
          }
        });
      }
    }
    const directions = this._config.directions || [];
    const buttons = directions.map((direction) => {
      const active = this._activeDirection?.id === direction.id && this._status !== "idle";
      return `<button class="direction-button ${active ? "active" : ""}" data-direction="${escapeHtml(direction.id)}">
        <span class="button-icon">🚌</span>
        <span class="button-copy"><strong>${escapeHtml(direction.name)}</strong><small>${escapeHtml(this._directionSubtitle(direction))}</small></span>
      </button>`;
    }).join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; color:var(--primary-text-color); }
        ha-card { overflow:hidden; border-radius:20px; background:var(--card-background-color); }
        .header { padding:16px 16px 12px; }
        .title { margin-bottom:12px; font-size:18px; font-weight:800; }
        .direction-buttons { display:grid; grid-template-columns:repeat(${Math.max(1, directions.length)},minmax(0,1fr)); gap:10px; }
        .direction-button { appearance:none; display:flex; align-items:center; gap:10px; min-width:0; padding:13px 12px; border:1px solid var(--divider-color); border-radius:14px; color:var(--primary-text-color); background:color-mix(in srgb,var(--card-background-color) 90%,var(--primary-color)); cursor:pointer; text-align:left; transition:.18s ease; }
        .direction-button:hover { border-color:var(--primary-color); transform:translateY(-1px); }
        .direction-button.active { border-color:var(--primary-color); background:color-mix(in srgb,var(--primary-color) 14%,var(--card-background-color)); box-shadow:0 0 0 1px color-mix(in srgb,var(--primary-color) 55%,transparent); }
        .button-icon { flex:0 0 auto; font-size:24px; }
        .button-copy { min-width:0; display:flex; flex-direction:column; gap:2px; }
        .button-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15px; }
        .button-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--secondary-text-color); font-size:11px; }
        .status { padding:9px 16px; border-top:1px solid var(--divider-color); border-bottom:1px solid var(--divider-color); color:var(--secondary-text-color); background:color-mix(in srgb,var(--card-background-color) 94%,var(--primary-text-color)); font-size:11px; text-align:center; }
        .route-row { padding:15px 14px 18px; }
        .route-row + .route-row { border-top:1px solid var(--divider-color); }
        .route-head { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:10px; }
        .route-wrap { display:flex; align-items:center; gap:6px; }
        .route-badge { min-width:48px; box-sizing:border-box; padding:7px 9px; border-radius:7px; color:#fff; text-align:center; font-size:20px; font-weight:800; line-height:1; }
        .route-badge.kmb { background:#cf2027; }
        .route-badge.ctb { color:#102a43; background:#f4c400; }
        .route-badge.gmb { background:#168f48; }
        .route-badge.nlb { background:#1473b9; }
        .route-badge.other { background:#667085; }
        .operator { color:var(--secondary-text-color); font-size:10px; white-space:nowrap; }
        .direction { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:15px; font-weight:700; }
        .direction span { margin-right:5px; color:var(--success-color,#2e9d62); }
        .stop { color:var(--primary-color); font-size:12px; font-weight:600; white-space:nowrap; }
        .timeline { position:relative; margin-top:24px; padding:0 8px 0 48px; min-height:57px; }
        .now { position:absolute; z-index:2; left:0; top:-6px; color:var(--success-color,#2e9d62); font-size:12px; font-weight:700; }
        .line { position:absolute; left:46px; right:8px; top:1px; height:3px; border-radius:2px; background:color-mix(in srgb,var(--primary-text-color) 72%,transparent); }
        .points { position:absolute; z-index:2; left:46px; right:8px; top:0; height:100%; }
        .point { position:absolute; top:0; width:86px; transform:translateX(-50%); padding-top:calc(18px + (var(--lane,0) * 42px)); text-align:center; }
        .point::after { content:""; position:absolute; z-index:0; left:50%; top:10px; width:1px; height:calc(var(--lane,0) * 42px); transform:translateX(-50%); background:color-mix(in srgb,var(--primary-color) 35%,transparent); }
        .dot { position:absolute; z-index:3; top:-8px; left:50%; width:16px; height:16px; box-sizing:content-box; transform:translateX(-50%); border:3px solid var(--card-background-color); border-radius:50%; background:var(--primary-color); box-shadow:0 0 0 2px color-mix(in srgb,var(--primary-color) 55%,var(--primary-text-color)); }
        .point.urgent .dot { background:var(--error-color,#db4437); box-shadow:0 0 0 2px color-mix(in srgb,var(--error-color,#db4437) 65%,var(--primary-text-color)); }
        .minutes { position:relative; z-index:2; color:var(--primary-text-color); font-size:16px; font-weight:800; line-height:1.15; white-space:nowrap; }
        .point.urgent .minutes { color:var(--error-color,#db4437); }
        .remark { position:relative; z-index:2; min-height:14px; margin-top:3px; color:var(--warning-color,#d99200); font-size:10px; line-height:1.15; overflow-wrap:anywhere; }
        .message { padding:36px 18px 40px; text-align:center; }
        .message-icon { font-size:36px; line-height:1; }
        .message-title { margin-top:10px; font-size:17px; font-weight:800; }
        .message-detail { margin-top:5px; color:var(--secondary-text-color); font-size:12px; }
        .skeleton { padding:15px 14px 18px; }
        .skeleton + .skeleton { border-top:1px solid var(--divider-color); }
        .shimmer { border-radius:8px; background:linear-gradient(90deg,color-mix(in srgb,var(--secondary-text-color) 10%,transparent),color-mix(in srgb,var(--secondary-text-color) 24%,transparent),color-mix(in srgb,var(--secondary-text-color) 10%,transparent)); background-size:220% 100%; animation:shimmer 1.4s infinite linear; }
        .sk-head { width:62%; height:25px; }
        .sk-line { width:100%; height:5px; margin-top:27px; }
        @keyframes shimmer { from { background-position:200% 0; } to { background-position:-20% 0; } }
        @media(max-width:500px) { .header{padding:13px 12px 10px}.direction-buttons{gap:8px}.direction-button{padding:11px 9px}.button-icon{font-size:20px}.route-row{padding-left:10px;padding-right:10px}.route-badge{min-width:43px;font-size:18px}.route-head{gap:7px}.direction{font-size:13px}.stop{font-size:10px}.timeline{padding-left:43px}.line,.points{left:41px}.point{width:74px}.minutes{font-size:14px} }
      </style>
      <ha-card>
        <div class="header">
          <div class="title">${escapeHtml(this._config.title)}</div>
          <div class="direction-buttons">${buttons || "未設定方向"}</div>
        </div>
        <div class="status">${escapeHtml(this._statusText())}</div>
        <div class="board">${this._renderBody()}</div>
      </ha-card>`;

    this.shadowRoot.querySelectorAll("[data-direction]").forEach((button) => {
      button.addEventListener("click", () => this._startDirection(button.dataset.direction));
    });
  }
}

let kmbStopsPromise;
let nlbRoutesPromise;
const citybusStopPromises = new Map();

async function getKmbStops() {
  if (!kmbStopsPromise) {
    kmbStopsPromise = fetchJson(`${KMB_API}/stop`, {fresh: false})
      .then((payload) => {
        const data = Array.isArray(payload?.data) ? payload.data : [];
        return new Map(data.map((stop) => [String(stop.stop), stop]));
      });
  }
  return kmbStopsPromise;
}

async function getNlbRoutes() {
  if (!nlbRoutesPromise) {
    nlbRoutesPromise = fetchJson(`${NLB_API}/route.php?action=list`, {fresh: false})
      .then((payload) => Array.isArray(payload?.routes) ? payload.routes : []);
  }
  return nlbRoutesPromise;
}

async function getCitybusStop(stopId) {
  const key = String(stopId);
  if (!citybusStopPromises.has(key)) {
    citybusStopPromises.set(key, fetchJson(`${CTB_API}/stop/${key}`, {fresh: false})
      .then((payload) => payload?.data || {})
      .catch((error) => {
        citybusStopPromises.delete(key);
        throw error;
      }));
  }
  return citybusStopPromises.get(key);
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function splitRouteName(name) {
  const parts = String(name || "").split(/\s*>\s*/);
  return {
    origin: parts.shift()?.trim() || "",
    destination: parts.join(" > ").trim()
  };
}

async function searchKmbVariants(routeCode) {
  const candidates = ["outbound", "inbound"].flatMap((direction) =>
    ["1", "2", "3"].map((serviceType) => ({direction, serviceType}))
  );
  const responses = await Promise.allSettled(candidates.map(async (candidate) => {
    const payload = await fetchJson(
      `${KMB_API}/route/${encodeURIComponent(routeCode)}/${candidate.direction}/${candidate.serviceType}`,
      {fresh: false}
    );
    const route = payload?.data;
    if (!route || String(route.route).toUpperCase() !== routeCode) return null;
    return {
      operator: "kmb",
      route: routeCode,
      bound: route.bound,
      service_type: String(route.service_type),
      origin: route.orig_tc,
      destination: route.dest_tc,
      label: `${route.orig_tc} ➜ ${route.dest_tc}${String(route.service_type) !== "1" ? ` · 班次 ${route.service_type}` : ""}`
    };
  }));
  return responses
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

async function searchCitybusVariants(routeCode) {
  const payload = await fetchJson(`${CTB_API}/route/CTB/${encodeURIComponent(routeCode)}`, {fresh: false});
  const route = payload?.data;
  if (!route || String(route.route).toUpperCase() !== routeCode) return [];
  const candidates = [
    {direction: "outbound", bound: "O", origin: route.orig_tc, destination: route.dest_tc},
    {direction: "inbound", bound: "I", origin: route.dest_tc, destination: route.orig_tc}
  ];
  const availability = await Promise.allSettled(candidates.map(async (candidate) => {
    const stopsPayload = await fetchJson(
      `${CTB_API}/route-stop/CTB/${encodeURIComponent(routeCode)}/${candidate.direction}`,
      {fresh: false}
    );
    const routeStops = Array.isArray(stopsPayload?.data) ? stopsPayload.data : [];
    if (!routeStops.length) return null;
    return {
      operator: "ctb",
      co: "CTB",
      route: routeCode,
      ...candidate,
      _route_stops: routeStops,
      label: `${candidate.origin} ➜ ${candidate.destination}`
    };
  }));
  return availability
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
}

async function searchGmbVariants(routeCode) {
  const regions = ["HKI", "KLN", "NT"];
  const responses = await Promise.allSettled(regions.map(async (region) => {
    const payload = await fetchJson(`${GMB_API}/route/${region}/${encodeURIComponent(routeCode)}`, {fresh: false});
    const records = Array.isArray(payload?.data) ? payload.data : [];
    return records.flatMap((record) => (record.directions || []).map((direction) => ({
      operator: "gmb",
      region: record.region || region,
      route: routeCode,
      route_id: Number(record.route_id),
      route_seq: Number(direction.route_seq),
      origin: direction.orig_tc,
      destination: direction.dest_tc,
      description: record.description_tc || "",
      label: `${direction.orig_tc} ➜ ${direction.dest_tc}${record.description_tc ? ` · ${record.description_tc}` : ""}`
    })));
  }));
  return responses
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);
}

async function searchNlbVariants(routeCode) {
  const allRoutes = await getNlbRoutes();
  return allRoutes
    .filter((route) => String(route.routeNo).toUpperCase() === routeCode)
    .map((route) => {
      const names = splitRouteName(route.routeName_c);
      return {
        operator: "nlb",
        route: routeCode,
        route_id: Number(route.routeId),
        origin: names.origin,
        destination: names.destination,
        description: Number(route.specialRoute) ? "特別班次" : "",
        label: `${names.origin} ➜ ${names.destination}${Number(route.specialRoute) ? " · 特別班次" : ""}`
      };
    });
}

async function searchAllRouteVariants(routeCode) {
  const withTimeout = (promise, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 搜尋逾時`)), 15000);
      })
    ]).finally(() => clearTimeout(timer));
  };
  const searches = await Promise.allSettled([
    withTimeout(searchKmbVariants(routeCode), "九巴／龍運"),
    withTimeout(searchCitybusVariants(routeCode), "城巴"),
    withTimeout(searchGmbVariants(routeCode), "專線小巴"),
    withTimeout(searchNlbVariants(routeCode), "嶼巴")
  ]);
  const seen = new Set();
  return searches
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
    .filter((variant) => {
      const key = [
        variant.operator,
        variant.route_id || "",
        variant.region || "",
        variant.bound || "",
        variant.service_type || "",
        variant.route_seq || "",
        variant.origin || "",
        variant.destination || ""
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

class HkHaBusCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"});
    this._config = normalizeConfig();
    this._drafts = new Map();
  }

  set hass(value) {
    this._hass = value;
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._drafts.clear();
    this._render();
  }

  _draft(index) {
    if (!this._drafts.has(index)) {
      this._drafts.set(index, {
        route: "",
        variants: [],
        operatorFilter: "",
        variantIndex: "",
        stops: [],
        stopIndex: "",
        loading: false,
        error: ""
      });
    }
    return this._drafts.get(index);
  }

  _fireChanged() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: {config: clone(this._config)},
      bubbles: true,
      composed: true
    }));
  }

  async _loadVariants(index) {
    const draft = this._draft(index);
    draft.loading = true;
    draft.error = "";
    draft.variants = [];
    draft.operatorFilter = "";
    draft.stops = [];
    draft.variantIndex = "";
    draft.stopIndex = "";
    this._render();

    try {
      const routeCode = String(draft.route || "").trim().toUpperCase();
      if (!routeCode) throw new Error("請輸入路線號碼");
      draft.route = routeCode;
      draft.variants = await searchAllRouteVariants(routeCode);
      if (!draft.variants.length) throw new Error("所有營辦商均找不到此路線");

      const operators = [...new Set(draft.variants.map((variant) => variant.operator))];
      if (operators.length === 1) {
        draft.operatorFilter = operators[0];
        draft.variantIndex = String(draft.variants.findIndex(
          (variant) => variant.operator === draft.operatorFilter
        ));
        await this._loadStops(index, false);
      }
    } catch (error) {
      draft.error = String(error.message || error);
    } finally {
      draft.loading = false;
      this._render();
    }
  }

  async _loadStops(index, rerender = true) {
    const draft = this._draft(index);
    const variant = draft.variants[Number(draft.variantIndex)];
    if (!variant) return;
    draft.loading = true;
    draft.error = "";
    draft.stops = [];
    draft.stopIndex = "";
    if (rerender) this._render();

    try {
      if (variant.operator === "kmb") {
        const directionPath = variant.bound === "O" ? "outbound" : "inbound";
        const [routeStopsPayload, stopMap] = await Promise.all([
          fetchJson(`${KMB_API}/route-stop/${variant.route}/${directionPath}/${variant.service_type}`, {fresh: false}),
          getKmbStops()
        ]);
        const routeStops = Array.isArray(routeStopsPayload?.data) ? routeStopsPayload.data : [];
        draft.stops = routeStops.map((routeStop) => {
          const stop = stopMap.get(String(routeStop.stop)) || {};
          return {
            stop_id: String(routeStop.stop),
            stop_seq: Number(routeStop.seq),
            name: stop.name_tc || routeStop.stop,
            lat: stop.lat,
            long: stop.long,
            label: `${routeStop.seq}. ${stop.name_tc || routeStop.stop}`
          };
        });
      } else if (variant.operator === "ctb") {
        const routeStops = Array.isArray(variant._route_stops)
          ? variant._route_stops
          : (await fetchJson(
              `${CTB_API}/route-stop/${variant.co || "CTB"}/${variant.route}/${variant.direction}`,
              {fresh: false}
            ))?.data;
        draft.stops = await mapWithConcurrency(
          Array.isArray(routeStops) ? routeStops : [],
          8,
          async (routeStop) => {
            const stop = await getCitybusStop(routeStop.stop).catch(() => ({}));
            return {
              stop_id: String(routeStop.stop),
              stop_seq: Number(routeStop.seq),
              name: stop.name_tc || routeStop.stop,
              lat: stop.lat,
              long: stop.long,
              label: `${routeStop.seq}. ${stop.name_tc || routeStop.stop}`
            };
          }
        );
      } else if (variant.operator === "gmb") {
        const payload = await fetchJson(`${GMB_API}/route-stop/${variant.route_id}/${variant.route_seq}`, {fresh: false});
        const routeStops = payload?.data?.route_stops;
        draft.stops = (Array.isArray(routeStops) ? routeStops : []).map((stop) => ({
          stop_id: Number(stop.stop_id),
          stop_seq: Number(stop.stop_seq),
          name: stop.name_tc,
          label: `${stop.stop_seq}. ${stop.name_tc}`
        }));
      } else if (variant.operator === "nlb") {
        const payload = await fetchJson(
          `${NLB_API}/stop.php?action=list&routeId=${encodeURIComponent(variant.route_id)}`,
          {fresh: false}
        );
        draft.stops = (Array.isArray(payload?.stops) ? payload.stops : []).map((stop, stopIndex) => ({
          stop_id: String(stop.stopId),
          stop_seq: stopIndex + 1,
          name: stop.stopName_c || stop.stopName_e || stop.stopId,
          lat: stop.latitude,
          long: stop.longitude,
          label: `${stopIndex + 1}. ${stop.stopName_c || stop.stopName_e || stop.stopId}`
        }));
      }
      if (!draft.stops.length) throw new Error("找不到巴士站");
      draft.stopIndex = "0";
    } catch (error) {
      draft.error = String(error.message || error);
    } finally {
      draft.loading = false;
      if (rerender) this._render();
    }
  }

  _addRoute(index) {
    const draft = this._draft(index);
    const variant = draft.variants[Number(draft.variantIndex)];
    const stop = draft.stops[Number(draft.stopIndex)];
    if (!variant || !stop) {
      draft.error = "請先選擇方向及巴士站";
      this._render();
      return;
    }

    const {label, _route_stops, ...routeVariant} = variant;
    const route = {
      ...routeVariant,
      stop_id: stop.stop_id,
      stop_seq: stop.stop_seq,
      stop_name: stop.name
    };

    this._config.directions[index].routes.push(route);
    this._drafts.set(index, {
      route: "",
      variants: [],
      operatorFilter: "",
      variantIndex: "",
      stops: [],
      stopIndex: "",
      loading: false,
      error: ""
    });
    this._fireChanged();
    this._render();
  }

  _routeDescription(route) {
    const operator = operatorInfo(route.operator).label;
    const destination = route.destination ? ` ➜ ${route.destination}` : "";
    return `${operator} ${route.route}${destination} · ${route.stop_name || route.stop_id || ""}`;
  }

  _renderDirection(direction, index) {
    const draft = this._draft(index);
    const operatorCodes = [...new Set(draft.variants.map((variant) => variant.operator))];
    const operators = operatorCodes.map((operator) =>
      `<option value="${operator}" ${operator === draft.operatorFilter ? "selected" : ""}>${escapeHtml(operatorInfo(operator).label)}</option>`
    ).join("");
    const variants = draft.variants.map((variant, variantIndex) => ({variant, variantIndex}))
      .filter(({variant}) => variant.operator === draft.operatorFilter)
      .map(({variant, variantIndex}) =>
        `<option value="${variantIndex}" ${String(variantIndex) === String(draft.variantIndex) ? "selected" : ""}>${escapeHtml(variant.label)}</option>`
      ).join("");
    const stops = draft.stops.map((stop, stopIndex) =>
      `<option value="${stopIndex}" ${String(stopIndex) === String(draft.stopIndex) ? "selected" : ""}>${escapeHtml(stop.label)}</option>`
    ).join("");
    const routeRows = direction.routes.map((route, routeIndex) =>
      `<div class="saved-route"><span>${escapeHtml(this._routeDescription(route))}</span><button data-remove-route="${index}:${routeIndex}">移除</button></div>`
    ).join("") || `<div class="empty">尚未加入路線</div>`;

    return `<section class="direction-editor">
      <div class="section-head"><strong>方向 ${index + 1}</strong><button data-remove-direction="${index}">刪除方向</button></div>
      <label>按鈕名稱<input data-direction-field="name" data-direction-index="${index}" value="${escapeHtml(direction.name)}"></label>
      <div class="saved-routes">${routeRows}</div>
      <div class="route-picker">
        <div class="picker-title">先搜尋路線，再選擇營辦商、方向及巴士站</div>
        <div class="grid picker-grid">
          <label>路線<input data-draft-field="route" data-draft-index="${index}" value="${escapeHtml(draft.route)}" placeholder="例如 1A"></label>
          <button class="primary" data-load-route="${index}" ${draft.loading ? "disabled" : ""}>${draft.loading ? "搜尋中…" : "搜尋營辦商"}</button>
        </div>
        ${draft.variants.length ? `<label>營辦商（搜尋結果）<select data-operator-filter="${index}"><option value="">請選擇營辦商</option>${operators}</select></label>` : ""}
        ${draft.operatorFilter && variants ? `<label>路線方向<select data-variant-index="${index}">${variants}</select></label>` : ""}
        ${draft.stops.length ? `<label>巴士站<select data-stop-index="${index}">${stops}</select></label>` : ""}
        ${draft.stops.length ? `<button class="add" data-add-route="${index}">加入這條路線</button>` : ""}
        ${draft.error ? `<div class="error">${escapeHtml(draft.error)}</div>` : ""}
      </div>
    </section>`;
  }

  _render() {
    if (!this.shadowRoot) return;
    const directionEditors = this._config.directions
      .map((direction, index) => this._renderDirection(direction, index))
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;color:var(--primary-text-color)}
        *{box-sizing:border-box} .editor{display:flex;flex-direction:column;gap:14px;padding:8px 0}
        label{display:flex;flex-direction:column;gap:5px;color:var(--secondary-text-color);font-size:12px}
        input,select{width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit;font-size:14px}
        button{appearance:none;padding:8px 11px;border:1px solid var(--divider-color);border-radius:8px;color:var(--primary-text-color);background:var(--card-background-color);cursor:pointer}
        button.primary,button.add{border-color:var(--primary-color);color:var(--text-primary-color,#fff);background:var(--primary-color)} button:disabled{opacity:.55;cursor:wait}
        .grid{display:grid;gap:10px}.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.picker-grid{grid-template-columns:minmax(0,1fr) auto;align-items:end}
        .direction-editor{padding:14px;border:1px solid var(--divider-color);border-radius:14px}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.section-head strong{font-size:15px}
        .saved-routes{display:flex;flex-direction:column;gap:6px;margin:12px 0}.saved-route{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--primary-text-color) 5%,transparent);font-size:12px}.saved-route span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.empty{padding:8px;color:var(--secondary-text-color);font-size:12px}
        .route-picker{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;background:color-mix(in srgb,var(--primary-text-color) 4%,transparent)}.picker-title{font-size:13px;font-weight:700}.error{color:var(--error-color,#db4437);font-size:12px}.add-direction{align-self:flex-start}.hint{color:var(--secondary-text-color);font-size:11px;line-height:1.45}
        @media(max-width:650px){.grid.two,.picker-grid{grid-template-columns:1fr 1fr}.picker-grid button{min-height:40px}} @media(max-width:400px){.grid.two,.picker-grid{grid-template-columns:1fr}}
      </style>
      <div class="editor">
        <div class="grid two">
          <label>標題<input data-config-field="title" value="${escapeHtml(this._config.title)}"></label>
          <label>共享 Session Key<input data-config-field="session_key" value="${escapeHtml(this._config.session_key)}"></label>
          <label>更新間隔（秒）<input type="number" min="10" data-config-field="update_interval" value="${this._config.update_interval}"></label>
          <label>查詢時間（分鐘）<input type="number" min="1" data-config-field="session_minutes" value="${this._config.session_minutes}"></label>
          <label>顯示範圍（分鐘）<input type="number" min="5" data-config-field="display_window" value="${this._config.display_window}"></label>
          <label>最多路線<input type="number" min="1" data-config-field="max_routes" value="${this._config.max_routes}"></label>
          <label>每線最多班次<input type="number" min="1" data-config-field="max_arrivals" value="${this._config.max_arrivals}"></label>
        </div>
        ${directionEditors}
        <button class="add-direction" data-add-direction>新增方向</button>
        <div class="hint">支援九巴／龍運、城巴、專線小巴及嶼巴。顯示站名會直接使用每條路線所選巴士站；ETA 仍然只會在 Dashboard 按方向掣後查詢。</div>
      </div>`;

    this.shadowRoot.querySelectorAll("[data-config-field]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.configField;
        this._config[key] = input.type === "number" ? finiteNumber(input.value, this._config[key]) : input.value;
        this._fireChanged();
      });
    });
    this.shadowRoot.querySelectorAll("[data-direction-field]").forEach((input) => {
      input.addEventListener("change", () => {
        const index = Number(input.dataset.directionIndex);
        this._config.directions[index][input.dataset.directionField] = input.value;
        this._fireChanged();
      });
    });
    this.shadowRoot.querySelectorAll("[data-draft-field]").forEach((input) => {
      input.addEventListener("change", () => {
        const index = Number(input.dataset.draftIndex);
        const draft = this._draft(index);
        draft[input.dataset.draftField] = input.value;
        draft.variants = [];
        draft.operatorFilter = "";
        draft.stops = [];
        draft.variantIndex = "";
        draft.stopIndex = "";
        draft.error = "";
        this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-load-route]").forEach((button) => {
      button.addEventListener("click", () => this._loadVariants(Number(button.dataset.loadRoute)));
    });
    this.shadowRoot.querySelectorAll("[data-operator-filter]").forEach((select) => {
      select.addEventListener("change", async () => {
        const index = Number(select.dataset.operatorFilter);
        const draft = this._draft(index);
        draft.operatorFilter = select.value;
        draft.stops = [];
        draft.stopIndex = "";
        draft.variantIndex = select.value
          ? String(draft.variants.findIndex((variant) => variant.operator === select.value))
          : "";
        if (draft.variantIndex) await this._loadStops(index);
        else this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-variant-index]").forEach((select) => {
      select.addEventListener("change", async () => {
        const index = Number(select.dataset.variantIndex);
        this._draft(index).variantIndex = select.value;
        await this._loadStops(index);
      });
    });
    this.shadowRoot.querySelectorAll("[data-stop-index]").forEach((select) => {
      select.addEventListener("change", () => {
        this._draft(Number(select.dataset.stopIndex)).stopIndex = select.value;
      });
    });
    this.shadowRoot.querySelectorAll("[data-add-route]").forEach((button) => {
      button.addEventListener("click", () => this._addRoute(Number(button.dataset.addRoute)));
    });
    this.shadowRoot.querySelectorAll("[data-remove-route]").forEach((button) => {
      button.addEventListener("click", () => {
        const [directionIndex, routeIndex] = button.dataset.removeRoute.split(":").map(Number);
        this._config.directions[directionIndex].routes.splice(routeIndex, 1);
        this._fireChanged();
        this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-remove-direction]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.removeDirection);
        this._config.directions.splice(index, 1);
        this._drafts.clear();
        this._fireChanged();
        this._render();
      });
    });
    this.shadowRoot.querySelector("[data-add-direction]")?.addEventListener("click", () => {
      const index = this._config.directions.length + 1;
      this._config.directions.push({id:`direction_${Date.now()}`,name:`方向 ${index}`,routes:[]});
      this._fireChanged();
      this._render();
    });
  }
}

function resumePersistedHkHaBusSessions() {
  try {
    const storage = window.sessionStorage;
    if (!storage) return;
    const prefix = "hk-ha-bus-card:session:";
    const storageKeys = Array.from({length: storage.length}, (_, index) => storage.key(index));
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(prefix)) continue;
      const snapshot = JSON.parse(storage.getItem(storageKey));
      if (!snapshot?.config || !snapshot.expires_at || Date.now() >= Number(snapshot.expires_at)) {
        storage.removeItem(storageKey);
        continue;
      }
      const sessionKey = storageKey.slice(prefix.length);
      const entry = HK_HA_BUS_SESSIONS.get(sessionKey);
      if (entry?.owner) continue;
      const owner = new HkHaBusCard();
      owner.setConfig({
        ...snapshot.config,
        type: "custom:hk-ha-bus-card",
        session_key: sessionKey
      });
      owner._restorePersistedSession(owner._sessionEntry());
    }
  } catch (error) {
    console.warn("HK HA Bus Card could not resume stored sessions", error);
  }
}

if (!customElements.get("hk-ha-bus-card")) {
  customElements.define("hk-ha-bus-card", HkHaBusCard);
}
if (!customElements.get("hk-ha-bus-card-editor")) {
  customElements.define("hk-ha-bus-card-editor", HkHaBusCardEditor);
}

resumePersistedHkHaBusSessions();

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "hk-ha-bus-card")) {
  window.customCards.push({
    type: "hk-ha-bus-card",
    name: "HK HA Bus Card",
    preview: true,
    description: "Frontend-only KMB/Long Win, Citybus, GMB and NLB arrival board",
    documentationURL: "https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/"
  });
}

console.info(`%c HK-HA-BUS-CARD %c v${HK_HA_BUS_CARD_VERSION} `, "color:white;background:#168f48;font-weight:700", "color:#168f48;background:white");
