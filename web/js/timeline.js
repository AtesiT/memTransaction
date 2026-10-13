/*
 * timeline.js — визуализация жизненного цикла транзакций.
 * ===========================================================================
 * Для каждого потока рисуется «дорожка» (lane). На дорожке:
 *   • светлая рамка  — одна попытка транзакции (attempt);
 *   • цветные блоки  — фазы внутри попытки:
 *       чтение счёта → вычисления → валидация → коммит;
 *   • красный блок   — конфликт и откат;
 *   • жёлтый блок    — ожидание блокировки (пессимистичный режим).
 *
 * Так видно главное отличие: при STM потоки работают параллельно, но время
 * от времени «переигрывают» попытку, а при блокировках потоки стоят.
 * ===========================================================================
 */
(function (root) {
  'use strict';

  var COLORS = {
    read: '#4ea1ff',
    compute: '#58c0ff',
    validate: '#a78bfa',
    commit: '#35d07f',
    conflict: '#ff5d6c',
    wait: '#ffb020',
    idle: '#2a3550'
  };

  function Timeline(canvas, opts) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.opts = opts || {};
    this.windowMs = this.opts.windowMs || 5000;   // сколько времени влезает на экран
    this.lanes = {};                              // pid -> {phases: [], attemptStart, attemptKind}
    this.workers = 8;
    this.dpr = Math.max(1, Math.min(2, root.devicePixelRatio || 1));
    this.resize();
    var self = this;
    root.addEventListener('resize', function () { self.resize(); });
  }

  Timeline.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var h = this.canvas.height / (this.dpr * (this._scaled || 1)) || 260;
    // height задан в HTML-атрибуте, поэтому запоминаем логическую высоту один раз
    if (!this._logicalH) this._logicalH = Number(this.canvas.getAttribute('height')) || 260;
    this.w = Math.max(300, rect.width);
    this.h = this._logicalH;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.height = this.h + 'px';
    this._scaled = 1;
    this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  Timeline.prototype.setWorkerCount = function (n) {
    this.workers = n;
    for (var i = 0; i < n; i++) {
      if (!this.lanes[i]) this.lanes[i] = { phases: [], attempt: null };
    }
    for (var pid in this.lanes) if (Number(pid) >= n) delete this.lanes[pid];
  };

  Timeline.prototype.clear = function () {
    this.lanes = {};
    this.setWorkerCount(this.workers);
  };

  /** Добавить фазу (или продлить текущую, если тип совпадает). */
  Timeline.prototype.phase = function (pid, kind, t) {
    var lane = this.lanes[pid];
    if (!lane) { lane = this.lanes[pid] = { phases: [], attempt: null }; }
    var last = lane.phases[lane.phases.length - 1];
    if (last && last.kind === kind && t - last.end < 40) {
      last.end = t;
      return;
    }
    lane.phases.push({ kind: kind, start: t, end: t + 1 });
  };

  Timeline.prototype.attemptBegin = function (pid, t, label) {
    var lane = this.lanes[pid];
    if (!lane) { lane = this.lanes[pid] = { phases: [], attempt: null }; }
    lane.attempt = { start: t, end: t, label: label || '' };
  };

  Timeline.prototype.attemptEnd = function (pid, t, kind) {
    var lane = this.lanes[pid];
    if (!lane || !lane.attempt) return;
    lane.attempt.end = t;
    lane.attempt.outcome = kind;
    lane.lastAttempt = lane.attempt;
    lane.attempt = null;
  };

  Timeline.prototype.trim = function (now) {
    var from = now - this.windowMs * 1.6;
    for (var pid in this.lanes) {
      var lane = this.lanes[pid];
      if (lane.phases.length > 4000) lane.phases.splice(0, lane.phases.length - 4000);
      while (lane.phases.length && lane.phases[0].end < from) lane.phases.shift();
    }
  };

  Timeline.prototype.render = function (now) {
    var ctx = this.ctx2d;
    var w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);

    var padLeft = 42, padTop = 8, padBottom = 18;
    var lanesCount = Math.max(1, this.workers);
    var laneH = Math.max(8, Math.floor((h - padTop - padBottom) / lanesCount));
    var barH = Math.max(5, laneH - 5);
    var x0 = padLeft, x1 = w - 6;
    var span = this.windowMs;
    var t0 = now - span;
    var self = this;

    function x(t) {
      var v = x0 + (t - t0) / span * (x1 - x0);
      return Math.max(x0, Math.min(x1, v));
    }

    // сетка по времени
    ctx.strokeStyle = 'rgba(34,48,79,.75)';
    ctx.fillStyle = '#6d80a3';
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.lineWidth = 1;
    var stepMs = 500;
    var startTick = Math.ceil(t0 / stepMs) * stepMs;
    for (var t = startTick; t <= now; t += stepMs) {
      var xx = Math.round(x(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, padTop); ctx.lineTo(xx, h - padBottom); ctx.stroke();
      ctx.fillText(((t - now) / 1000).toFixed(1) + 's', xx + 3, h - 5);
    }

    for (var pid = 0; pid < lanesCount; pid++) {
      var lane = this.lanes[pid];
      var y = padTop + pid * laneH;
      var cy = y + barH / 2 + 2;

      // подпись потока
      ctx.fillStyle = '#8fa3c4';
      ctx.fillText('#' + pid, 8, cy + 3.5);

      // фон дорожки
      ctx.fillStyle = 'rgba(22,33,60,.45)';
      ctx.fillRect(x0, y + 2, x1 - x0, barH);

      if (!lane) continue;

      // рамка попытки
      if (lane.lastAttempt) {
        var a = lane.lastAttempt;
        ctx.strokeStyle = a.outcome === 'conflict' ? 'rgba(255,93,108,.55)' :
          (a.outcome === 'commit' ? 'rgba(53,208,127,.5)' : 'rgba(143,163,196,.4)');
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x(a.start)) + 0.5, y + 1.5, Math.max(2, x(a.end) - x(a.start)), barH + 1);
      }
      if (lane.attempt) {
        var cur = lane.attempt;
        ctx.strokeStyle = 'rgba(143,163,196,.6)';
        ctx.strokeRect(Math.round(x(cur.start)) + 0.5, y + 1.5, Math.max(2, x(now) - x(cur.start)), barH + 1);
      }

      // фазы
      for (var i = 0; i < lane.phases.length; i++) {
        var ph = lane.phases[i];
        var px = x(ph.start), pw = Math.max(1.6, x(ph.end) - px);
        ctx.fillStyle = COLORS[ph.kind] || '#55688c';
        ctx.fillRect(px, y + 3, pw, barH - 2);
      }
    }

    this.trim(now);
  };

  root.Timeline = Timeline;
})(typeof self !== 'undefined' ? self : this);
