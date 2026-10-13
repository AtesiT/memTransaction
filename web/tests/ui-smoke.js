/*
 * ui-smoke.js — проверка интерфейса без браузера.
 * ===========================================================================
 * Подставляем минимальную заглушку DOM и выполняем app.js ровно так, как это
 * сделал бы браузер: строим панели, нажимаем «Запустить», ждём пару секунд и
 * проверяем, что показатели и счета обновляются, а инвариант держится.
 *
 * Это ловит ошибки связывания интерфейса с движком (опечатки в id, неверные
 * вызовы методов), которые иначе всплыли бы только в браузере.
 *
 * Запуск:  node tests/ui-smoke.js
 * ===========================================================================
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function makeClassList(el) {
  var set = new Set();
  return {
    add: function (c) { set.add(c); },
    remove: function (c) { set.delete(c); },
    contains: function (c) { return set.has(c); },
    toggle: function (c, on) {
      if (on === undefined) { if (set.has(c)) set.delete(c); else set.add(c); }
      else if (on) set.add(c); else set.delete(c);
    },
    _set: set
  };
}

function makeElement(id, tag) {
  var el = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    _html: '',
    value: '0',
    checked: true,
    childNodes: [],
    style: {},
    dataset: {},
    attrs: {},
    handlers: {},
    classList: null,
    appendChild: function (c) { this.childNodes.push(c); return c; },
    insertBefore: function (c) { this.childNodes.unshift(c); return c; },
    removeChild: function (c) {
      var i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      return c;
    },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    getAttribute: function (k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; },
    addEventListener: function (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    dispatch: function (ev) { (this.handlers[ev] || []).forEach(function (f) { f.call(this, { preventDefault: function () {}, target: this }); }, this); },
    click: function () { this.dispatch('click'); },
    getBoundingClientRect: function () { return { width: 900, height: 260 }; },
    getContext: function () {
      var noop = function () {};
      return {
        clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, moveTo: noop,
        lineTo: noop, stroke: noop, fillText: noop, setTransform: noop,
        strokeStyle: '', fillStyle: '', font: '', lineWidth: 1
      };
    },
    set width(v) { this.attrs.width = v; },
    get width() { return Number(this.attrs.width) || 900; },
    set height(v) { this.attrs.height = v; },
    get height() { return Number(this.attrs.height) || 260; }
  };
  el.classList = makeClassList(el);
  // как в браузере: присваивание innerHTML = '' удаляет дочерние узлы
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return this._html; },
    set: function (v) { this._html = String(v); this.childNodes.length = 0; }
  });
  return el;
}

function makeDom() {
  var registry = new Map();
  var queryGroups = {};

  function byId(id) {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  }

  var tabs = ['demo1', 'demo2', 'theory', 'code', 'tests'].map(function (name) {
    var t = makeElement('tab-' + name, 'button');
    t.setAttribute('data-tab', name);
    return t;
  });
  queryGroups['.tab'] = tabs;
  queryGroups['.tabpane'] = ['demo1', 'demo2', 'theory', 'code', 'tests'].map(function (n) { return byId('pane-' + n); });

  var doc = {
    readyState: 'complete',
    body: makeElement('body'),
    documentElement: makeElement('html'),
    getElementById: byId,
    createElement: function (tag) { return makeElement('', tag); },
    querySelectorAll: function (sel) { return queryGroups[sel] || []; },
    addEventListener: function () {}
  };
  doc._byId = byId;
  return doc;
}

// ---------------------------------------------------------------------------
var WEB = path.join(__dirname, '..');
var document = makeDom();

var sandbox = {
  console: console,
  document: document,
  performance: { now: function () { return Date.now(); } },
  requestAnimationFrame: function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); },
  setInterval: setInterval,
  setTimeout: setTimeout,
  clearInterval: clearInterval,
  clearTimeout: clearTimeout,
  Intl: Intl, Math: Math, Date: Date, JSON: JSON, Number: Number, String: String,
  Array: Array, Object: Object, Set: Set, Map: Map, Error: Error, isNaN: isNaN, isFinite: isFinite,
  isSecureContext: true,
  devicePixelRatio: 1,
  addEventListener: function () {}
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);

['tm-core.js', 'sim-engine.js', 'runner.js', 'timeline.js', 'app.js'].forEach(function (f) {
  var code = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
});
console.log('модули загружены: TMCore=' + !!sandbox.TMCore + ', SimEngine=' + !!sandbox.SimEngine +
  ', Runner=' + !!sandbox.Runner + ', Timeline=' + !!sandbox.Timeline);

// --- 1. Нажимаем «Запустить» -------------------------------------------------
var btnStart = document._byId('btn-start');
btnStart.dispatch('click');

setTimeout(function () {
  var ops = document._byId('m-ops').textContent;
  var commits = document._byId('m-commits').textContent;
  var invClass = document._byId('invariant').className;
  var invText = document._byId('inv-body').innerHTML;
  var bal = document._byId('bal-0').textContent;
  var modeBadge = document._byId('mode-badge').textContent;
  var logCount = document._byId('events').childNodes.length;
  var workersCards = document._byId('workers-grid').childNodes.length;
  var journalRows = (String(document._byId('journal-body').innerHTML).match(/<tr/g) || []).length;

  console.log('\n--- через 2.5 секунды работы ---');
  console.log('  режим:', modeBadge);
  console.log('  операций:', ops, '| коммитов:', commits);
  console.log('  счёт A:', bal);
  console.log('  инвариант:', invClass.indexOf('ok') >= 0 ? '✅ в норме' : '❌ ' + invClass);
  console.log('  строк в журнале событий:', logCount);
  console.log('  карточек потоков:', workersCards);
  console.log('  строк в журнале транзакции:', journalRows);
  console.log('  текст инварианта:', String(invText).replace(/<[^>]+>/g, ''));

  var ok = true;
  if (Number(String(ops).replace(/\s/g, '')) <= 0) { console.log('  ❌ операции не идут'); ok = false; }
  if (invClass.indexOf('ok') < 0) { console.log('  ❌ инвариант нарушен в STM-режиме'); ok = false; }
  if (workersCards !== 8) { console.log('  ❌ карточек потоков ' + workersCards + ' вместо 8'); ok = false; }
  if (journalRows === 0) { console.log('  ⚠️ журнал транзакции пуст (поток #0 мог быть в паузе)'); }

  // --- 2. Переключаем сценарий на «без синхронизации» ------------------------
  var chips = document._byId('technique-chips');
  console.log('\n--- переключаемся на «без синхронизации» ---');
  // чипы создаются динамически: ищем третий (unsafe)
  var unsafeChip = chips.childNodes[2];
  if (unsafeChip) {
    unsafeChip.dispatch('click');
    setTimeout(function () {
      var invClass2 = document._byId('invariant').className;
      var invText2 = String(document._byId('inv-body').innerHTML).replace(/<[^>]+>/g, '');
      console.log('  инвариант:', invClass2.indexOf('bad') >= 0 ? '✅ нарушился (как и должно быть без синхронизации)' : '⚠️ ' + invClass2);
      console.log('  текст:', invText2);

      // --- 3. Возвращаем STM и проверяем восстановление ---------------------
      var stmChip = chips.childNodes[0];
      stmChip.dispatch('click');
      setTimeout(function () {
        var invClass3 = document._byId('invariant').className;
        var invText3 = String(document._byId('inv-body').innerHTML).replace(/<[^>]+>/g, '');
        console.log('\n--- вернулись к STM-переводам ---');
        console.log('  инвариант:', invClass3.indexOf('ok') >= 0 ? '✅ снова в норме' : '❌ ' + invClass3);
        console.log('  текст:', invText3);

        // --- 4. Пауза и сброс -------------------------------------------------
        document._byId('btn-pause').dispatch('click');
        var paused = document._byId('btn-pause').textContent;
        document._byId('btn-reset').dispatch('click');
        var afterReset = document._byId('inv-body').textContent || document._byId('inv-body').innerHTML;
        console.log('\n--- пауза и сброс ---');
        console.log('  кнопка паузы:', paused);
        console.log('  после сброса:', String(afterReset).replace(/<[^>]+>/g, ''));
        console.log('\n' + (ok && invClass3.indexOf('ok') >= 0 ? '=== UI: проверка пройдена ✅ ===' : '=== UI: есть замечания ❌ ==='));
        process.exit(ok && invClass3.indexOf('ok') >= 0 ? 0 : 1);
      }, 2200);
    }, 1200);
  } else {
    console.log('  ❌ не найдены чипы сценариев');
    process.exit(1);
  }
}, 2500);
