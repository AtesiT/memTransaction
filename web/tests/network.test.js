/*
 * network.test.js — проверка схемы переводов (визуализация).
 * Запуск:  node tests/network.test.js
 * ===========================================================================
 * Что проверяем:
 *   1. Геометрия: узлы участников и точки потоков попадают в границы холста,
 *      без NaN — иначе на экране была бы «пустая» схема.
 *   2. Монетки: успешный перевод долетает, оставляет вспышку и снимает
 *      «в пути» (деньги прибавляются ровно в момент прилёта).
 *   3. Конфликт: монетка гаснет на полпути и НЕ меняет баланс получателя.
 *   4. Отказ «недостаточно средств»: гаснет у отправителя.
 *   5. Защита от перегрузки: при потоке операций анимации ограничиваются.
 * ===========================================================================
 */
'use strict';

var path = require('path');
var assert = require('assert');

// Минимальная заглушка canvas — схема рисует, но нам важно её состояние.
function fakeCanvas(w, h) {
  var noop = function () {};
  return {
    _attrs: { height: h || 380 },
    style: {},
    getAttribute: function (k) { return this._attrs[k]; },
    getBoundingClientRect: function () { return { width: w || 900, height: h || 380 }; },
    getContext: function () {
      return {
        clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, moveTo: noop,
        lineTo: noop, stroke: noop, fill: noop, fillText: noop, setTransform: noop,
        arc: noop, quadraticCurveTo: noop, setLineDash: noop,
        strokeStyle: '', fillStyle: '', font: '', lineWidth: 1,
        globalAlpha: 1, textAlign: 'left'
      };
    },
    set width(v) { this._attrs.width = v; },
    get width() { return this._attrs.width; },
    set height(v) { this._attrs.height = v; },
    get height() { return this._attrs.height; }
  };
}

var NetworkView = require(path.join(__dirname, '..', 'js', 'network.js'));
if (typeof NetworkView !== 'function') {
  // в Node модуль экспортируется иначе — подхватываем через общую загрузку
  var TM = require(path.join(__dirname, '..', 'js', 'tm-core.js'));
  var sandbox = { Intl: Intl, Math: Math, devicePixelRatio: 1, addEventListener: function () {} };
  sandbox.self = sandbox;
  require('vm').runInNewContext(
    require('fs').readFileSync(path.join(__dirname, '..', 'js', 'network.js'), 'utf8'), sandbox);
  NetworkView = sandbox.NetworkView;
}

var passed = 0, failed = 0;
function check(name, fn) {
  try {
    var d = fn();
    passed++; console.log('  ✅ ' + name + (d ? '  — ' + d : ''));
  } catch (e) {
    failed++; console.log('  ❌ ' + name + '\n     ' + e.message);
  }
}

function makeView(mode, accounts, workers) {
  var view = new NetworkView(fakeCanvas(900, 380), {});
  view.setup(mode, accounts, workers || 8);
  return view;
}

console.log('\n=== Схема переводов между участниками ===');

check('участники расставлены в границах холста (без NaN)', function () {
  var view = makeView('transfer', 4);
  for (var i = 0; i < 4; i++) {
    var p = view.nodePos(i);
    assert.ok(isFinite(p.x) && isFinite(p.y), 'координаты узла ' + i + ' не число');
    assert.ok(p.x > 0 && p.x < view.w, 'узел ' + i + ' за левым/правым краем: ' + p.x);
    assert.ok(p.y > 0 && p.y < view.h, 'узел ' + i + ' за верхним/нижним краем: ' + p.y);
  }
  // узлы не должны слипаться
  var minDist = Infinity;
  for (var a = 0; a < 4; a++) {
    for (var b = a + 1; b < 4; b++) {
      var pa = view.nodePos(a), pb = view.nodePos(b);
      minDist = Math.min(minDist, Math.hypot(pa.x - pb.x, pa.y - pb.y));
    }
  }
  assert.ok(minDist > 100, 'участники слишком близко: ' + Math.round(minDist));
  return 'минимальное расстояние между участниками: ' + Math.round(minDist) + ' px';
});

check('точки потоков (для зачислений) тоже в границах', function () {
  var view = makeView('deposit', 1, 8);
  for (var i = 0; i < 8; i++) {
    var p = view.workerPos(i);
    assert.ok(isFinite(p.x) && isFinite(p.y));
    assert.ok(p.x > -5 && p.x < view.w + 5 && p.y > -5 && p.y < view.h + 5, 'поток ' + i + ' вне холста');
  }
  var center = view.nodePos(0);
  assert.ok(Math.abs(center.x - view.w / 2) < 1, 'счёт не в центре схемы');
  return '8 потоков вокруг центрального счёта';
});

check('успешный перевод: деньги приходят получателю по прилёту монетки', function () {
  var view = makeView('transfer', 4);
  var balances = [2500, 2500, 2500, 2500];
  view.setAccounts(balances, [1, 1, 1, 1], function () { return false; });
  assert.strictEqual(view.shownBalance(0), 2500, 'стартовое значение отправителя');
  assert.strictEqual(view.shownBalance(2), 2500, 'стартовое значение получателя');

  // 1. Транзакция зафиксирована: в общей памяти балансы уже изменились,
  //    и в этот же момент бросаем монетку (так же делает приложение).
  balances[0] = 2200; balances[2] = 2800;
  view.setAccounts(balances, [2, 1, 2, 1], function () { return false; });
  view.send({ from: 0, to: 2, amount: 300, status: 'ok', pid: 1 });

  assert.strictEqual(view.coins.length, 1, 'монетка не создана');
  assert.strictEqual(view.shownBalance(0), 2200, 'у отправителя списание не показано сразу');
  assert.strictEqual(view.shownBalance(2), 2500, 'получателю прибавилось раньше прилёта монетки');

  // 2. Монетка долетела: получатель догоняет реальный баланс, есть вспышка.
  view.render(view.coins[0].bornAt + 4000);

  assert.strictEqual(view.coins.length, 0, 'монетка не исчезла после прилёта');
  assert.strictEqual(view.rings.length, 1, 'нет вспышки у получателя');
  assert.strictEqual(view.shownBalance(2), 2800, 'баланс получателя не догнал реальный');
  assert.strictEqual(view.shownBalance(0), 2200, 'баланс отправителя уехал');
  return 'списание сразу, зачисление по прилёту (820 мс)';
});

check('конфликт: монетка гаснет, деньги никуда не уходят', function () {
  var view = makeView('transfer', 4);
  var balances = [2500, 2500, 2500, 2500];
  view.setAccounts(balances, [1, 1, 1, 1], function () { return false; });

  view.send({ from: 0, to: 2, amount: 300, status: 'conflict', pid: 1 });
  // при конфликте ничего не «в пути»: транзакция откатилась целиком
  assert.strictEqual(view.shownBalance(0), 2500, 'у отправителя списались деньги при конфликте');
  assert.strictEqual(view.shownBalance(2), 2500, 'получателю начислили при конфликте');

  view.render(view.coins[0].bornAt + 4000);
  assert.strictEqual(view.coins.length, 0);
  assert.strictEqual(view.rings.length, 0, 'вспышка при конфликте не нужна');
  return 'откат не изменил ни один баланс';
});

check('отказ «недостаточно средств» распознаётся как отдельный случай', function () {
  var view = makeView('transfer', 4);
  view.setAccounts([100, 2500, 2500, 2500], [1, 1, 1, 1], function () { return false; });
  view.send({ from: 0, to: 1, amount: 5000, status: 'abort', pid: 3 });
  assert.strictEqual(view.coins.length, 1);
  assert.strictEqual(view.coins[0].status, 'abort');
  assert.strictEqual(view.shownBalance(1), 2500);
  view.render(view.coins[0].bornAt + 1000);
  assert.strictEqual(view.rings.length, 0);
  return 'монетка помечена как «отказ», денег не двигала';
});

check('много операций подряд: анимации ограничиваются, балансы не ломаются', function () {
  var view = makeView('transfer', 4);
  view.setAccounts([2500, 2500, 2500, 2500], [1, 1, 1, 1], function () { return false; });
  for (var i = 0; i < 500; i++) view.send({ from: 0, to: 1, amount: 10, status: 'ok', pid: i % 8 });
  var cap = NetworkView.MAX_COINS || 140;
  assert.ok(view.coins.length <= cap, 'слишком много монеток: ' + view.coins.length);
  assert.ok(view.skipped > 0, 'счётчик пропущенных анимаций не вырос');
  view.render(1e9);                                  // «прокручиваем» время
  assert.strictEqual(view.coins.length, 0, 'монетки не очистились');
  return 'в воздухе не больше ' + cap + ' монеток, пропущено ' + view.skipped;
});

check('сброс очищает схему полностью', function () {
  var view = makeView('transfer', 4);
  view.setAccounts([2500, 2500, 2500, 2500], [1, 1, 1, 1], function () { return false; });
  view.send({ from: 0, to: 1, amount: 10, status: 'ok', pid: 0 });
  view.clear();
  assert.strictEqual(view.coins.length, 0);
  assert.strictEqual(view.rings.length, 0);
  assert.deepStrictEqual(Object.keys(view.pending), [], 'остались суммы «в пути»');
  return 'монетки, вспышки и «в пути» обнулены';
});

check('заблокированный счёт помечается', function () {
  var view = makeView('transfer', 4);
  view.setAccounts([2500, 2500, 2500, 2500], [1, 1, 1, 1], function (i) { return i === 2; });
  assert.strictEqual(view.accounts[2].locked, true);
  assert.strictEqual(view.accounts[0].locked, false);
  view.render(1000);      // рисование не должно падать на заблокированном узле
  return 'признак блокировки доходит до схемы';
});

console.log('\n=== Итог: ' + passed + ' успешно, ' + failed + ' с ошибками ===\n');
process.exitCode = failed ? 1 : 0;
