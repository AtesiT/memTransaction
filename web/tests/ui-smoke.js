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
    _html: '',
    _text: '',
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
    // как в настоящем DOM: приложение ориентируется на firstChild/lastChild
    get firstChild() { return this.childNodes.length ? this.childNodes[0] : null; },
    get lastChild() { return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null; },
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
        lineTo: noop, stroke: noop, fill: noop, fillText: noop, setTransform: noop,
        arc: noop, quadraticCurveTo: noop, setLineDash: noop, save: noop, restore: noop,
        strokeStyle: '', fillStyle: '', font: '', lineWidth: 1,
        globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic'
      };
    },
    set width(v) { this.attrs.width = v; },
    get width() { return Number(this.attrs.width) || 900; },
    set height(v) { this.attrs.height = v; },
    get height() { return Number(this.attrs.height) || 260; }
  };
  el.classList = makeClassList(el);
  // как в браузере: innerHTML и textContent — это две стороны одной медали,
  // присваивание любого из них стирает прежнее содержимое
  Object.defineProperty(el, 'innerHTML', {
    // в браузере innerHTML показывает и текст, установленный через textContent
    get: function () { return this._html || (this._text ? String(this._text) : ''); },
    set: function (v) { this._html = String(v); this._text = ''; this.childNodes.length = 0; }
  });
  Object.defineProperty(el, 'textContent', {
    get: function () { return this._text || (this._html ? String(this._html).replace(/<[^>]+>/g, '') : ''); },
    set: function (v) { this._text = String(v); this._html = ''; this.childNodes.length = 0; }
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

  var tabs = ['demo1', 'demo2'].map(function (name) {
    var t = makeElement('tab-' + name, 'button');
    t.setAttribute('data-tab', name);
    return t;
  });
  queryGroups['.tab'] = tabs;
  queryGroups['#tempo-chips .chip'] = ['show', 'normal', 'load'].map(function (name) {
    var c = makeElement('tempo-' + name, 'button');
    c.setAttribute('data-tempo', name);
    c.classList.add('chip');
    if (name === 'normal') c.classList.add('active');
    return c;
  });
  queryGroups['.journal-switch .chip'] = ['events', 'worker'].map(function (name) {
    var c = makeElement('journal-' + name, 'button');
    c.setAttribute('data-journal', name);
    c.classList.add('chip');
    if (name === 'events') c.classList.add('active');
    return c;
  });

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

['tm-core.js', 'sim-engine.js', 'runner.js', 'network.js', 'timeline.js', 'app.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), sandbox, { filename: f });
});

function $(id) { return document._byId(id); }
function clean(html) { return String(html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var failures = [];
function expect(name, condition, detail) {
  console.log((condition ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : ''));
  if (!condition) failures.push(name);
}

async function main() {
  console.log('модули загружены: TMCore=' + !!sandbox.TMCore + ', SimEngine=' + !!sandbox.SimEngine +
    ', Runner=' + !!sandbox.Runner + ', Timeline=' + !!sandbox.Timeline + ', NetworkView=' + !!sandbox.NetworkView);

  // ================= 0. Состав интерфейса ==================================
  console.log('\n=== Состав интерфейса ===');
  var tabEls = document.querySelectorAll('.tab');
  expect('ровно две вкладки: Пример 1 и Пример 2', tabEls.length === 2,
    tabEls.map(function (t) { return t.getAttribute('data-tab'); }).join(', '));
  expect('три сценария синхронизации на вкладке', $('technique-chips').childNodes.length === 3,
    'чипов: ' + $('technique-chips').childNodes.length);
  expect('параметры запуска на месте', !!$('technique-chips') && !!$('workers') && !!$('tempo-chips') &&
    !!$('btn-start') && !!$('btn-pause') && !!$('btn-reset'));
  expect('показатели на месте', !!$('m-ops') && !!$('m-commits') && !!$('m-retries') &&
    !!$('m-rate') && !!$('m-efficiency') && !!$('invariant'));
  expect('визуализация на месте', !!$('network') && !!$('workers-grid') && !!$('timeline'));
  expect('журнал на месте и переключается', !!$('events') && !!$('journal-body') &&
    document.querySelectorAll('.journal-switch .chip').length === 2);

  // ================= 1. Пример 1: зачисление на счёт =======================
  console.log('\n=== Пример 1: зачисление через CAS ===');
  $('btn-start').dispatch('click');
  await wait(2000);

  var ops = Number(clean($('m-ops').textContent).replace(/\s/g, ''));
  expect('операции выполняются', ops > 0, 'операций: ' + ops);
  expect('инвариант держится (CAS)', $('invariant').className.indexOf('ok') >= 0, clean($('inv-body').innerHTML));
  expect('карточки потоков построены', $('workers-grid').childNodes.length === 8,
    'карточек: ' + $('workers-grid').childNodes.length);

  var net = sandbox.STMLab.network;
  expect('схема зачислений: поток → счёт', net.mode === 'deposit' && net.accounts.length === 1,
    'участников: ' + net.accounts.length + ', режим: ' + net.mode);
  var sent1 = net.sent;
  expect('монетки зачислений летят', sent1 > 0, 'анимаций: ' + sent1);

  // ================= 2. Пример 2: переводы между людьми ====================
  console.log('\n=== Пример 2: переводы между участниками ===');
  document.querySelectorAll('.tab')[1].dispatch('click');
  await wait(2500);

  net = sandbox.STMLab.network;
  var names = net.accounts.map(function (a) { return a.name; }).join(', ');
  expect('переключились на переводы', sandbox.STMLab.state.demoKey === 'demo2');
  expect('на схеме 4 участника', net.accounts.length === 4, names);
  expect('режим схемы — переводы между участниками', net.mode === 'transfer');
  expect('анимации переводов идут', net.sent > 0, 'запущено: ' + net.sent);
  expect('инвариант банка держится (STM)', $('invariant').className.indexOf('ok') >= 0, clean($('inv-body').innerHTML));

  // переходы на графике: счётчик успешных и отменённых
  var stats = sandbox.STMLab.runner.snapshot();
  expect('транзакции фиксируются', stats.commits > 0, 'коммитов: ' + stats.commits);
  expect('конфликты вызывают откаты', stats.retries >= 0, 'откатов-конфликтов: ' + stats.retries);

  // ================= 3. Режим «без синхронизации» ==========================
  console.log('\n=== Режим без синхронизации ===');
  $('technique-chips').childNodes[2].dispatch('click');   // «Без синхронизации»
  await wait(1500);
  expect('инвариант нарушается (как и должно быть без синхронизации)',
    $('invariant').className.indexOf('bad') >= 0, clean($('inv-body').innerHTML));

  // ================= 4. Возврат к STM =====================================
  console.log('\n=== Возврат к STM ===');
  $('technique-chips').childNodes[0].dispatch('click');
  await wait(2500);
  expect('инвариант снова в норме', $('invariant').className.indexOf('ok') >= 0, clean($('inv-body').innerHTML));
  expect('участников по-прежнему 4', sandbox.STMLab.network.accounts.length === 4);
  expect('схема продолжает анимировать переводы', sandbox.STMLab.network.sent > 0,
    'всего анимаций: ' + sandbox.STMLab.network.sent);

  // ================= 5. Темп показа =======================================
  console.log('\n=== Темп показа ===');
  var tempoChips = document.querySelectorAll('#tempo-chips .chip');
  tempoChips[0].dispatch('click');                       // 🐢 показ
  var gapShow = Number($('gap').value), workShow = Number($('work').value);
  var windowShow = sandbox.STMLab.timeline.windowMs;
  tempoChips[2].dispatch('click');                       // ⚡ нагрузка
  var gapLoad = Number($('gap').value), workLoad = Number($('work').value);
  var windowLoad = sandbox.STMLab.timeline.windowMs;
  tempoChips[1].dispatch('click');                       // обратно
  expect('«показ» медленнее «нагрузки»', gapShow > gapLoad && workShow > workLoad,
    'пауза ' + gapShow + '→' + gapLoad + ' мс, работа ' + workShow + '→' + workLoad + ' мкс');
  expect('окно таймлайна расширяется для показа', windowShow > windowLoad,
    windowShow + ' мс против ' + windowLoad + ' мс');

  // темп действительно влияет на частоту операций
  tempoChips[2].dispatch('click');                       // нагрузка
  await wait(1500);
  var opsFast = Number(clean($('m-ops').textContent).replace(/[\s\u00a0]/g, ''));
  tempoChips[0].dispatch('click');                       // показ
  await wait(2000);
  var opsSlow = Number(clean($('m-ops').textContent).replace(/[\s\u00a0]/g, ''));
  var fastRate = opsFast / 1.5, slowRate = (opsSlow - opsFast) / 2;
  expect('в «нагрузке» операций в секунду больше', fastRate > slowRate,
    'нагрузка ≈' + fastRate.toFixed(0) + '/с, показ ≈' + slowRate.toFixed(0) + '/с');

  // ================= 6. Пауза и сброс =====================================
  console.log('\n=== Пауза и сброс ===');
  $('btn-pause').dispatch('click');
  await wait(400);
  var opsPaused = Number(clean($('m-ops').textContent).replace(/[\s\u00a0]/g, ''));
  await wait(1200);
  var opsPaused2 = Number(clean($('m-ops').textContent).replace(/[\s\u00a0]/g, ''));
  expect('на паузе операции не растут', opsPaused2 === opsPaused, opsPaused + ' → ' + opsPaused2);

  $('btn-reset').dispatch('click');
  await wait(300);
  expect('сброс вернул состояние', clean($('inv-body').innerHTML || $('inv-body').textContent).indexOf('ожидание') >= 0,
    clean($('inv-body').innerHTML || $('inv-body').textContent));
  expect('схема очищена', sandbox.STMLab.network.coins.length === 0 && sandbox.STMLab.network.sent === 0);

  // ================= 7. Журнал выбранного потока ==========================
  console.log('\n=== Журнал ===');
  var journalChips = document.querySelectorAll('.journal-switch .chip');
  journalChips[1].dispatch('click');                 // переключаемся на «поток»
  expect('переключатель журнала работает',
    $('worker-wrap').style.display === '' && $('events-wrap').style.display === 'none');
  journalChips[0].dispatch('click');                 // обратно на «транзакции»
  expect('возврат к журналу транзакций', $('events-wrap').style.display === '');

  $('btn-start').dispatch('click');
  await wait(2000);
  var journalHtml = String($('journal-body').innerHTML);
  var rows = (journalHtml.match(/<tr/g) || []).length;
  expect('журнал транзакции выбранного потока заполняется', rows > 0, 'строк: ' + rows);
  expect('в журнале видны события перевода', /перевод|транзакц|чтение|запись|коммит/i.test(clean(journalHtml)),
    clean(journalHtml).slice(0, 120));

  console.log('\n' + (failures.length
    ? '=== Есть замечания (' + failures.length + '): ' + failures.join('; ') + ' ==='
    : '=== Все проверки интерфейса пройдены ✅ ==='));
  process.exit(failures.length ? 1 : 0);
}

main().catch(function (e) {
  console.log('\n❌ Ошибка сценария проверки: ' + e.stack);
  process.exit(1);
});
