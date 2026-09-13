/*!
 * ECUT 校园网 Web 认证页自动填充脚本
 * 由 MainActivity 通过 WebView.evaluateJavascript 注入。
 * 占位符 __ECUT_CONFIG__ 会被替换成一个 JSON 字符串字面量。
 */
(function () {
  'use strict';

  var CFG = {};
  try { CFG = JSON.parse(__ECUT_CONFIG__) || {}; } catch (e) { CFG = {}; }

  var USER = CFG.user || '';
  var PASS = CFG.pass || '';
  var ISP = CFG.ispSuffix || '';
  var AUTO_SUBMIT = CFG.autoSubmit !== false;
  var PAGE_URL = CFG.pageUrl || '';

  var POLL_MS = 300;
  var MAX_POLLS = 100;      // 快速探测 ~30s
  var SLOW_POLLS = 40;      // 之后每 1s 一次，再 ~40s
  var MAX_FILL_TRIES = 10;

  var TOKEN = String(Date.now()) + '_' + String(Math.floor(Math.random() * 1000000));
  var timers = [];
  var polls = 0;
  var fillTries = 0;
  var submitted = false;
  var finished = false;
  var located = false;
  var targetDesc = '';
  var sawSubmitEvent = false;
  var mutationCount = 0;
  var mo = null;

  /* ---------------- 与原生层通信 ---------------- */

  var BRIDGE = null;
  try { BRIDGE = window.NativeApp || null; } catch (e) {}
  if (!BRIDGE) { try { BRIDGE = (window.top && window.top.NativeApp) || null; } catch (e) {} }

  function send(level, msg) {
    try { if (BRIDGE && BRIDGE.onLog) { BRIDGE.onLog(level, String(msg)); } } catch (e) {}
    try { console.log('[ECUT][' + level + '] ' + msg); } catch (e) {}
  }
  function info(m) { send('info', m); }
  function warn(m) { send('warn', m); }
  function good(m) { send('ok', m); }

  function stale() { return window.__ecutToken !== TOKEN; }
  function later(fn, ms) { var t = setTimeout(function () { if (!stale()) { fn(); } }, ms); timers.push(t); return t; }
  function every(fn, ms) { var t = setInterval(function () { if (!stale()) { fn(); } }, ms); timers.push(t); return t; }
  function stopAll() {
    for (var i = 0; i < timers.length; i++) {
      try { clearTimeout(timers[i]); } catch (e) {}
      try { clearInterval(timers[i]); } catch (e) {}
    }
    timers.length = 0;
  }
  function report(extra) {
    try {
      if (BRIDGE && BRIDGE.onResult) {
        BRIDGE.onResult(JSON.stringify({
          token: TOKEN, url: location.href, target: targetDesc,
          submitted: submitted, finished: finished, extra: extra || null
        }));
      }
    } catch (e) {}
  }

  /* ---------------- DOM 工具 ---------------- */

  function realmOf(el) {
    try { if (el && el.ownerDocument && el.ownerDocument.defaultView) { return el.ownerDocument.defaultView; } } catch (e) {}
    return window;
  }

  // 递归收集所有“同源可访问”的 window（主框架 + iframe）
  function collectWindows(root, out, depth) {
    out = out || [];
    depth = depth || 0;
    try { if (!root.document) { return out; } } catch (e) { return out; }
    out.push(root);
    if (depth >= 4) { return out; }
    var n = 0;
    try { n = root.frames.length; } catch (e) { n = 0; }
    for (var i = 0; i < n; i++) {
      try { collectWindows(root.frames[i], out, depth + 1); } catch (e) {}
    }
    return out;
  }

  // 包含 shadowRoot 的全量元素遍历
  function deepElements(doc, filter) {
    var res = [];
    function walk(root, level) {
      if (level > 5 || res.length > 3000) { return; }
      var list = null;
      try { list = root.querySelectorAll(filter || '*'); } catch (e) { return; }
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        res.push(el);
        if (el.shadowRoot) { walk(el.shadowRoot, level + 1); }
      }
    }
    walk(doc, 0);
    return res;
  }

  function isVisible(el) {
    try {
      if (!el || !el.ownerDocument || el.nodeType !== 1) { return false; }
      if (el.disabled) { return false; }
      var t = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      if (t === 'hidden') { return false; }
      var w = realmOf(el);
      var gcs = w.getComputedStyle ? w.getComputedStyle(el) : null;
      if (gcs) {
        if (gcs.display === 'none' || gcs.visibility === 'hidden') { return false; }
        if (gcs.opacity !== '' && parseFloat(gcs.opacity) === 0) { return false; }
      }
      if (el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) { return false; }
      }
      var p = el.parentNode;
      var up = 0;
      while (p && p.nodeType === 1 && up < 24) {
        var ps = w.getComputedStyle ? w.getComputedStyle(p) : null;
        if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) { return false; }
        p = p.parentNode;
        up++;
      }
      return true;
    } catch (e) { return false; }
  }

  function attrsOf(el) {
    var s = '';
    var names = ['name', 'id', 'placeholder', 'autocomplete', 'title', 'aria-label', 'data-role', 'data-field', 'class'];
    for (var i = 0; i < names.length; i++) {
      try {
        var v = el.getAttribute ? el.getAttribute(names[i]) : null;
        if (v) { s += ' ' + String(v).toLowerCase(); }
      } catch (e) {}
    }
    return s;
  }

  function textOf(el) {
    try {
      return String(el.textContent || el.innerText || el.value || '').toLowerCase().replace(/\s+/g, '');
    } catch (e) { return ''; }
  }

  function describe(el) {
    if (!el) { return 'null'; }
    try {
      var tag = (el.tagName || '?').toLowerCase();
      var parts = [tag];
      var names = ['type', 'name', 'id', 'placeholder'];
      for (var i = 0; i < names.length; i++) {
        var v = el.getAttribute ? el.getAttribute(names[i]) : null;
        if (v) { parts.push(names[i] + '=' + v); }
      }
      return '<' + parts.join(' ') + '>';
    } catch (e) { return '<element>'; }
  }

  function sharesAncestor(a, b, depth) {
    try {
      var mark = [];
      var p = a;
      for (var i = 0; i < depth && p; i++) { p = p.parentNode; if (p) { mark.push(p); } }
      var q = b;
      for (i = 0; i < depth && q; i++) {
        for (var j = 0; j < mark.length; j++) { if (mark[j] === q) { return true; } }
        q = q.parentNode;
        if (!q) { break; }
      }
    } catch (e) {}
    return false;
  }

  /* ---------------- 赋值 / 事件 ---------------- */

  // 取到元素所属 realm 中原生的 value setter，
  // 这样 React / Vue 等框架的受控组件才能感知到值变化。
  function nativeValueSetter(el) {
    var w = realmOf(el);
    var chain = [];
    try {
      if (w.HTMLInputElement && el instanceof w.HTMLInputElement) { chain.push(w.HTMLInputElement.prototype); }
      if (w.HTMLTextAreaElement && el instanceof w.HTMLTextAreaElement) { chain.push(w.HTMLTextAreaElement.prototype); }
      if (w.HTMLSelectElement && el instanceof w.HTMLSelectElement) { chain.push(w.HTMLSelectElement.prototype); }
    } catch (e) {}
    var proto = el;
    for (var i = 0; i < 8 && proto; i++) {
      proto = Object.getPrototypeOf(proto);
      if (!proto) { break; }
      chain.push(proto);
    }
    for (var j = 0; j < chain.length; j++) {
      try {
        var d = Object.getOwnPropertyDescriptor(chain[j], 'value');
        if (d && typeof d.set === 'function') { return d.set; }
      } catch (e) {}
    }
    return null;
  }

  function setValue(el, value) {
    if (!el) { return false; }
    var okFlag = false;
    try {
      var own = Object.getOwnPropertyDescriptor(el, 'value');
      if (own && typeof own.writable !== 'undefined') {
        el.value = value;
        okFlag = (el.value === value);
      }
    } catch (e) {}
    if (!okFlag) {
      var setter = nativeValueSetter(el);
      if (setter) {
        try { setter.call(el, value); okFlag = (el.value === value); } catch (e) {}
      }
    }
    if (!okFlag) {
      try { el.value = value; okFlag = (el.value === value); } catch (e) {}
    }
    if (!okFlag) {
      try { el.setAttribute('value', value); okFlag = (el.value === value); } catch (e) {}
    }
    return okFlag;
  }

  function makeEvent(el, type, ctorName, init) {
    var w = realmOf(el);
    var doc = w.document || document;
    var opt = init || { bubbles: true, cancelable: true };
    var names = [ctorName, 'Event'];
    for (var i = 0; i < names.length; i++) {
      try {
        var Ctor = names[i] ? w[names[i]] : null;
        if (Ctor) { return new Ctor(type, opt); }
      } catch (e) {}
    }
    try {
      var ev = doc.createEvent(ctorName === 'KeyboardEvent' ? 'KeyboardEvent' : 'HTMLEvents');
      ev.initEvent(type, true, true);
      return ev;
    } catch (e) {}
    try {
      var ev2 = doc.createEvent('HTMLEvents');
      ev2.initEvent(type, true, true);
      return ev2;
    } catch (e) {}
    return null;
  }

  function fire(el, type, ctorName, init) {
    if (!el) { return; }
    var ev = makeEvent(el, type, ctorName, init);
    if (!ev) { return; }
    try { el.dispatchEvent(ev); } catch (e) {}
  }

  // 模拟真人输入：聚焦 -> 清空 -> 逐字符 keydown/input/keyup -> change -> blur
  function typeInto(el, value) {
    if (!el) { return false; }
    try { el.removeAttribute('readonly'); } catch (e) {}
    try { if (el.readOnly) { el.readOnly = false; } } catch (e) {}
    try { if (el.disabled) { el.disabled = false; } } catch (e) {}

    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    fire(el, 'focus', 'FocusEvent', { bubbles: false, cancelable: false });
    fire(el, 'focusin', 'FocusEvent', { bubbles: true, cancelable: false });

    setValue(el, '');
    fire(el, 'input', 'InputEvent', { bubbles: true, cancelable: false, inputType: 'deleteContentBackward' });

    var typed = false;
    if (value.length > 0 && value.length <= 128) {
      typed = true;
      for (var i = 0; i < value.length; i++) {
        var ch = value.charAt(i);
        fire(el, 'keydown', 'KeyboardEvent', { bubbles: true, cancelable: true, key: ch, code: 'Key' + ch.toUpperCase(), charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0) });
        fire(el, 'keypress', 'KeyboardEvent', { bubbles: true, cancelable: true, key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0) });
        setValue(el, value.substring(0, i + 1));
        fire(el, 'input', 'InputEvent', { bubbles: true, cancelable: false, inputType: 'insertText', data: ch });
        fire(el, 'keyup', 'KeyboardEvent', { bubbles: true, cancelable: true, key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0) });
      }
    }

    if (!typed || el.value !== value) {
      setValue(el, value);
      fire(el, 'input', 'InputEvent', { bubbles: true, cancelable: false, inputType: 'insertText', data: value });
    }

    fire(el, 'change', 'Event', { bubbles: true, cancelable: false });
    fire(el, 'blur', 'FocusEvent', { bubbles: false, cancelable: false });
    fire(el, 'focusout', 'FocusEvent', { bubbles: true, cancelable: false });

    var actual = '';
    try { actual = el.value; } catch (e) {}
    return actual === value;
  }

  function hideKeyboard() {
    try {
      var ae = document.activeElement;
      if (ae && ae.blur) { ae.blur(); }
    } catch (e) {}
  }

  /* ---------------- 控件识别 ---------------- */

  var USER_HINTS = ['ddddd', 'username', 'user_name', 'loginname', 'login_name', 'account', 'uname', 'userid',
    'user_id', 'user', 'stuno', 'stu_no', 'studentno', 'studentid', 'xuehao', 'gzh', 'jgh', 'mobile',
    'phone', 'tel', 'loginid', 'uid', 'no'];
  var USER_TEXT = ['账号', '帐号', '用户名', '学号', '工号', '手机', '用户', 'account', 'username', 'user', 'phone', 'mobile', 'login'];
  var BAD_HINTS = ['password', 'passwd', 'upass', 'pwd', 'captcha', 'verifycode', 'verify_code', 'checkcode',
    'validatecode', 'vcode', 'authcode', 'smscode', 'otp', 'dynamic', '验证码', '密码', '动态'];
  var SUBMIT_ATTR_RE = /0mkkey|login|logon|submit|signin|denglu|btn_?ok/;
  var SUBMIT_TEXT_RE = /^(登录|登陆|登\s*录|立即登录|login|logon|signin|sign-in|连接|认证|确定)$/;
  var SUBMIT_LOOSE_RE = /(登录|登陆|login|logon|signin)/;
  var NEGATIVE_RE = /(重置|reset|注册|register|取消|cancel|返回|back|忘记密码|forget)/;

  function scoreUserField(el) {
    var s = 0;
    var a = attrsOf(el);
    var i;
    for (i = 0; i < USER_HINTS.length; i++) {
      if (a.indexOf(USER_HINTS[i]) !== -1) { s += 140 - i; break; }
    }
    for (i = 0; i < USER_TEXT.length; i++) {
      if (a.indexOf(USER_TEXT[i]) !== -1) { s += 60 - i; break; }
    }
    for (i = 0; i < BAD_HINTS.length; i++) {
      if (a.indexOf(BAD_HINTS[i]) !== -1) { s -= 800; break; }
    }
    var t = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
    if (t === 'text' || t === '') { s += 25; }
    else if (t === 'email' || t === 'tel') { s += 20; }
    else if (t === 'number') { s += 8; }
    if (el.readOnly) { s -= 600; }
    try { if (el.maxLength > 0 && el.maxLength <= 6) { s -= 250; } } catch (e) {}
    s += isVisible(el) ? 100 : -2000;
    return s;
  }

  function pickSubmit(cands, form) {
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var sc = 0;
      var tag = '';
      try { tag = el.tagName.toLowerCase(); } catch (e) { continue; }
      var t = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      var a = attrsOf(el);
      var txt = textOf(el);
      if (t === 'submit') { sc += 220; }
      if (tag === 'button') { sc += 130; }
      if (t === 'button' || t === 'image') { sc += 90; }
      if (form && el.form === form) { sc += 180; }
      if (SUBMIT_ATTR_RE.test(a)) { sc += 110; }
      if (SUBMIT_TEXT_RE.test(txt)) { sc += 170; }
      else if (SUBMIT_LOOSE_RE.test(txt)) { sc += 70; }
      if (NEGATIVE_RE.test(txt + ' ' + a)) { sc -= 900; }
      if (!el.getAttribute || (!el.getAttribute('onclick') && tag !== 'button' && tag !== 'input' && t !== 'submit')) { sc -= 40; }
      sc += isVisible(el) ? 100 : -2000;
      sc -= i * 0.5;
      if (sc > bestScore) { bestScore = sc; best = el; }
    }
    return best;
  }

  function findControls(wins) {
    var best = null;
    for (var wi = 0; wi < wins.length; wi++) {
      var doc = null;
      try { doc = wins[wi].document; } catch (e) { continue; }
      if (!doc) { continue; }

      var els = deepElements(doc, 'input,textarea,button,a,select');
      var passwords = [];
      var texts = [];
      var submits = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var tag = '';
        try { tag = el.tagName.toLowerCase(); } catch (e) { continue; }
        var t = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
        if (tag === 'input') {
          if (t === 'password') { passwords.push(el); }
          else if (t === 'submit' || t === 'button' || t === 'image') { submits.push(el); }
          else if (t === 'text' || t === 'email' || t === 'tel' || t === 'number' || t === 'search' || t === '') { texts.push(el); }
        } else if (tag === 'textarea') {
          texts.push(el);
        } else if (tag === 'button') {
          submits.push(el);
        } else if (tag === 'a') {
          var atxt = textOf(el);
          if (atxt && atxt.length <= 14 && SUBMIT_LOOSE_RE.test(atxt)) { submits.push(el); }
        }
      }
      if (!passwords.length) { continue; }

      var pw = null;
      var pwScore = -Infinity;
      for (var k = 0; k < passwords.length; k++) {
        var ps = (isVisible(passwords[k]) ? 200 : -2000) - k;
        if (ps > pwScore) { pwScore = ps; pw = passwords[k]; }
      }
      if (!pw) { continue; }

      var form = null;
      try { form = pw.form || null; } catch (e) {}

      var u = null;
      var uScore = -Infinity;
      for (var n = 0; n < texts.length; n++) {
        var cand = texts[n];
        var sc = scoreUserField(cand);
        try { if (form && cand.form === form) { sc += 400; } } catch (e) {}
        if (sharesAncestor(cand, pw, 8)) { sc += 150; }
        sc -= n * 0.5;
        if (sc > uScore) { uScore = sc; u = cand; }
      }
      if (!u) { continue; }

      var scopeForm = form;
      if (!scopeForm) { try { scopeForm = u.form || null; } catch (e) {} }
      var btn = pickSubmit(submits, scopeForm);

      var candResult = { win: wins[wi], doc: doc, u: u, p: pw, btn: btn, form: scopeForm, score: uScore };
      if (!best || candResult.score > best.score) {
        // 优先选择“账号框可见”的那一组
        if (!best || isVisible(u)) { best = candResult; }
      }
      if (best && isVisible(best.u) && isVisible(best.p)) { break; }
    }
    return best;
  }

  // 有些门户默认停在“短信登录 / 动态密码”页签，需要先切回账号密码登录
  function activateAccountTab(wins) {
    var clicked = false;
    var re = /^(账号登录|帐号登录|用户名登录|普通登录|密码登录|账号密码|account|accountlogin)$/;
    for (var i = 0; i < wins.length; i++) {
      var doc = null;
      try { doc = wins[i].document; } catch (e) { continue; }
      if (!doc) { continue; }
      var els = [];
      try { els = doc.querySelectorAll('a,li,span,div,button,label'); } catch (e) { continue; }
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        try { if (el.childElementCount > 2) { continue; } } catch (e) {}
        var txt = textOf(el);
        if (!txt || txt.length > 8) { continue; }
        if (re.test(txt) && isVisible(el)) {
          try { el.click(); clicked = true; info('已切换到「' + txt + '」登录方式'); } catch (e) {}
        }
      }
    }
    return clicked;
  }

  /* ---------------- 运营商 (CMCC) 选择 ---------------- */

  var CMCC_RE = /cmcc|中国移动|移动|chinamobile/i;
  var CMCC_TEXT_RE = /^(中国移动|移动|cmcc|@cmcc)$/;
  var ISP_FIELD_RE = /isp|operator|net_?type|serv_?type|domain|suffix/i;

  function labelText(el) {
    try {
      if (el.id && el.ownerDocument && el.ownerDocument.querySelector) {
        var lb = el.ownerDocument.querySelector('label[for="' + String(el.id).replace(/"/g, '') + '"]');
        if (lb) { return textOf(lb); }
      }
      var p = el.parentNode;
      for (var i = 0; i < 3 && p; i++) {
        if (p.nodeType === 1 && p.tagName && p.tagName.toLowerCase() === 'label') { return textOf(p); }
        p = p.parentNode;
      }
      var nx = el.nextSibling;
      for (var j = 0; j < 4 && nx; j++) {
        if (nx.nodeType === 1 && nx.tagName && /^(span|label|em|i|b|small)$/.test(nx.tagName.toLowerCase())) { return textOf(nx); }
        nx = nx.nextSibling;
      }
    } catch (e) {}
    return '';
  }

  function selectIsp(wins) {
    var hit = false;
    var clickables = [];
    for (var i = 0; i < wins.length; i++) {
      var doc = null;
      try { doc = wins[i].document; } catch (e) { continue; }
      if (!doc) { continue; }
      var els = deepElements(doc, 'select,input,a,li,span,label,button,div');
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        var tag = '';
        try { tag = el.tagName.toLowerCase(); } catch (e) { continue; }
        try {
          if (tag === 'select') {
            var opts = el.options || [];
            for (var k = 0; k < opts.length; k++) {
              var o = opts[k];
              var s = String(o.value || '') + ' ' + String(o.text || '');
              if (CMCC_RE.test(s)) {
                if (String(el.value) !== String(o.value)) {
                  try { el.selectedIndex = k; } catch (e) {}
                  setValue(el, o.value);
                  fire(el, 'input', 'InputEvent', { bubbles: true, cancelable: false });
                  fire(el, 'change', 'Event', { bubbles: true, cancelable: false });
                  info('运营商下拉框已选择: ' + (o.text || o.value));
                }
                hit = true;
                break;
              }
            }
          } else if (tag === 'input') {
            var t = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
            if (t === 'radio' || t === 'checkbox') {
              var meta = attrsOf(el) + ' ' + labelText(el);
              if (CMCC_RE.test(meta)) {
                if (!el.checked) { try { el.click(); } catch (e) {} }
                if (!el.checked) { try { el.checked = true; } catch (e) {} fire(el, 'change', 'Event', { bubbles: true, cancelable: false }); }
                info('运营商选项已勾选: ' + describe(el));
                hit = true;
              }
            } else if (t === 'hidden') {
              var nm = String((el.getAttribute && el.getAttribute('name')) || '') + ' ' + String(el.id || '');
              if (ISP_FIELD_RE.test(nm)) {
                var want = ISP || String(el.value || '') || '@cmcc';
                setValue(el, want);
                fire(el, 'change', 'Event', { bubbles: true, cancelable: false });
                info('运营商隐藏域 ' + nm.replace(/^\s+|\s+$/g, '') + ' = ' + want);
                hit = true;
              }
            }
          } else if (tag === 'a' || tag === 'li' || tag === 'span' || tag === 'label' || tag === 'button' || tag === 'div') {
            try { if (el.childElementCount > 1) { continue; } } catch (e) {}
            var txt = textOf(el);
            if (txt && txt.length <= 6 && CMCC_TEXT_RE.test(txt) && isVisible(el)) { clickables.push({ el: el, txt: txt }); }
          }
        } catch (e) {}
      }
    }
    if (!hit && clickables.length) {
      for (var c = 0; c < clickables.length; c++) {
        try { clickables[c].el.click(); info('点击运营商选项: ' + clickables[c].txt); hit = true; break; } catch (e) {}
      }
    }
    return hit;
  }

  /* ---------------- 主流程 ---------------- */

  function fullUsername() {
    if (!ISP) { return USER; }
    if (USER.indexOf(ISP) !== -1) { return USER; }
    return USER + ISP;
  }

  function doFill(c) {
    var want = fullUsername();
    fillTries++;

    var okU = typeInto(c.u, want);
    var okP = typeInto(c.p, PASS);

    var realU = '';
    var realP = '';
    try { realU = c.u.value; } catch (e) {}
    try { realP = c.p.value; } catch (e) {}

    targetDesc = describe(c.u) + ' + ' + describe(c.p);

    if (realU === want && realP === PASS) {
      good('填充成功: 账号="' + realU + '", 密码长度=' + realP.length + (okU && okP ? '' : ' (事件兼容模式)'));
    } else {
      warn('填充校验不一致: 账号="' + realU + '" (期望 "' + want + '"), 密码长度=' + realP.length + '/' + PASS.length);
    }
    report({ step: 'fill', user: realU, passLen: realP.length, ok: (realU === want && realP === PASS) });
    return (realU === want && realP === PASS);
  }

  function guard(c, tries) {
    if (stale() || finished) { return; }
    var want = fullUsername();
    var fresh = findControls(collectWindows(window)) || c;
    var realU = '';
    var realP = '';
    try { realU = fresh.u.value; } catch (e) {}
    try { realP = fresh.p.value; } catch (e) {}

    if (realU !== want || realP !== PASS) {
      if (tries < MAX_FILL_TRIES) {
        warn('输入框被页面脚本重置，第 ' + (tries + 1) + ' 次重新填充');
        doFill(fresh);
        later(function () { guard(fresh, tries + 1); }, 350);
      } else {
        warn('连续 ' + MAX_FILL_TRIES + ' 次重填仍被清空，停止填充。请把调试日志截图反馈。');
        finish(false);
      }
      return;
    }

    if (!AUTO_SUBMIT) {
      good('已填充完成，未开启自动登录，请手动点击登录按钮');
      finish(true);
      return;
    }
    later(function () { doSubmit(fresh); }, 450);
  }

  function doSubmit(c) {
    if (submitted || stale()) { return; }
    submitted = true;
    var fresh = findControls(collectWindows(window)) || c;
    var urlBefore = location.href;
    sawSubmitEvent = false;
    mutationCount = 0;

    if (fresh.btn) {
      info('点击登录按钮: ' + describe(fresh.btn));
      try { fresh.btn.focus(); } catch (e) {}
      try { fresh.btn.click(); } catch (e) { warn('btn.click() 异常: ' + e.message); }
    } else if (fresh.form) {
      info('未找到登录按钮，尝试提交表单');
      try {
        if (fresh.form.requestSubmit) { fresh.form.requestSubmit(); } else { fresh.form.submit(); }
      } catch (e) { warn('表单提交异常: ' + e.message); }
    } else {
      info('未找到按钮/表单，尝试回车提交');
      var opt = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
      fire(fresh.p, 'keydown', 'KeyboardEvent', opt);
      fire(fresh.p, 'keypress', 'KeyboardEvent', opt);
      fire(fresh.p, 'keyup', 'KeyboardEvent', opt);
    }

    later(function () {
      hideKeyboard();
      if (location.href !== urlBefore) {
        good('登录请求已发出（页面跳转）');
      } else if (sawSubmitEvent || mutationCount > 0) {
        good('登录请求已发出（页面响应: submit=' + sawSubmitEvent + ', DOM 变化=' + mutationCount + '）');
      } else {
        var again = findControls(collectWindows(window));
        if (again && again.form) {
          warn('点击登录后页面毫无反应，改为直接提交表单');
          try {
            if (again.form.requestSubmit) { again.form.requestSubmit(); } else { again.form.submit(); }
          } catch (e) {}
        } else {
          warn('点击登录后页面毫无反应，且没有可提交的表单');
        }
      }
      report({ step: 'submit', url: location.href });
      finish(true);
    }, 1500);
  }

  function finish(success) {
    if (finished) { return; }
    finished = true;
    stopAll();
    if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
    report({ step: 'done', ok: success });
  }

  // 监听 submit 事件与 DOM 变化，用来判断“点击登录按钮是否真的生效了”
  function watchDocs(wins) {
    for (var i = 0; i < wins.length; i++) {
      var doc = null;
      try { doc = wins[i].document; } catch (e) { continue; }
      if (!doc) { continue; }
      try {
        if (!doc.__ecutSubmitWatch) {
          doc.addEventListener('submit', function () { sawSubmitEvent = true; }, true);
          try { Object.defineProperty(doc, '__ecutSubmitWatch', { value: true, configurable: true }); } catch (e) {}
        }
      } catch (e) {}
    }
    if (!mo) {
      try {
        mo = new MutationObserver(function (muts) { mutationCount += muts.length; });
        mo.observe(document.documentElement || document.body || document,
          { childList: true, subtree: true, attributes: true, characterData: true });
      } catch (e) { mo = null; }
    }
  }

  var poller = null;
  function stopPoller() {
    if (poller !== null) { try { clearInterval(poller); } catch (e) {} poller = null; }
  }

  function attempt() {
    if (stale() || finished || located) { stopPoller(); return; }
    polls++;

    if (polls === MAX_POLLS) {
      stopPoller();
      info('快速探测结束仍未找到输入框，转入慢速探测');
      poller = every(attempt, 1000);
    }
    if (polls > MAX_POLLS + SLOW_POLLS) {
      warn('探测超时：页面上找不到「文本框 + 密码框」组合。请点击调试面板里的「页面诊断」把结果发出来。');
      stopPoller();
      finish(false);
      return;
    }

    var wins = collectWindows(window);
    if (polls === 1) {
      info('脚本已注入: ' + location.href + ' (可访问框架数 ' + wins.length + ')');
      activateAccountTab(wins);
    }

    var c = findControls(wins);
    if (!c) {
      if (polls % 10 === 0) { info('第 ' + polls + ' 次探测：仍未找到账号/密码输入框'); }
      return;
    }

    stopPoller();
    located = true;
    watchDocs(wins);
    info('已定位登录表单 -> 账号框 ' + describe(c.u) + ' | 密码框 ' + describe(c.p) + ' | 按钮 ' + describe(c.btn));

    var ispHit = selectIsp(wins);
    if (!ispHit) {
      info('未发现运营商选择控件' + (ISP ? '，将使用账号后缀 ' + ISP : ''));
    }

    // 运营商切换可能导致 DOM 重建，稍等后重新定位最新节点再填充
    later(function () {
      var fresh = findControls(collectWindows(window)) || c;
      doFill(fresh);
      later(function () { guard(fresh, 0); }, 350);
    }, ispHit ? 450 : 120);
  }

  /* ---------------- 对外 API / 启动 ---------------- */


  // 标记本次注入；同一页面重复注入时，旧的一轮探测会因 token 变化自动失效
  window.__ecutToken = TOKEN;

  var prev = null;
  try { prev = window.__ecutApi || null; } catch (e) {}
  if (prev) {
    try { if (prev.stop) { prev.stop(); } } catch (e) {}
    try {
      if (prev.submitted && prev.url === location.href) {
        AUTO_SUBMIT = false;
        info('同一页面此前已提交过登录，本次只填充不再自动提交');
      }
    } catch (e) {}
  }

  var API = {
    token: TOKEN,
    url: location.href,
    submitted: false,
    finished: false,
    target: '',
    stop: function () { finished = true; stopPoller(); stopAll(); },
    run: attempt,
    fillNow: function () {
      var c = findControls(collectWindows(window));
      if (!c) { warn('手动填充失败：找不到输入框'); return false; }
      var r = doFill(c);
      later(function () { guard(c, 0); }, 350);
      return r;
    }
  };
  window.__ecutApi = API;

  // 让 report / guard 等能同步状态到 API
  var _finish = finish;
  finish = function (success) { API.finished = true; _finish(success); };
  var _submit = doSubmit;
  doSubmit = function (c) { API.submitted = true; _submit(c); };
  var _fill = doFill;
  doFill = function (c) { var r = _fill(c); API.target = targetDesc; return r; };

  attempt();
  if (!finished && !located && poller === null) { poller = every(attempt, POLL_MS); }

  return JSON.stringify({ started: true, token: TOKEN, url: location.href, user: USER, passLen: PASS.length, isp: ISP, autoSubmit: AUTO_SUBMIT });
})();
