/*
 * tm.test.js — проверка корректности механизмов транзакционной памяти.
 * Запуск:  node tests/tm.test.js
 * ===========================================================================
 * Что проверяем:
 *   1. Демо 1 (CAS-зачисление) — ни одно пополнение не потеряно.
 *   2. Демо 1 (без синхронизации) — обновления теряются (демонстрация проблемы).
 *   3. Демо 1 (спин-блокировка) — корректно.
 *   4. Демо 2 (STM-переводы) — сумма на счетах неизменна (инвариант банка).
 *   5. Демо 2 (без синхронизации) — инвариант нарушается.
 *   6. Демо 2 (спин-блокировка) — инвариант сохраняется.
 *   7. Демо 2 (микс STM + блокировки) — инвариант сохраняется.
 *   8. РЕАЛЬНЫЕ ПОТОКИ (worker_threads + SharedArrayBuffer + Atomics):
 *      демонстрация 2 в STM-режиме и в смешанном режиме.
 * ===========================================================================
 */
'use strict';

var path = require('path');
var assert = require('assert');
var Worker = require('worker_threads').Worker;
var h = require(path.join(__dirname, 'harness.js'));
var TM = h.TM;
var T = TM.TECHNIQUE;

var passed = 0, failed = 0;

function check(name, fn) {
  try {
    var detail = fn();
    passed++;
    console.log('  ✅ ' + name + (detail ? '  — ' + detail : ''));
  } catch (e) {
    failed++;
    console.log('  ❌ ' + name + '\n     ' + e.message);
  }
}

console.log('\n=== 1. Демо 1: зачисление на счёт (8 потоков, ~4000 операций по +10) ===');

check('CAS-цикл (Interlocked.CompareExchange) — ничего не потеряно', function () {
  var r = h.runSim({ demo: 1, technique: T.CAS, workers: 8, accounts: 1, total: 1000, targetOps: 4000 });
  assert.strictEqual(r.sum, 1000 + r.ops * 10, 'итоговый баланс ' + r.sum + ' вместо ' + (1000 + r.ops * 10));
  assert.ok(r.retries > 0, 'ожидались конфликты CAS, но их нет: конфликтов должно быть много');
  return 'операций: ' + r.ops + ', конфликтов CAS: ' + r.retries;
});

check('без синхронизации — обновления теряются (так и должно быть)', function () {
  var r = h.runSim({ demo: 1, technique: T.UNSAFE, workers: 8, accounts: 1, total: 1000, targetOps: 4000 });
  assert.ok(r.sum < 1000 + r.ops * 10, 'потерянные обновления не воспроизвелись');
  return 'потеряно: ' + (1000 + r.ops * 10 - r.sum) + ' из ' + (r.ops * 10);
});

check('спин-блокировка — корректно, но с ожиданиями', function () {
  var r = h.runSim({ demo: 1, technique: T.LOCK, workers: 8, accounts: 1, total: 1000, targetOps: 4000 });
  assert.strictEqual(r.sum, 1000 + r.ops * 10);
  return 'операций: ' + r.ops + ', баланс: ' + r.sum;
});

console.log('\n=== 2. Демо 2: переводы между счетами (инвариант суммы) ===');

check('STM-переводы — сумма на счетах неизменна', function () {
  var r = h.runSim({ demo: 2, technique: T.STM, workers: 8, accounts: 4, total: 10000, targetOps: 3000 });
  assert.strictEqual(r.sum, 10000, 'сумма изменилась: ' + r.sum);
  assert.ok(r.retries > 0, 'STM не откатывала транзакции — конфликтов не было?');
  return 'коммитов: ' + r.commits + ', откатов-конфликтов: ' + r.retries + ', сумма: 10000';
});

check('без синхронизации — сумма «плывёт» (потерянные обновления)', function () {
  var r = h.runSim({ demo: 2, technique: T.UNSAFE, workers: 8, accounts: 4, total: 10000, targetOps: 3000 });
  assert.notStrictEqual(r.sum, 10000, 'ожидалось нарушение инварианта');
  return 'сумма стала: ' + r.sum + ' вместо 10000 (ошибка ' + (r.sum - 10000) + ')';
});

check('спин-блокировка — сумма неизменна', function () {
  var r = h.runSim({ demo: 2, technique: T.LOCK, workers: 8, accounts: 4, total: 10000, targetOps: 3000 });
  assert.strictEqual(r.sum, 10000);
  return 'сумма: 10000, ожиданий блокировок: ' + r.retries;
});

check('микс: половина потоков на STM, половина на блокировках', function () {
  var r = h.runSim({
    demo: 2, technique: T.STM, workers: 8, accounts: 4, total: 10000, targetOps: 3000,
    techniqueBy: function (pid) { return pid % 2 ? T.LOCK : T.STM; }
  });
  assert.strictEqual(r.sum, 10000, 'сумма изменилась: ' + r.sum);
  return 'сумма: 10000 (STM + lock на общих данных)';
});

check('высокая конкуренция: 16 потоков, 8 счетов', function () {
  var r = h.runSim({ demo: 2, technique: T.STM, workers: 16, accounts: 8, total: 10000, targetOps: 2000, workUs: 300 });
  assert.strictEqual(r.sum, 10000, 'сумма изменилась: ' + r.sum);
  return 'откатов: ' + r.retries + ' на ' + r.commits + ' коммитов';
});

// ---------------------------------------------------------------------------
// 3. Настоящие потоки: SharedArrayBuffer + Atomics + worker_threads
// ---------------------------------------------------------------------------
console.log('\n=== 3. Реальная параллельность (SharedArrayBuffer + Atomics) ===');

function runReal(cfg, cb) {
  var sab = new SharedArrayBuffer(TM.TOTAL_INTS * 4);
  var mem = new TM.Mem(new Int32Array(sab), true);
  TM.initMemory(mem, cfg);
  mem.set(TM.H.ALIVE, cfg.workers);

  var alive = cfg.workers;
  var results = [];
  for (var i = 0; i < cfg.workers; i++) {
    (function (pid) {
      var tech = cfg.techniqueBy ? cfg.techniqueBy(pid) : cfg.technique;
      var w = new Worker(path.join(__dirname, 'wt-worker.js'), {
        workerData: { buffer: sab, pid: pid, cfg: { demo: cfg.demo, technique: tech }, ms: cfg.ms }
      });
      w.on('message', function (m) {
        results.push(m);
        alive--;
        if (alive === 0) cb(mem, results);
      });
      w.on('error', function (e) { console.error('worker error:', e); });
    })(i);
  }
}

check('STM-переводы в настоящих параллельных потоках', function () {
  // Проверка асинхронная: результат печатается по завершении.
  setTimeout(function () {
    runReal(
      { demo: 2, technique: T.STM, workers: 8, accounts: 4, total: 10000, workUs: 200, ms: 3000 },
      function (mem, res) {
        var sum = TM.invariantSum(mem, 4);
        var retries = mem.get(TM.H.RETRIES);
        console.log('  ▶ реальные потоки: коммитов ' + mem.get(TM.H.COMMITS) +
          ', откатов-конфликтов ' + retries + ', операций ' + mem.get(TM.H.OPS) +
          ', сумма на счетах ' + sum + (sum === 10000 ? '  ✅' : '  ❌ ИНВАРИАНТ СЛОМАН'));
        if (sum !== 10000) process.exitCode = 1;
      }
    );
  }, 0);
  return 'запущено 8 потоков на 3 секунды...';
});

check('микс STM + блокировки в настоящих потоках', function () {
  setTimeout(function () {
    runReal(
      {
        demo: 2, technique: T.STM, workers: 8, accounts: 4, total: 10000, workUs: 200, ms: 3000,
        techniqueBy: function (pid) { return pid % 2 ? T.LOCK : T.STM; }
      },
      function (mem) {
        var sum = TM.invariantSum(mem, 4);
        console.log('  ▶ реальные потоки (микс): коммитов ' + mem.get(TM.H.COMMITS) +
          ', откатов-конфликтов ' + mem.get(TM.H.RETRIES) + ', сумма на счетах ' + sum +
          (sum === 10000 ? '  ✅' : '  ❌ ИНВАРИАНТ СЛОМАН'));
        if (sum !== 10000) process.exitCode = 1;
      }
    );
  }, 0);
  return 'запущено 8 потоков на 3 секунды...';
});

// Итог печатаем с задержкой: реальные потоки работают асинхронно.
setTimeout(function () {
  console.log('\n=== Синхронные проверки: ' + passed + ' успешно, ' + failed + ' с ошибками ===');
  if (failed) process.exitCode = 1;
}, 500);

setTimeout(function () {
  console.log('=== Готово. Если выше по всем реальным прогонам стоит ✅ — механизм работает корректно. ===');
}, 7000);
