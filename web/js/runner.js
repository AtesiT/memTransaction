/*
 * runner.js — фасад запуска: выбирает реальные потоки или симулятор.
 * ===========================================================================
 * Правило выбора:
 *   РЕАЛЬНЫЙ режим  — SharedArrayBuffer доступен (страница отдана сервером с
 *                     заголовками COOP/COEP) => запускаем Web Workers.
 *                     Это честная параллельность: Atomics.compareExchange
 *                     работает так же, как Interlocked.CompareExchange в C#.
 *   СИМУЛЯЦИЯ       — SharedArrayBuffer запрещён => работает кооперативный
 *                     планировщик sim-engine.js с тем же алгоритмом.
 *
 * Интерфейс одинаковый, поэтому интерфейс приложения ничего не знает о режиме.
 * ===========================================================================
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tm-core.js'), null);
  else root.Runner = factory(root.TMCore, root.SimEngine);
})(typeof self !== 'undefined' ? self : this, function (TM, SimEngine) {
  'use strict';

  var DEFAULT_CFG = {
    demo: 2,
    technique: 1,          // TM.TECHNIQUE.STM
    accounts: 4,
    total: 10000,
    workers: 8,
    workUs: 260,           // «тяжёлая работа» внутри транзакции
    conflictBoost: true,   // разброс времени => больше конфликтов
    gapMs: 1,              // пауза между операциями (реальный режим)
    stepsPerTick: 3,       // сколько шагов делает поток за такт симулятора
    tickMs: 16
  };

  function supportsRealThreads() {
    return typeof SharedArrayBuffer !== 'undefined' &&
      typeof Worker !== 'undefined' &&
      (typeof self === 'undefined' || self.crossOriginIsolated === true || self.__forceReal === true);
  }

  function Runner(cfg, handlers) {
    this.cfg = Object.assign({}, DEFAULT_CFG, cfg || {});
    this.h = handlers || {};
    this.mode = 'idle';
    this.reason = '';
    this.workers = [];
    this.sim = null;
    this.sab = null;
    this.mem = null;
    this.paused = false;
    this.workerUrl = this.cfg.workerUrl || 'js/worker.js';
    this.running = false;
    this.finished = false;
  }

  Runner.prototype.snapshot = function () {
    if (!this.mem) return null;
    var accounts = this.cfg.accounts;
    var balances = [];
    var versions = [];
    var sum = 0;
    for (var i = 0; i < accounts; i++) {
      balances.push(this.mem.balance(i));
      versions.push(this.mem.version(i));
      sum += balances[i];
    }
    var wstats = [];
    for (var p = 0; p < this.cfg.workers; p++) {
      wstats.push({
        commits: this.mem.workerStat(p, 0),
        retries: this.mem.workerStat(p, 1),
        ops: this.mem.workerStat(p, 2),
        spins: this.mem.workerStat(p, 3)
      });
    }
    return {
      balances: balances,
      versions: versions,
      sum: sum,
      commits: this.mem.get(TM.H.COMMITS),
      retries: this.mem.get(TM.H.RETRIES),
      ops: this.mem.get(TM.H.OPS),
      aborts: this.mem.get(TM.H.ABORTS),
      alive: this.mem.get(TM.H.ALIVE),
      stops: this.mem.get(TM.H.STOP) !== 0,
      workerStats: wstats,
      paused: this.paused,
      mode: this.mode
    };
  };

  /** Запуск. Если реальные потоки недоступны — прозрачно включаем симулятор. */
  Runner.prototype.start = function () {
    var self = this;
    this.paused = false;
    this.finished = false;
    this.running = true;

    if (supportsRealThreads()) {
      this.mode = 'real';
      this.reason = 'SharedArrayBuffer доступен — работают настоящие потоки (Web Workers + Atomics)';
      this.sab = new SharedArrayBuffer(TM.TOTAL_INTS * 4);
      this.mem = new TM.Mem(new Int32Array(this.sab), true);
      TM.initMemory(this.mem, this.cfg);
      this.mem.set(TM.H.ALIVE, this.cfg.workers);
      this.spawnWorkers();
    } else {
      this.mode = 'sim';
      this.reason = 'SharedArrayBuffer недоступен — включён симулятор планировщика (тот же алгоритм)';
      if (!SimEngine) throw new Error('SimEngine не загружен');
      this.sim = new SimEngine(this.cfg, {
        onEvent: function (ev) { if (self.h.onEvent) self.h.onEvent(ev); },
        onTick: function () { if (self.h.onStats) self.h.onStats(self.snapshot()); },
        onStop: function () {
          self.running = false;
          self.finished = true;
          if (self.h.onStats) self.h.onStats(self.snapshot());
          if (self.h.onFinish) self.h.onFinish();
        }
      });
      this.mem = this.sim.mem;
      this.sim.start();
    }

    if (this.h.onMode) this.h.onMode(this.mode, this.reason);
    if (this.h.onStats) this.h.onStats(this.snapshot());
    return this.mode;
  };

  /** Техника синхронизации для конкретного потока (нужна для смешанного режима). */
  Runner.prototype.techniqueFor = function (pid) {
    if (typeof this.cfg.techniqueBy === 'function') return this.cfg.techniqueBy(pid);
    return this.cfg.technique;
  };

  Runner.prototype.spawnWorkers = function () {
    var self = this;
    this.workers = [];
    for (var i = 0; i < this.cfg.workers; i++) {
      (function (pid) {
        var w = new Worker(self.workerUrl);
        w.onmessage = function (e) {
          var m = e.data;
          if (m.type === 'events') {
            if (self.h.onEvent) {
              for (var k = 0; k < m.events.length; k++) self.h.onEvent(m.events[k]);
            }
          } else if (m.type === 'done') {
            self.checkFinished();
          } else if (m.type === 'notice') {
            if (self.h.onNotice) self.h.onNotice(m.kind, m.pid);
          } else if (m.type === 'error') {
            if (self.h.onError) self.h.onError(m.message);
          }
        };
        w.onerror = function (err) {
          if (self.h.onError) self.h.onError(err.message || String(err));
        };
        // В воркер уходит только «плоская» конфигурация: функции туда
        // передать нельзя (структурное клонирование), поэтому технику
        // вычисляем здесь — в главном потоке.
        var wcfg = {
          demo: self.cfg.demo,
          technique: self.techniqueFor(pid),
          accounts: self.cfg.accounts,
          total: self.cfg.total,
          workers: self.cfg.workers,
          workUs: self.cfg.workUs,
          conflictBoost: self.cfg.conflictBoost,
          gapMs: self.cfg.gapMs
        };
        w.postMessage({ type: 'start', pid: pid, buffer: self.sab, cfg: wcfg });
        self.workers.push(w);
      })(i);
    }
  };

  Runner.prototype.checkFinished = function () {
    if (this.finished) return;
    if (this.mem.get(TM.H.ALIVE) <= 0) {
      this.finished = true;
      this.running = false;
      this.cleanupWorkers();
      if (this.h.onStats) this.h.onStats(this.snapshot());
      if (this.h.onFinish) this.h.onFinish();
    }
  };

  Runner.prototype.cleanupWorkers = function () {
    for (var i = 0; i < this.workers.length; i++) {
      try { this.workers[i].terminate(); } catch (e) { /* уже мёртв */ }
    }
    this.workers = [];
  };

  Runner.prototype.pause = function (on) {
    this.paused = !!on;
    if (this.mode === 'sim' && this.sim) { this.sim.pause(on); return; }
    if (!this.mem) return;
    // Для реальных потоков флаг паузы лежит в общей памяти: воркеры дочитают
    // текущую операцию до конца и остановятся на её границе.
    this.mem.set(TM.H.PAUSE, on ? 1 : 0);
  };

  Runner.prototype.stop = function () {
    if (!this.mem) return;
    this.mem.set(TM.H.STOP, 1);
    if (this.mode === 'sim' && this.sim) { this.sim.stop(); }
    // Реальные воркеры завершатся сами; на всякий случай подчищаем через паузу.
    var self = this;
    setTimeout(function () {
      if (self.workers.length) { self.cleanupWorkers(); self.mem.set(TM.H.ALIVE, 0); }
      self.checkFinished();
    }, 1500);
  };

  // --- изменение параметров на ходу -----------------------------------------
  Runner.prototype.setWorkUs = function (us) { if (this.mem) this.mem.set(TM.H.WORK_US, us); };
  Runner.prototype.setConflictBoost = function (on) { if (this.mem) this.mem.set(TM.H.CONFLICT_BOOST, on ? 1 : 0); };
  Runner.prototype.setGapMs = function (ms) {
    this.cfg.gapMs = ms;
    for (var i = 0; i < this.workers.length; i++) this.workers[i].postMessage({ type: 'setGap', gapMs: ms });
    if (this.sim) this.sim.cfg.idleQuanta = Math.max(1, Math.round(ms / 3));
  };
  Runner.prototype.setSpeed = function (stepsPerTick, tickMs) {
    this.cfg.stepsPerTick = stepsPerTick;
    if (!this.sim) return;
    this.sim.speed = stepsPerTick;
    if (tickMs) this.sim.cfg.tickMs = tickMs;
  };

  Runner.supportsRealThreads = supportsRealThreads;
  Runner.DEFAULT_CFG = DEFAULT_CFG;

  return Runner;
});
