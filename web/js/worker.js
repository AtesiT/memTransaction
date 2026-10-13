/*
 * worker.js — исполнитель одной «нити» в РЕАЛЬНОМ параллельном режиме.
 * ===========================================================================
 * Это аналог одной задачи (Task / Thread) в C#:
 *
 *      tasks[i] = Task.Run(() => account.DepositTransactional(10));
 *
 * Отличие от главного потока: здесь доступны Atomics.wait / настоящие
 * блокирующие ожидания, а SharedArrayBuffer действительно разделяется
 * между всеми воркерами. Поэтому конфликты транзакций — НАСТОЯЩИЕ:
 * они возникают от того, что потоки физически выполняются одновременно
 * на разных ядрах процессора.
 *
 * Схема работы:
 *   while (не остановлено):
 *       прогнать шаги текущей операции до её конца
 *       (внутри операции возможны SPIN-шаги = реальная работа процессора)
 *       await пауза между операциями (отдать ядро другим потокам)
 *   отправить накопленные события в главный поток
 * ===========================================================================
 */
'use strict';

importScripts('tm-core.js');

var TM = self.TMCore;

var mem = null;         // TM.Mem — общая память
var driver = null;      // TM.StepDriver — исполнитель шагов
var ctx = null;
var state = null;
var pid = 0;
var events = [];        // буфер событий для батч-отправки
var flushTimer = null;
var gapMs = 0;          // пауза между операциями (реальные миллисекунды)

// Троттлинг: если операций слишком много, детальные события шагов не
// отправляются (иначе главный поток захлебнётся). Итоговые события
// (начало/коммит/конфликт операции) отправляются всегда.
var budget = 300;       // максимум событий в секунду на один поток
var winStart = 0;
var winCount = 0;
var throttled = false;
var noticeSent = false;

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function flush(force) {
  if (events.length === 0 && !force) return;
  var batch = events;
  events = [];
  self.postMessage({ type: 'events', pid: pid, events: batch });
}

function push(ev) {
  var wall = Date.now();
  if (wall - winStart > 1000) { winStart = wall; winCount = 0; if (throttled) { throttled = false; } }
  var detailed = (ev.ev === 'step' || ev.ev === 'spin' || ev.ev === 'idle');
  if (winCount > budget) {
    throttled = true;
    if (detailed) return;                       // детали шагов отбрасываем
  }
  winCount++;
  if (throttled && !noticeSent) {
    noticeSent = true;
    self.postMessage({ type: 'notice', pid: pid, kind: 'throttled' });
  }
  ev.pid = pid;
  ev.wall = wall;
  events.push(ev);
  if (events.length >= 256) flush();
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'start') {
    pid = msg.pid;
    var sab = msg.buffer;
    var i32 = new Int32Array(sab);
    mem = new TM.Mem(i32, true);                 // true = используем Atomics
    var cfg = msg.cfg;

    var algorithm = TM.createAlgorithm(cfg.demo, cfg.technique);
    state = TM.makeState(mem, cfg);
    ctx = new TM.WorkerContext(pid, mem, cfg.demo, { emit: push });
    var gen = algorithm(ctx, state);
    // Драйвер с interactiveSpin = true: шаги SPIN реально жгут процессор.
    driver = new TM.StepDriver(ctx, gen, mem, true);

    flushTimer = setInterval(function () { flush(); }, 60);
    self.postMessage({ type: 'ready', pid: pid });
    loop();
    return;
  }

  if (msg.type === 'setGap') { gapMs = msg.gapMs; return; }

  if (msg.type === 'stop') {
    if (ctx) ctx.stopRequested = true;
    return;
  }
};

async function loop() {
  // Цикл: одна операция -> пауза -> следующая операция.
  // Гарантирует, что воркер регулярно проверяет флаг остановки и отдаёт
  // управление планировщику (иначе setTimeout-пауза «съела» бы ядро).
  while (true) {
    if (!ctx || ctx.stopRequested || mem.isStopped()) break;

    // Прокручиваем шаги ровно до конца одной операции.
    driver.opDone = false;
    var guard = 0;
    while (true) {
      if (!driver.stepOnce()) break;             // генератор завершился
      if (driver.opDone) break;                  // операция завершена
      if (mem.isStopped()) break;
      if (++guard > 100000) break;               // защита от бесконечного цикла
      if (guard % 512 === 0) {                   // изредка смотрим на флаг остановки
        if (ctx.stopRequested) break;
      }
    }
    if (driver.done) break;

    // Пауза: ждём, пока главный поток снимет флаг (флаг лежит в общей памяти).
    while (mem && mem.get(TM.H.PAUSE) === 1 && !ctx.stopRequested && !mem.isStopped()) {
      await sleep(40);
    }

    if (gapMs > 0) await sleep(gapMs);
    else await sleep(0);
  }

  if (flushTimer) clearInterval(flushTimer);
  flush(true);
  self.postMessage({ type: 'done', pid: pid, stats: ctx ? ctx.stats : null });
  ctx = null;
  mem.bump(TM.H.ALIVE, -1);
  self.close();
}
