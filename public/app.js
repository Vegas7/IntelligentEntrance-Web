/* 智能通行 Web 版
 * 接口协议与 Lite 版 (IntelligentEntrance_REMAKE) 一致，经同源代理 api/* 转发到官方服务器。
 * 不使用定位、蓝牙等任何设备权限。
 */
(() => {
  'use strict';

  const QR_REFRESH_SECONDS = 30;
  const MAX_LOGS = 150;

  // ================= 本地存储（全部 try/catch，隐私模式下也能正常运行） =================
  const store = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem('ie.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('ie.' + key, JSON.stringify(value)); } catch {}
    },
    del(...keys) {
      try { keys.forEach((k) => localStorage.removeItem('ie.' + k)); } catch {}
    },
  };

  // ================= 语言 =================
  const DICT = window.IE_I18N;
  let lang = store.get('lang') || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  if (!DICT[lang]) lang = 'zh';

  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }

  // ================= 状态 =================
  const state = {
    token: store.get('token'),
    user: store.get('user'),
    building: store.get('building'),         // { id, name, parkId }
    defaultFloor: store.get('defaultFloor'), // { id, name }
    authFloors: store.get('authFloors', []), // [{ id, name, num }]
    allFloors: store.get('allFloors', []),
    selectedFloorId: store.get('selectedFloorId'),
    qr: store.get('qr'),                     // { code, floorId, at }
    settings: { wakeLock: true, ...store.get('settings', {}) },
    allMode: false,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    viewLogin: $('view-login'),
    viewPass: $('view-pass'),
    loginMsg: $('login-msg'),
    buildingName: $('building-name'),
    qrCanvas: $('qr-canvas'),
    qrBox: document.querySelector('.qr-box'),
    qrPlaceholder: $('qr-placeholder'),
    qrFloor: $('qr-floor'),
    qrCountdown: $('qr-countdown'),
    qrBar: $('qr-progress-bar'),
    floorTitle: $('floor-title'),
    floorGrid: $('floor-grid'),
    floorEmpty: $('floor-empty'),
    btnMode: $('btn-mode'),
    sheetProfile: $('sheet-profile'),
    sheetDebug: $('sheet-debug'),
    debugList: $('debug-list'),
    toast: $('toast'),
  };

  // ================= 语言 / 主题切换（登录页与通行页各一组按钮） =================
  const tplPrefs = $('tpl-prefs');
  document.querySelectorAll('.js-prefs').forEach((slot) => slot.appendChild(tplPrefs.content.cloneNode(true)));

  function applyStaticI18n() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const s = t(el.dataset.i18nAria);
      el.setAttribute('aria-label', s);
      if (el.tagName === 'BUTTON') el.title = s;
    });
  }

  function setLanguage(next) {
    lang = next;
    store.set('lang', lang);
    applyStaticI18n();
    renderSmsBtn();
    setLoginMsg('');
    renderHeader();
    renderQr();
    renderCountdown();
    renderFloors();
    renderProfile();
    renderWakeStatus();
    if (els.sheetDebug.open) renderLogs();
  }

  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  // 用户未手动选择时跟随系统；手动切换后记住选择
  const effectiveTheme = () => document.documentElement.dataset.theme || (darkMq.matches ? 'dark' : 'light');
  function applyTheme() {
    const mode = effectiveTheme();
    document.documentElement.dataset.mode = mode;
    $('meta-theme').setAttribute('content', mode === 'dark' ? '#000000' : '#f2f2f7');
  }
  if (darkMq.addEventListener) darkMq.addEventListener('change', applyTheme);

  document.querySelectorAll('.js-lang').forEach((b) =>
    b.addEventListener('click', () => setLanguage(lang === 'zh' ? 'en' : 'zh'))
  );
  document.querySelectorAll('.js-theme').forEach((b) =>
    b.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('theme', next);
      applyTheme();
    })
  );

  // ================= 日志 =================
  const logs = [];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const timeStr = (d = new Date()) =>
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const maskToken = (t) => (t ? String(t).slice(0, 8) + '…' : '');

  function maskBody(text) {
    if (!text) return text;
    return text.replace(/("credential"\s*:\s*")[^"]*"/g, '$1******"');
  }

  function pushLog(entry) {
    logs.push({ time: timeStr(), ...entry });
    if (logs.length > MAX_LOGS) logs.shift();
    if (els.sheetDebug.open) renderLogs();
  }
  const logEvent = (tag, msg) => pushLog({ type: 'event', tag, msg });

  function formatLogs() {
    const lines = ['=== INTELLIGENT ENTRANCE WEB DEBUG LOG ===', `Generated at: ${new Date().toLocaleString()}`, `UA: ${navigator.userAgent}`, ''];
    for (const l of logs) {
      if (l.type === 'event') {
        lines.push(`[${l.time}][${l.tag}] ${l.msg}`);
      } else {
        lines.push('==================================================');
        lines.push(`[${l.time}] ${l.method} ${l.path} (${l.ms} ms)`);
        lines.push(`Status: HTTP ${l.status}`);
        if (l.auth) lines.push(`Authorization: ${l.auth}`);
        if (l.req) lines.push('--- Request Body ---', l.req);
        lines.push('--- Response Body ---', l.res || '<empty>');
      }
    }
    return lines.join('\n');
  }

  function renderLogs() {
    els.debugList.replaceChildren(
      ...logs.slice().reverse().map((l) => {
        if (l.type === 'event') {
          const div = document.createElement('div');
          div.className = 'log event';
          div.textContent = `[${l.time}][${l.tag}] ${l.msg}`;
          return div;
        }
        const d = document.createElement('details');
        d.className = 'log';
        const ok = l.status >= 200 && l.status < 300 && l.ok;
        d.innerHTML = `<summary><span class="st ${ok ? 'ok' : 'bad'}"></span><span class="path"></span><span class="t"></span></summary><pre></pre>`;
        d.querySelector('.st').textContent = l.status || 'ERR';
        d.querySelector('.path').textContent = `${l.method} ${l.path}`;
        d.querySelector('.t').textContent = `${l.time} · ${l.ms}ms`;
        d.querySelector('pre').textContent =
          (l.auth ? `Authorization: ${l.auth}\n` : '') +
          (l.req ? `--- Request ---\n${l.req}\n` : '') +
          `--- Response ---\n${l.res || '<empty>'}`;
        return d;
      })
    );
    if (!logs.length) els.debugList.innerHTML = `<p class="floor-empty">${t('debug.empty')}</p>`;
  }

  // ================= 网络 =================
  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  const isOk = (j) => j && (j.value === 200 || j.code === 200 || String(j.description).toUpperCase() === 'OK');

  async function api(path, body, { method = 'POST', auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers.Authorization = state.token;
    const reqText = method === 'GET' ? undefined : JSON.stringify(body || {});
    const t0 = performance.now();
    let status = 0;
    let text = '';
    let json = null;
    try {
      const r = await fetch('api/' + path, { method, headers, body: reqText, cache: 'no-store' });
      status = r.status;
      text = await r.text();
      try { json = JSON.parse(text); } catch {}
    } catch (e) {
      text = `网络异常: ${e.message}`;
    }
    const ok = status >= 200 && status < 300 && isOk(json);
    pushLog({
      type: 'http', method, path: '/' + path, status, ok,
      ms: Math.round(performance.now() - t0),
      auth: headers.Authorization ? maskToken(headers.Authorization) : '',
      req: maskBody(reqText), res: text.slice(0, 4000),
    });

    if (status === 401 && auth) {
      onSessionExpired();
      throw new ApiError(t('login.expired'), status, json);
    }
    if (!ok) {
      const msg = (json && (json.description || json.message)) || (status ? t('err.http', { status }) : t('err.network'));
      throw new ApiError(msg, status, json);
    }
    return json.data;
  }

  // ================= 工具 =================
  let toastTimer;
  function toast(msg, ms = 2200) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
  }

  const vibrate = (p = 15) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

  const toFloor = (f) => ({
    id: String(f.buildingFloorId || f.floorId || f.floorNum || f.floorName),
    name: f.floorName || (f.floorNum != null ? `${f.floorNum}F` : '?'),
    num: f.floorNum != null ? f.floorNum : null,
  });

  const findFloor = (id) => state.authFloors.find((f) => f.id === id) || state.allFloors.find((f) => f.id === id);

  // ================= 登录页 =================
  function showLogin(msg) {
    stopQrLoop();
    releaseWakeLock();
    els.viewPass.hidden = true;
    els.viewLogin.hidden = false;
    document.title = t('app.title');
    setLoginMsg(msg || '');
    const last = store.get('lastPhone');
    if (last) {
      $('pwd-phone').value = $('pwd-phone').value || last;
      $('sms-phone').value = $('sms-phone').value || last;
    }
  }

  function setLoginMsg(msg, ok = false) {
    els.loginMsg.textContent = msg;
    els.loginMsg.classList.toggle('ok', ok);
  }

  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $('form-pwd').hidden = tab.dataset.tab !== 'pwd';
      $('form-sms').hidden = tab.dataset.tab !== 'sms';
      setLoginMsg('');
    })
  );

  const validPhone = (p) => /^1\d{10}$/.test(p);

  async function doLogin(phone, credential, authType, submitBtn) {
    if (!validPhone(phone)) return setLoginMsg(t('login.errPhone'));
    if (!credential) return setLoginMsg(t(authType === 0 ? 'login.errPassword' : 'login.errCode'));
    submitBtn.disabled = true;
    submitBtn.textContent = t('login.submitting');
    setLoginMsg('');
    try {
      const data = await api('auth/get_token', { userCellNumber: phone, authType, credential }, { auth: false });
      const token =
        (data && typeof data === 'object' && (data.jti || data.token || data.accessToken)) ||
        (typeof data === 'string' ? data : null);
      if (!token) throw new ApiError(t('login.errNoToken'));
      state.token = token;
      store.set('token', token);
      store.set('lastPhone', phone);
      logEvent('Auth', `登录成功 (authType=${authType})，Token ${maskToken(token)}`);
      $('pwd-password').value = '';
      $('sms-code').value = '';
      enterPass();
    } catch (e) {
      logEvent('Auth', `登录失败: ${e.message}`);
      setLoginMsg(e.message || t(authType === 0 ? 'login.errPwdFailed' : 'login.errSmsFailed'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = t('login.submit');
    }
  }

  $('form-pwd').addEventListener('submit', (e) => {
    e.preventDefault();
    doLogin($('pwd-phone').value.trim(), $('pwd-password').value, 0, e.submitter || e.target.querySelector('[type=submit]'));
  });
  $('form-sms').addEventListener('submit', (e) => {
    e.preventDefault();
    doLogin($('sms-phone').value.trim(), $('sms-code').value.trim(), 1, e.submitter || e.target.querySelector('[type=submit]'));
  });

  let smsTimer;
  let smsLeft = 0;
  function renderSmsBtn() {
    const btn = $('btn-send-sms');
    btn.disabled = smsLeft > 0;
    btn.textContent = smsLeft > 0 ? `${smsLeft}s` : t('login.sendCode');
  }
  $('btn-send-sms').addEventListener('click', async () => {
    const btn = $('btn-send-sms');
    const phone = $('sms-phone').value.trim();
    if (!validPhone(phone)) return setLoginMsg(t('login.errPhone'));
    btn.disabled = true;
    try {
      await api('sms_verification/send', { cellNumber: phone }, { auth: false });
      setLoginMsg(t('login.smsSent'), true);
    } catch (e) {
      // 与 Lite 版一致：服务端偶发 500 但短信实际已发出
      setLoginMsg(e.status === 500 ? t('login.smsMaybe') : e.message);
    }
    smsLeft = 60;
    renderSmsBtn();
    clearInterval(smsTimer);
    smsTimer = setInterval(() => {
      smsLeft -= 1;
      if (smsLeft <= 0) clearInterval(smsTimer);
      renderSmsBtn();
    }, 1000);
    $('sms-code').focus();
  });

  function onSessionExpired() {
    if (!state.token) return;
    logEvent('Auth', '服务端返回 401，Token 已失效');
    clearSession();
    showLogin(t('login.expired'));
  }

  function clearSession() {
    state.token = null;
    state.user = null;
    state.qr = null;
    store.del('token', 'user', 'qr', 'building', 'defaultFloor', 'authFloors', 'allFloors', 'selectedFloorId');
    state.building = null;
    state.defaultFloor = null;
    state.authFloors = [];
    state.allFloors = [];
    state.selectedFloorId = null;
    els.qrBox.classList.remove('is-stale');
  }

  // ================= 通行页 =================
  function enterPass() {
    els.viewLogin.hidden = true;
    els.viewPass.hidden = false;
    state.allMode = false;
    renderHeader();
    renderQr();
    renderCountdown();
    renderFloors();
    requestWakeLock();
    // 有缓存时先用缓存出码，同时后台刷新楼宇 / 楼层数据
    if (canFetchQr()) startQrLoop();
    loadBuildingAndFloors();
    loadUser();
  }

  function renderHeader() {
    els.buildingName.textContent = (state.building && state.building.name) || t('app.title');
    document.title = state.building ? t('title.building', { name: state.building.name }) : t('app.title');
  }

  // ---------- 二维码 ----------
  function drawQr(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const cells = n + quiet * 2;
    const cssSize = els.qrCanvas.clientWidth || 320;
    const target = Math.round(cssSize * (window.devicePixelRatio || 1));
    const scale = Math.max(2, Math.floor(target / cells));
    const size = cells * scale;
    const c = els.qrCanvas;
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    // 始终白底黑码：闸机 / 梯控扫码器无法识别反色（黑底白码）二维码，已实测
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }

  function renderQr() {
    const code = state.qr && state.qr.code;
    if (code) {
      drawQr(code);
      els.qrPlaceholder.hidden = true;
    } else {
      const ctx = els.qrCanvas.getContext('2d');
      ctx.clearRect(0, 0, els.qrCanvas.width, els.qrCanvas.height);
      els.qrPlaceholder.hidden = false;
      els.qrPlaceholder.textContent = t(state.building ? 'pass.loadingCode' : 'pass.loadingBuilding');
    }
    setFloorLabel(findFloor(currentFloorId()) || null);
  }

  // ---------- 楼层标签：切换时像机械翻牌钟一样上下滚动（上楼向上滚，下楼向下滚） ----------
  let shownFloor = null;
  const floorRank = (f) => {
    if (f.num != null) return f.num;
    const list = state.allFloors.length ? state.allFloors : state.authFloors;
    return list.findIndex((x) => x.id === f.id);
  };
  function setFloorLabel(floor) {
    const el = els.qrFloor;
    const prev = shownFloor;
    shownFloor = floor;
    if (!floor) { el.textContent = ''; return; }
    if (prev && prev.id === floor.id) {
      // 同一楼层：动画进行中则保持，否则确保文字正确
      if (!el.querySelector('.roll') && el.textContent !== floor.name) el.textContent = floor.name;
      return;
    }
    const dir = prev ? Math.sign(floorRank(floor) - floorRank(prev)) : 0;
    if (!dir || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = floor.name;
      return;
    }
    const roll = document.createElement('span');
    roll.className = 'roll ' + (dir > 0 ? 'roll-up' : 'roll-down');
    const oldEl = document.createElement('span');
    oldEl.className = 'roll-old';
    oldEl.textContent = prev.name;
    const newEl = document.createElement('span');
    newEl.className = 'roll-new';
    newEl.textContent = floor.name;
    roll.append(oldEl, newEl);
    el.replaceChildren(roll);
    // 动画结束后换回纯文本；若期间又切换了楼层，旧动画的收尾直接跳过
    const done = () => { if (roll.isConnected) el.textContent = floor.name; };
    newEl.addEventListener('animationend', done, { once: true });
    setTimeout(done, 700);
  }

  const canFetchQr = () => !!(state.building && currentFloorId());
  const currentFloorId = () =>
    state.selectedFloorId || (state.defaultFloor && state.defaultFloor.id) || (state.authFloors[0] && state.authFloors[0].id);

  let qrSeq = 0;
  async function refreshQr() {
    if (!canFetchQr()) return;
    const floorId = currentFloorId();
    const seq = ++qrSeq;
    const body = { buildingId: state.building.id, floorId };
    if (state.building.parkId) body.parkId = state.building.parkId;
    try {
      const data = await api('v2/user/get_commuter_code', body);
      if (seq !== qrSeq) return; // 已被更新的请求覆盖（例如刚切换楼层）
      const code =
        (data && typeof data === 'object' && (data.commuterCode || data.qrCode || data.code)) ||
        (typeof data === 'string' ? data : null);
      if (!code) throw new ApiError(t('err.noCode'));
      state.qr = { code, floorId, at: Date.now() };
      store.set('qr', state.qr);
      els.qrBox.classList.remove('is-stale');
      renderQr();
    } catch (e) {
      if (seq !== qrSeq || !state.token) return;
      logEvent('Pass', `二维码刷新失败: ${e.message}`);
      toast(t('pass.qrFailed', { msg: e.message }));
      // 缓存码超过 2 分钟仍未刷新成功时置灰提示
      if (state.qr && Date.now() - state.qr.at > 120000) els.qrBox.classList.add('is-stale');
    }
  }

  let loopTimer = null;
  let remaining = QR_REFRESH_SECONDS;

  function renderCountdown() {
    els.qrCountdown.textContent = t('pass.countdown', { s: remaining });
    els.qrBar.style.transform = `scaleX(${remaining / QR_REFRESH_SECONDS})`;
  }

  function startQrLoop() {
    stopQrLoop();
    remaining = QR_REFRESH_SECONDS;
    renderCountdown();
    refreshQr();
    loopTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        remaining = QR_REFRESH_SECONDS;
        refreshQr();
      }
      renderCountdown();
    }, 1000);
  }

  function stopQrLoop() {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  $('btn-refresh').addEventListener('click', () => {
    vibrate();
    if (!canFetchQr()) return toast(t('pass.floorsNotReady'));
    startQrLoop();
    toast(t('pass.refreshing'));
  });

  // ---------- 楼宇 & 楼层 ----------
  async function loadBuildingAndFloors() {
    logEvent('Pass', '开始加载楼宇及楼层数据…');
    try {
      const list = await api('building/read_relation_building_list', {});
      if (Array.isArray(list) && list.length) {
        const b = list[0];
        state.building = { id: String(b.buildingId), name: b.buildingName, parkId: b.parkId ? String(b.parkId) : null };
        store.set('building', state.building);
        renderHeader();
        logEvent('Pass', `关联楼宇: ${b.buildingName} (${b.buildingId})`);
      } else if (!state.building) {
        els.qrPlaceholder.textContent = t('pass.noBuilding');
        return;
      }
    } catch (e) {
      logEvent('Pass', `获取关联楼宇失败: ${e.message}${state.building ? '，使用缓存' : ''}`);
      if (!state.building) {
        if (state.token) els.qrPlaceholder.textContent = t('pass.loadFailed', { msg: e.message });
        return;
      }
    }
    const buildingId = state.building.id;

    const [def, auth, all] = await Promise.allSettled([
      api('user/get_default_floor', { buildingId }),
      api('floor/read_list', { buildingId, authFlag: 1 }),
      api('floor/read_list', { buildingId, authFlag: 0 }),
    ]);
    if (!state.token) return;

    if (def.status === 'fulfilled' && def.value && def.value.buildingFloorId) {
      state.defaultFloor = { id: String(def.value.buildingFloorId), name: def.value.floorName || '' };
      store.set('defaultFloor', state.defaultFloor);
      logEvent('Pass', `默认楼层: ${state.defaultFloor.name}`);
    }
    if (auth.status === 'fulfilled' && Array.isArray(auth.value) && auth.value.length) {
      state.authFloors = auth.value.map(toFloor);
      store.set('authFloors', state.authFloors);
      logEvent('Pass', `授权楼层 ${state.authFloors.length} 层: ${state.authFloors.map((f) => f.name).join(', ')}`);
    } else if (auth.status === 'rejected') logEvent('Pass', `拉取授权楼层失败: ${auth.reason.message}`);
    if (all.status === 'fulfilled' && Array.isArray(all.value) && all.value.length) {
      state.allFloors = all.value.map(toFloor);
      store.set('allFloors', state.allFloors);
      logEvent('Pass', `全部楼层 ${state.allFloors.length} 层`);
    } else if (all.status === 'rejected') logEvent('Pass', `拉取全部楼层失败: ${all.reason.message}`);

    // 选中楼层：上次选择（仍存在） > 服务端默认楼层 > 第一个授权楼层
    const prevFloorId = currentFloorId();
    if (!state.selectedFloorId || !findFloor(state.selectedFloorId)) {
      state.selectedFloorId = (state.defaultFloor && state.defaultFloor.id) || (state.authFloors[0] && state.authFloors[0].id) || null;
      store.set('selectedFloorId', state.selectedFloorId);
    }
    renderFloors();
    renderQr();
    // 冷启动没有缓存、或选中楼层发生变化时立即出码
    if (!loopTimer || prevFloorId !== currentFloorId()) {
      if (canFetchQr()) startQrLoop();
    }
  }

  async function loadUser() {
    try {
      const u = await api('user/get_user', {});
      if (u) {
        state.user = u;
        store.set('user', u);
        renderProfile();
      }
    } catch (e) {
      logEvent('User', `获取用户信息失败: ${e.message}`);
    }
  }

  function renderFloors() {
    const authIds = new Set(state.authFloors.map((f) => f.id));
    const floors = state.allMode && state.allFloors.length ? state.allFloors : state.authFloors;
    const hint = document.createElement('small');
    hint.textContent = t('floors.hint');
    els.floorTitle.replaceChildren(t(state.allMode ? 'floors.all' : 'floors.auth'), hint);
    els.btnMode.textContent = t(state.allMode ? 'floors.toAuth' : 'floors.toAll');
    els.btnMode.hidden = !state.allFloors.length && !state.allMode;
    // 侧栏里的图标版切换按钮：与文字按钮同步（全部楼层时高亮）
    const modeIcon = $('btn-mode-icon');
    const modeLabel = t(state.allMode ? 'floors.toAuth' : 'floors.toAll');
    modeIcon.setAttribute('aria-label', modeLabel);
    modeIcon.title = modeLabel;
    modeIcon.setAttribute('aria-pressed', String(state.allMode));
    modeIcon.classList.toggle('is-on', state.allMode);
    modeIcon.disabled = els.btnMode.hidden;
    els.floorEmpty.hidden = floors.length > 0;
    els.floorEmpty.textContent = state.token ? t('floors.loading') : '';

    const selected = currentFloorId();
    els.floorGrid.replaceChildren(
      ...floors.map((f) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'floor-tile';
        b.setAttribute('role', 'listitem');
        b.dataset.id = f.id;
        const isSel = f.id === selected;
        const isAuth = authIds.has(f.id);
        if (isSel) b.classList.add('is-selected');
        else if (state.allMode && isAuth) b.classList.add('is-auth');
        b.innerHTML = '<span class="name"></span>';
        b.querySelector('.name').textContent = f.name;
        if (!isSel && state.allMode && isAuth) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = t('floors.authorized');
          b.appendChild(badge);
        }
        b.setAttribute('aria-label', t(isSel ? 'floors.ariaCurrent' : 'floors.aria', { name: f.name }));
        return b;
      })
    );
  }

  // 单击即选层
  els.floorGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.floor-tile');
    if (tile) selectFloor(findFloor(tile.dataset.id));
  });

  async function selectFloor(floor) {
    if (!floor || !state.building) return;
    if (floor.id === currentFloorId() && state.qr && state.qr.floorId === floor.id) {
      // 点的是当前楼层：只刷新二维码
      startQrLoop();
      return;
    }
    vibrate(30);
    state.selectedFloorId = floor.id;
    store.set('selectedFloorId', floor.id);
    logEvent('Pass', `选中楼层: ${floor.name} (${floor.id})`);
    renderFloors();
    setFloorLabel(floor); // 楼层标签上下滚动切换
    startQrLoop(); // 立即生成该楼层的二维码并重置倒计时

    const buildingId = state.building.id;
    api('user/modify_default_floor', { buildingId, buildingFloorId: floor.id })
      .then(() => {
        state.defaultFloor = { id: floor.id, name: floor.name };
        store.set('defaultFloor', state.defaultFloor);
      })
      .catch((e) => logEvent('Pass', `同步默认楼层失败: ${e.message}`));
  }

  function toggleFloorMode() {
    state.allMode = !state.allMode;
    renderFloors();
    // 切换列表后回到顶部，避免短列表停在长列表的滚动位置而“藏”到上方
    document.querySelector('.floor-scroll').scrollTop = 0;
  }
  els.btnMode.addEventListener('click', toggleFloorMode);
  $('btn-mode-icon').addEventListener('click', toggleFloorMode);

  // ================= 个人中心 =================
  function renderProfile() {
    const u = state.user || {};
    $('profile-name').textContent = u.userNickname || u.userName || t('profile.defaultName');
    const phone = u.userCellNumber || store.get('lastPhone') || '';
    $('profile-phone').textContent = phone ? phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '';
    $('profile-building').textContent = (state.building && state.building.name) || '';
  }

  function openSheet(d) {
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  // 关闭时先播放向下滑出的动画，结束后再真正关闭（减弱动态效果时直接关闭）
  function closeSheet(d) {
    if (!d.open || d.classList.contains('is-closing')) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      d.classList.remove('is-closing');
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
    d.classList.add('is-closing');
    d.addEventListener('animationend', (e) => { if (e.target === d) finish(); }, { once: true });
    setTimeout(finish, 400); // 兜底：动画事件未触发时也能关闭
  }
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return closeSheet(d);
      // 只有点在面板外（遮罩上）才关闭；点面板自身的空白处不关闭
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) closeSheet(d);
      }
    });
    // Esc 键同样走滑出动画
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeSheet(d);
    });
  });

  $('btn-profile').addEventListener('click', () => {
    renderProfile();
    $('set-wakelock').checked = state.settings.wakeLock;
    renderWakeStatus();
    openSheet(els.sheetProfile);
  });

  function saveSettings() { store.set('settings', state.settings); }
  $('set-wakelock').addEventListener('change', (e) => {
    state.settings.wakeLock = e.target.checked;
    saveSettings();
    if (e.target.checked) {
      requestWakeLock(true);
    } else releaseWakeLock();
  });

  $('btn-logout').addEventListener('click', () => {
    if (!confirm(t('profile.logoutConfirm'))) return;
    logEvent('Auth', '用户退出登录，清空本地缓存');
    clearSession();
    closeSheet(els.sheetProfile);
    showLogin('');
  });

  // ================= 调试日志 =================
  // 入口默认隐藏；需要排查问题时在网址后加 ?debug 即可显示（日志始终在内存中记录）
  try {
    if (new URLSearchParams(location.search).has('debug')) $('btn-debug').hidden = false;
  } catch {}
  $('btn-debug').addEventListener('click', () => {
    renderLogs();
    openSheet(els.sheetDebug);
  });
  $('btn-log-clear').addEventListener('click', () => {
    logs.length = 0;
    renderLogs();
  });
  $('btn-log-export').addEventListener('click', () => {
    const d = new Date();
    const name = `IntelligentEntrance-Log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
    const url = URL.createObjectURL(new Blob([formatLogs()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ================= 屏幕常亮（Screen Wake Lock API；Web 无法调节亮度，只做防锁屏） =================
  // iOS 18.4 起 Safari 与「添加到主屏幕」的 Web App 都支持。iOS 可能要求在用户点击后才授予，
  // 且切到后台会自动释放，所以：失败时在下一次点击屏幕时重试，释放后回到前台再申请。
  let wakeLock = null;
  const wakeHeld = () => !!(wakeLock && !wakeLock.released);
  async function requestWakeLock(userInitiated = false) {
    if (!state.settings.wakeLock || els.viewPass.hidden || document.visibilityState !== 'visible') return renderWakeStatus();
    if (!('wakeLock' in navigator)) {
      if (userInitiated) toast(t(window.isSecureContext ? 'wake.unsupported' : 'wake.needHttps'));
      return renderWakeStatus();
    }
    if (wakeHeld()) return renderWakeStatus();
    try {
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
        renderWakeStatus();
      });
    } catch (e) {
      wakeLock = null;
      if (userInitiated) toast(t('wake.failed', { msg: e.message }));
    }
    renderWakeStatus();
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    renderWakeStatus();
  }
  // 设置项下方显示实际状态，便于在手机上确认是否生效
  function renderWakeStatus() {
    const el = $('wake-status');
    if (!el) return;
    let key = 'profile.wakeLockDesc';
    if (!('wakeLock' in navigator)) key = 'wake.notSupported';
    else if (state.settings.wakeLock) key = wakeHeld() ? 'wake.active' : 'wake.pending';
    el.textContent = t(key);
  }
  // 未持有锁时，借用户的下一次点击重新申请（满足 iOS 的手势要求）
  document.addEventListener('pointerup', () => {
    if (state.settings.wakeLock && !wakeHeld()) requestWakeLock();
  }, { passive: true });

  // ================= 生命周期 =================
  document.addEventListener('visibilitychange', () => {
    if (els.viewPass.hidden || !state.token) return;
    if (document.visibilityState === 'visible') {
      // 回到前台：二维码可能已过期，立即刷新
      if (canFetchQr()) startQrLoop();
      requestWakeLock();
    } else {
      stopQrLoop();
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.qr && state.qr.code && !els.viewPass.hidden && drawQr(state.qr.code), 150);
  });

  // ================= iPhone Duo 折叠态 Safari：右侧竖向按钮栏 =================
  // 折叠态下 Safari 把状态栏和浏览器按钮放在屏幕右侧一列（约 84px），页面宽度因此比屏幕窄。
  // 网页无法往那一列里加按钮，所以检测到这一列时，把语言 / 主题 / 头像按钮竖排贴在页面右缘、紧挨着它。
  // 只在 iPhone 的 Safari（非主屏幕 App）里、且页面比屏幕窄 60～140px 时启用；其他 iPhone 上这个差值为 0。
  // 网址后加 ?rail 可强制开启（用于测试）。
  //
  // 主屏幕 App（PWA）折叠态则不同：系统状态栏在摄像头一侧的一列，但这一列是透明的，页面延伸到它下面，
  // 并通过 safe-area-inset-left / right（约 84px）告知。这时把按钮直接放进这一列（html.has-side-column）。
  // 竖持时在右侧；外屏横持时随旋转方向在左侧或右侧（html.side-left / side-right）。
  // 网址加 ?column（右侧）或 ?column=left 可在电脑上模拟这一列（84px）用于测试。
  const queryHas = (k) => { try { return new URLSearchParams(location.search).has(k); } catch { return false; } };
  const forceRail = queryHas('rail');
  const simSide = queryHas('column') ? (new URLSearchParams(location.search).get('column') === 'left' ? 'left' : 'right') : null;
  if (simSide) document.documentElement.classList.add(simSide === 'left' ? 'sim-col-left' : 'sim-col-right');
  const isIPhone = /iPhone/.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
  const isStandalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  // 读取 safe-area 内边距：env() 只能在 CSS 里取值，用一个隐藏的探针元素换算成像素
  const saProbe = document.createElement('div');
  saProbe.setAttribute('aria-hidden', 'true');
  saProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
  document.body.appendChild(saProbe);
  const safeArea = () => {
    const cs = getComputedStyle(saProbe);
    return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  };
  // 透明侧栏在哪一侧：仅主屏幕 App（Safari 里那一列是不透明的浏览器栏）。
  // 竖持：普通 iPhone 左右安全区为 0，大于 40 即为侧栏；
  // 横持：普通 iPhone 灵动岛一侧也有安全区，所以额外要求宽度不超过 720（Duo 外屏横放 678，普通 iPhone 横放 ≥ 812）。
  function sideColumnSide() {
    if (simSide) return simSide;
    if (!isIPhone || !isStandalone) return null;
    const sa = safeArea();
    const portrait = window.innerHeight > window.innerWidth;
    if (!portrait && window.innerWidth > 720) return null;
    if (sa.right >= 40 && sa.right >= sa.left) return 'right';
    if (sa.left >= 40) return 'left';
    return null;
  }
  // 设备向右（顺时针）转 90° 时，外屏摄像头落在侧栏的底部，按钮栏需要向上避让（html.cam-bottom）。
  // iOS：window.orientation = -90 即顺时针；兼容 screen.orientation.angle = 270。?cam=bottom 可模拟。
  const simCamBottom = (() => { try { return new URLSearchParams(location.search).get('cam') === 'bottom'; } catch { return false; } })();
  function rotatedClockwise() {
    if (typeof window.orientation === 'number') return window.orientation === -90;
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle === 270;
    return false;
  }
  function updateSideRail() {
    const side = sideColumnSide();
    document.documentElement.classList.toggle('cam-bottom', !!side && (simCamBottom || (window.innerWidth > window.innerHeight && rotatedClockwise())));
    const gap = screen.width - window.innerWidth;
    const rail = !side && (forceRail || (isIPhone && !isStandalone && gap >= 60 && gap <= 140));
    const root = document.documentElement.classList;
    root.toggle('has-side-column', !!side);
    root.toggle('side-left', side === 'left');
    root.toggle('side-right', side === 'right');
    root.toggle('has-side-rail', rail);
  }
  updateSideRail();
  window.addEventListener('resize', updateSideRail);
  window.addEventListener('orientationchange', updateSideRail);
  // 左右横屏直接互转（180°）时尺寸不变、不一定触发 resize，单独监听方向变化
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', updateSideRail);

  // 诊断：网址加 ?diag 时在页面上显示侧边栏检测用到的各项数值和版本号（用于真机排查）
  const APP_VERSION = '2026.10.24-v33';
  function diagInfo() {
    const vv = window.visualViewport;
    const sa = safeArea();
    return {
      safeArea: `top ${sa.top} / right ${sa.right} / bottom ${sa.bottom} / left ${sa.left}`,
      column: document.documentElement.classList.contains('has-side-column'),
      orientation: `${typeof window.orientation === 'number' ? window.orientation : 'n/a'} / ${screen.orientation ? `${screen.orientation.type} ${screen.orientation.angle}` : 'n/a'}`,
      camBottom: document.documentElement.classList.contains('cam-bottom'),
      version: APP_VERSION,
      inner: `${window.innerWidth}×${window.innerHeight}`,
      screen: `${screen.width}×${screen.height}`,
      avail: `${screen.availWidth}×${screen.availHeight}`,
      outer: `${window.outerWidth}×${window.outerHeight}`,
      visualViewport: vv ? `${Math.round(vv.width)}×${Math.round(vv.height)}` : 'n/a',
      docClient: `${document.documentElement.clientWidth}×${document.documentElement.clientHeight}`,
      dpr: window.devicePixelRatio,
      gap: screen.width - window.innerWidth,
      isIPhone,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: isStandalone,
      rail: document.documentElement.classList.contains('has-side-rail'),
      ua: navigator.userAgent,
    };
  }
  logEvent('Diag', JSON.stringify(diagInfo()));
  if ((() => { try { return new URLSearchParams(location.search).has('diag'); } catch { return false; } })()) {
    const box = document.createElement('pre');
    box.className = 'diag-box';
    const render = () => { box.textContent = Object.entries(diagInfo()).map(([k, v]) => `${k}: ${v}`).join('\n'); };
    render();
    document.body.appendChild(box);
    window.addEventListener('resize', render);
    setInterval(render, 1000);
  }

  // ================= 启动 =================
  applyTheme();
  applyStaticI18n();
  renderSmsBtn();
  if (state.token) enterPass();
  else showLogin();

  // 离线缓存（需 HTTPS 或 localhost）：之后打开直接从本地秒开，后台静默更新
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => logEvent('SW', `离线缓存注册失败: ${e.message}`));
    });
  }
})();
