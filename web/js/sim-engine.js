/*
 * sim-engine.js — запасной исполнитель: кооперативный планировщик.
 * ===========================================================================
 * Включается автоматически, если браузер не даёт SharedArrayBuffer
 * (например, страница открыта не через локальный сервер или COOP/COEP
 * заголовки не выставлены).
 *
 * Логика НЕ дублируется: используется тот же tm-core.js, тот же алгоритм
 * (генераторы шагов), только драйвер продвигает «потоки» по одному шагу за
 * такт, перемешивая их порядок. Это даёт те же конфликты транзакций,
 * что и реальные потоки, но воспроизводимо и без общей памяти.
 * ===========================================================================
 */
'use strict';

(function (root) {
  var TM = root.TMCore || (typeof require === 'function' ? require('./tm-core.js') : null);

  function SimEngine(cfg, handlers) {
    this.cfg = cfg;
    this.h = handlers || {};
    this.i32 = new Int32Array(TM.TOTAL_INTS);
    // useAtomics = false: обычная неразделяемая память, но операции над ней
    // внутри одного шага всё равно неделимы (планировщик кооперативный).
    this.mem = new TM.Mem(this.i32, false);
    this.workers = [];
    this.tickTimer = null;
    this.step = 0;      // номер такта планировщика
    this.vtime = 0;     // виртуальное время в «квантах»
    this.running = false;
    this.speed = cfg.stepsPerTick || 4;
  }

  SimEngine.prototype.start = function () {
    var self = this;
    TM.initMemory(this.mem, this.cfg);

    for (var i = 0; i < this.cfg.workers; i++) {
      (function (pid) {
        var ctx = new TM.WorkerContext(pid, self.mem, self.cfg.demo, {
          emit: function (ev) { self.emit(ev); }
        });
        var tech = (typeof self.cfg.techniqueBy === 'function') ? self.cfg.techniqueBy(pid) : self.cfg.technique;
        var algorithm = TM.createAlgorithm(self.cfg.demo, tech);
        var state = TM.makeState(self.mem, { gapUs: 0, depositAmount: 10, transferMax: 50 });
        var gen = algorithm(ctx, state);
        var driver = new TM.StepDriver(ctx, gen, self.mem, false);
        self.workers.push({
          pid: pid, ctx: ctx, driver: driver,
          idle: Math.floor(Math.random() * 6),     // «поток спит» между операциями
          done: false
        });
      })(i);
    }

    this.running = true;
    this.tickTimer = setInterval(function () { self.tick(); }, this.cfg.tickMs || 16);
    if (this.h.onStart) this.h.onStart();
  };

  SimEngine.prototype.emit = function (ev) {
    // Виртуальное время: один шаг = один квант. Нужно для таймлайна —
    // в симуляторе реального времени нет, но соотношение событий сохраняется.
    ev.step = this.vtime * 6;
    ev.wall = this.vtime * 6;
    if (this.h.onEvent) this.h.onEvent(ev);
  };

  /** Один такт планировщика: каждый «поток» делает не больше одного шага. */
  SimEngine.prototype.tick = function () {
    if (!this.running) return;
    this.step++;

    var order = this.workers.slice();
    // Перемешивание порядка — модель недетерминированного планировщика ОС.
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }

    for (var k = 0; k < order.length; k++) {
      var w = order[k];
      if (w.done) continue;
      if (w.ctx.stopRequested || this.mem.isStopped()) { w.done = true; continue; }
      this.vtime += 1;

      // Имитация сна между операциями: поток «не готов» несколько тактов.
      if (w.idle > 0) { w.idle--; continue; }

      // Даём потоку квант времени: stepsPerTick шагов подряд (как таймслайс ОС).
      for (var s = 0; s < this.speed; s++) {
        if (w.idle > 0) break;
        this.vtime += 1;
        if (!w.driver.stepOnce()) { w.done = true; break; }
        if (w.driver.opDone) {
          w.driver.opDone = false;
          // После операции поток ненадолго «уходит в сон» — случайная пауза.
          w.idle = 1 + Math.floor(Math.random() * (this.cfg.idleQuanta || 6));
          break;
        }
      }
    }

    if (this.h.onTick) this.h.onTick(this.step);
  };

  SimEngine.prototype.stop = function () {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.mem.set(TM.H.STOP, 1);
    for (var i = 0; i < this.workers.length; i++) this.workers[i].ctx.stopRequested = true;
    if (this.h.onStop) this.h.onStop();
  };

  SimEngine.prototype.paused = false;
  SimEngine.prototype.pause = function (on) {
    this.paused = !!on;
    if (on) {
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    } else if (this.running && !this.tickTimer) {
      var self = this;
      this.tickTimer = setInterval(function () { self.tick(); }, this.cfg.tickMs || 16);
    }
  };

  root.SimEngine = SimEngine;
  if (typeof module === 'object' && module.exports) module.exports = SimEngine;
})(typeof self !== 'undefined' ? self : this);
