/*
 * wt-worker.js — «нить» для теста настоящей параллельности в Node.
 * Повторяет логику web/js/worker.js, но без postMessage-обмена:
 * используется тот же tm-core.js и те же шаги алгоритма.
 */
'use strict';

var path = require('path');
var { parentPort, workerData } = require('worker_threads');
var TM = require(path.join(__dirname, '..', 'js', 'tm-core.js'));

var i32 = new Int32Array(workerData.buffer);
var mem = new TM.Mem(i32, true);                 // true = настоящие Atomics
var cfg = workerData.cfg;
var pid = workerData.pid;

var ctx = new TM.WorkerContext(pid, mem, cfg.demo, { emit: function () {} });
var state = TM.makeState(mem, { transferMax: 50, depositAmount: 10 });
var gen = TM.createAlgorithm(cfg.demo, cfg.technique)(ctx, state);
var driver = new TM.StepDriver(ctx, gen, mem, true);   // true = реально жжём CPU на SPIN

var steps = 0;
var deadline = Date.now() + (workerData.ms || 4000);

function tick() {
  while (Date.now() < deadline) {
    driver.opDone = false;
    var guard = 0;
    while (guard++ < 200000) {
      if (!driver.stepOnce()) break;
      if (driver.opDone) break;
    }
    if (mem.isStopped()) break;
    // Небольшая пауза, чтобы потоки реально переплетались во времени.
    var t0 = Date.now();
    while (Date.now() - t0 < 1) { /* ~1 мс ожидания */ }
    steps++;
  }
  mem.bump(TM.H.ALIVE, -1);
  parentPort.postMessage({ pid: pid, steps: steps, stats: ctx.stats });
}

tick();
