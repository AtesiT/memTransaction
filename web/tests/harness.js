/*
 * harness.js — мини-планировщик для тестов: прогоняет те же генераторы
 * шагов, что и браузер, но без таймеров — быстро и воспроизводимо.
 */
'use strict';

var path = require('path');
var TM = require(path.join(__dirname, '..', 'js', 'tm-core.js'));

/**
 * @param {object} o
 *   demo        1 = зачисление, 2 = переводы
 *   technique   TM.TECHNIQUE.*
 *   workers     число «потоков»
 *   accounts    число счетов
 *   total       стартовая сумма
 *   targetOps   сколько операций выполнить до остановки
 *   workUs      «тяжёлая работа» внутри транзакции (в симуляторе — просто шаг)
 *   techniqueBy функция (pid) => technique (для смешанных режимов)
 */
function runSim(o) {
  var i32 = new Int32Array(TM.TOTAL_INTS);
  var mem = new TM.Mem(i32, false);
  var cfg = {
    demo: o.demo, accounts: o.accounts, total: o.total,
    workers: o.workers, workUs: o.workUs === undefined ? 40 : o.workUs,
    conflictBoost: true
  };
  TM.initMemory(mem, cfg);

  var events = [];
  var workers = [];
  for (var pid = 0; pid < cfg.workers; pid++) {
    var tech = o.techniqueBy ? o.techniqueBy(pid) : o.technique;
    var ctx = new TM.WorkerContext(pid, mem, cfg.demo, {
      emit: function (ev) { events.push(ev); }
    });
    var state = TM.makeState(mem, { transferMax: o.transferMax || 50, depositAmount: o.depositAmount || 10 });
    var gen = TM.createAlgorithm(cfg.demo, tech)(ctx, state);
    workers.push({
      ctx: ctx,
      driver: new TM.StepDriver(ctx, gen, mem, false),
      idle: 0
    });
  }

  var target = o.targetOps || 2000;
  var step = 0;
  var maxSteps = o.maxSteps || 4000000;
  var stopped = false;

  while (step < maxSteps) {
    // Как только цель достигнута — аккуратно просим потоки завершиться.
    // Они доигрывают текущую операцию целиком и выходят: последняя операция
    // не «зависает» на середине транзакции, поэтому итог можно проверять строго.
    if (!stopped && mem.get(TM.H.OPS) >= target) {
      stopped = true;
      mem.set(TM.H.STOP, 1);
      for (var q = 0; q < workers.length; q++) workers[q].ctx.stopRequested = true;
    }
    var alive = 0;
    for (var q2 = 0; q2 < workers.length; q2++) if (!workers[q2].driver.done) alive++;
    if (alive === 0) break;

    step++;
    // Перемешиваем порядок потоков — модель недетерминированного планировщика.
    var order = workers.slice();
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (var k = 0; k < order.length; k++) {
      var w = order[k];
      if (w.idle > 0) { w.idle--; continue; }
      var quantum = 1 + Math.floor(Math.random() * 2);   // 1-2 шага за такт
      for (var s = 0; s < quantum; s++) {
        if (!w.driver.stepOnce()) break;
        if (w.driver.opDone) {
          w.driver.opDone = false;
          w.idle = Math.floor(Math.random() * 2);
          break;
        }
      }
    }
  }
  mem.set(TM.H.STOP, 1);

  return {
    mem: mem,
    events: events,
    steps: step,
    sum: TM.invariantSum(mem, cfg.accounts),
    balances: (function () {
      var b = [];
      for (var a = 0; a < cfg.accounts; a++) b.push(mem.balance(a));
      return b;
    })(),
    commits: mem.get(TM.H.COMMITS),
    retries: mem.get(TM.H.RETRIES),
    ops: mem.get(TM.H.OPS),
    aborts: mem.get(TM.H.ABORTS)
  };
}

module.exports = { runSim: runSim, TM: TM };
