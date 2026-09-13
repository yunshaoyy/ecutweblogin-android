/*!
 * 页面诊断脚本：把当前页面（含同源 iframe / shadowRoot）里所有可能与登录相关的
 * 控件信息收集出来，返回 JSON 字符串，便于排查“填不进去”的原因。
 */
(function () {
  'use strict';

  function realmOf(el) {
    try { if (el && el.ownerDocument && el.ownerDocument.defaultView) { return el.ownerDocument.defaultView; } } catch (e) {}
    return window;
  }

  function collectWindows(root, out, depth) {
    out = out || []; depth = depth || 0;
    try { if (!root.document) { return out; } } catch (e) { return out; }
    out.push(root);
    if (depth >= 4) { return out; }
    var n = 0;
    try { n = root.frames.length; } catch (e) {}
    for (var i = 0; i < n; i++) { try { collectWindows(root.frames[i], out, depth + 1); } catch (e) {} }
    return out;
  }

  function deep(doc, sel) {
    var res = [];
    function walk(root, level) {
      if (level > 4 || res.length > 1500) { return; }
      var list = null;
      try { list = root.querySelectorAll(sel); } catch (e) { return; }
      for (var i = 0; i < list.length; i++) {
        res.push(list[i]);
        if (list[i].shadowRoot) { walk(list[i].shadowRoot, level + 1); }
      }
    }
    walk(doc, 0);
    return res;
  }

  function visible(el) {
    try {
      var w = realmOf(el);
      var gcs = w.getComputedStyle ? w.getComputedStyle(el) : null;
      if (gcs && (gcs.display === 'none' || gcs.visibility === 'hidden')) { return false; }
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && (r.width <= 1 || r.height <= 1)) { return false; }
      return true;
    } catch (e) { return false; }
  }

  function attrs(el, names) {
    var o = {};
    for (var i = 0; i < names.length; i++) {
      try { var v = el.getAttribute ? el.getAttribute(names[i]) : null; if (v) { o[names[i]] = String(v).substring(0, 60); } } catch (e) {}
    }
    return o;
  }

  var out = { url: location.href, title: document.title, ready: document.readyState, frames: [], forms: [], fields: [], buttons: [], selects: [], crossOriginFrames: 0 };

  var wins = collectWindows(window);
  out.frames = wins.length;
  try {
    var ifr = document.querySelectorAll('iframe,frame');
    for (var f = 0; f < ifr.length; f++) {
      var ok2 = true;
      try { var d = ifr[f].contentWindow.document; if (!d) { ok2 = false; } } catch (e) { ok2 = false; }
      if (!ok2) { out.crossOriginFrames++; }
    }
  } catch (e) {}

  for (var wi = 0; wi < wins.length; wi++) {
    var doc = null;
    try { doc = wins[wi].document; } catch (e) { continue; }
    if (!doc) { continue; }
    var tag = wi === 0 ? 'main' : 'frame' + wi;

    var forms = deep(doc, 'form');
    for (var i = 0; i < forms.length && out.forms.length < 20; i++) {
      out.forms.push({
        frame: tag, name: forms[i].getAttribute('name') || '', id: forms[i].id || '',
        action: forms[i].getAttribute('action') || '', method: forms[i].getAttribute('method') || '',
        visible: visible(forms[i])
      });
    }

    var fields = deep(doc, 'input,textarea');
    for (var j = 0; j < fields.length && out.fields.length < 80; j++) {
      var el = fields[j];
      var info = { frame: tag, tag: el.tagName.toLowerCase() };
      var a = attrs(el, ['type', 'name', 'id', 'placeholder', 'autocomplete', 'maxlength', 'value', 'class']);
      for (var k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) { info[k] = a[k]; } }
      if (info.value) { info.value = '(len ' + String(el.value || '').length + ')'; }
      info.visible = visible(el);
      try { info.readOnly = !!el.readOnly; info.disabled = !!el.disabled; info.formName = el.form ? (el.form.getAttribute('name') || el.form.id || '?') : null; } catch (e) {}
      out.fields.push(info);
    }

    var btns = deep(doc, 'button,input[type=submit],input[type=button],input[type=image],a');
    for (var b = 0; b < btns.length && out.buttons.length < 60; b++) {
      var be = btns[b];
      var bt = '';
      try { bt = String(be.textContent || be.value || '').replace(/\s+/g, ' ').substring(0, 30); } catch (e) {}
      var ba = attrs(be, ['type', 'id', 'name', 'class', 'onclick', 'value']);
      if (!bt && !ba.id && !ba.name && !ba.onclick && !ba['class']) { continue; }
      var rec = { frame: tag, tag: be.tagName.toLowerCase(), text: bt, visible: visible(be) };
      for (var kk in ba) { if (Object.prototype.hasOwnProperty.call(ba, kk)) { rec[kk] = String(ba[kk]).substring(0, 60); } }
      out.buttons.push(rec);
    }

    var sels = deep(doc, 'select');
    for (var s = 0; s < sels.length && out.selects.length < 20; s++) {
      var se = sels[s];
      var opts = [];
      try { for (var o = 0; o < se.options.length && o < 30; o++) { opts.push({ v: String(se.options[o].value), t: String(se.options[o].text) }); } } catch (e) {}
      out.selects.push({ frame: tag, name: se.getAttribute('name') || '', id: se.id || '', visible: visible(se), value: String(se.value || ''), options: opts });
    }
  }

  return JSON.stringify(out);
})();
