/*
 * network.js — живая схема денежных переводов.
 * ===========================================================================
 * Что рисуется:
 *   • узлы — участники (счета людей): имя, баланс, версия данных, признак
 *     блокировки, вспышка при зачислении;
 *   • монетка с суммой летит по линии от отправителя к получателю;
 *   • успешный перевод  — зелёная монетка долетает и «вспыхивает» у получателя;
 *   • конфликт          — красная монетка гаснет на полпути (транзакция
 *     откатилась и будет переиграна);
 *   • недостаточно средств — фиолетовая монетка гаснет сразу у отправителя.
 *
 * В демонстрации зачислений (Пример 1, CAS) схема другая: вокруг счёта
 * расположены точки-потоки, и каждая успешная операция присылает монетку
 * в центр — видно, как несколько потоков конкурируют за одну ячейку памяти.
 * ===========================================================================
 */
(function (root) {
  'use strict';

  var NAMES = ['Аня', 'Борис', 'Вика', 'Гриша', 'Дима', 'Егор', 'Жанна', 'Зоя'];
  var COLORS = ['#4ea1ff', '#35d07f', '#ffb020', '#a78bfa', '#ff7ab6', '#4dd6e0', '#ffd166', '#8be36b'];

  var nf = new Intl.NumberFormat('ru-RU');

  var MAX_COINS = 140;      // больше одновременно летящих монеток рисовать незачем

  function NetworkView(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.mode = 'transfer';       // 'transfer' | 'deposit'
    this.accounts = [];
    this.workers = 0;
    this.coins = [];
    this.rings = [];
    this.now = 0;
    this.pending = {};        // сколько «в пути» к каждому участнику
    this.skipped = 0;         // сколько анимаций не показали из-за перегрузки
    this.sent = 0;            // всего запущено анимаций перевода
    this.dpr = Math.max(1, Math.min(2, root.devicePixelRatio || 1));
    this.logicalH = Number(canvas.getAttribute('height')) || 380;
    this.resize();
    var self = this;
    root.addEventListener('resize', function () { self.resize(); });
  }

  NetworkView.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(320, rect.width);
    // На телефоне схему делаем ниже, чтобы панели ниже тоже влезали в экран.
    var base = this.baseHeight || Number(this.canvas.getAttribute('height')) || 360;
    this.baseHeight = base;
    this.logicalH = this.w < 560 ? Math.round(base * 0.82) : base;
    this.h = this.logicalH;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  /** Настройка схемы: какой сценарий, сколько участников и потоков. */
  NetworkView.prototype.setup = function (mode, accounts, workers) {
    this.mode = mode;
    this.workers = workers || 0;
    var old = this.accounts;
    this.accounts = [];
    var n = accounts;
    for (var i = 0; i < n; i++) {
      this.accounts.push({
        index: i,
        name: mode === 'deposit' ? 'Счёт' : NAMES[i % NAMES.length],
        color: COLORS[i % COLORS.length],
        balance: old[i] ? old[i].balance : 0,
        version: old[i] ? old[i].version : 1,
        locked: false,
        flash: 0
      });
    }
    this.coins = [];
    this.rings = [];
    this.pending = {};
    this.sent = 0;
  };

  NetworkView.prototype.clear = function () {
    this.coins = [];
    this.rings = [];
    this.pending = {};
    this.sent = 0;
  };

  /** Обновление чисел из общей памяти (вызывается каждый кадр). */
  NetworkView.prototype.setAccounts = function (balances, versions, lockedFn) {
    for (var i = 0; i < this.accounts.length && i < balances.length; i++) {
      this.accounts[i].realBalance = balances[i];
      this.accounts[i].version = versions[i];
      this.accounts[i].locked = lockedFn ? !!lockedFn(i) : false;
    }
  };

  /**
   * Показанное значение = реальное минус то, что ещё «в пути».
   * Благодаря этому деньги у получателя прибавляются ровно в тот момент,
   * когда монетка долетает, а не раньше.
   */
  NetworkView.prototype.shownBalance = function (index) {
    var acc = this.accounts[index];
    var real = acc.realBalance !== undefined ? acc.realBalance : acc.balance;
    return real - (this.pending[index] || 0);
  };

  /** Геометрия: где находится участник на схеме. */
  NetworkView.prototype.nodePos = function (index) {
    var n = this.accounts.length;
    var cx = this.w / 2, cy = this.h / 2 + 8;
    if (this.mode === 'deposit' || n === 1) {
      return { x: cx, y: cy };
    }
    if (n === 2) {
      return { x: cx + (index === 0 ? -this.w * 0.22 : this.w * 0.22), y: cy };
    }
    var r = Math.min(this.w * 0.32, this.h * 0.36);
    var ang = -Math.PI / 2 + index * (2 * Math.PI / n);
    return { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r * 0.92 };
  };

  /** Точка-источник для потоков в демонстрации зачислений. */
  NetworkView.prototype.workerPos = function (pid) {
    var n = Math.max(1, this.workers);
    var cx = this.w / 2, cy = this.h / 2 + 8;
    var r = Math.min(this.w * 0.44, this.h * 0.47);
    var ang = Math.PI * (0.15 + 0.7 * (pid / Math.max(1, n - 1)));
    return { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
  };

  /**
   * Запуск анимации перевода.
   * @param {object} o {from, to, amount, status:'ok'|'conflict'|'abort', pid, fromWorker:boolean}
   */
  NetworkView.prototype.send = function (o) {
    if (this.coins.length >= MAX_COINS) { this.skipped++; return; }
    // Чем больше операций в секунду, тем быстрее летят монетки — иначе экран
    // превратился бы в кашу из одновременных переводов.
    var load = this.coins.length;
    var flight = load > 40 ? 460 : (load > 14 ? 640 : 900);
    var from, to;
    if (this.mode === 'deposit') {
      from = this.workerPos(o.pid || 0);
      to = this.nodePos(0);
    } else {
      from = this.nodePos(Number(o.from) || 0);
      to = this.nodePos(Number(o.to) || 0);
    }
    var amount = Number(o.amount) || 0;
    // Деньги «в пути» есть только у получателя: у отправителя сумма уходит
    // в момент фиксации транзакции (монетка бросается), а прибавляется
    // получателю ровно тогда, когда монетка долетает.
    if (o.status === 'ok') {
      this.pending[o.to] = (this.pending[o.to] || 0) + amount;
    }
    this.sent++;
    this.coins.push({
      from: from,
      to: to,
      fromIndex: o.from,
      toIndex: o.to,
      amount: amount,
      status: o.status,
      pid: o.pid,
      bornAt: this.now,
      duration: o.status === 'ok' ? flight : Math.round(flight * 0.75)
    });
  };

  NetworkView.prototype.ring = function (pos, color) {
    this.rings.push({ x: pos.x, y: pos.y, bornAt: this.now, color: color });
  };

  NetworkView.prototype.render = function (now) {
    this.now = now;
    var ctx = this.ctx, w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);

    // ---------- фоновая сетка связей ---------------------------------------
    if (this.mode === 'transfer' && this.accounts.length > 1) {
      ctx.strokeStyle = 'rgba(46,66,110,.55)';
      ctx.lineWidth = 1;
      for (var i = 0; i < this.accounts.length; i++) {
        for (var j = i + 1; j < this.accounts.length; j++) {
          var a = this.nodePos(i), b = this.nodePos(j);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // ---------- точки-потоки (для зачислений) ------------------------------
    if (this.mode === 'deposit') {
      for (var p = 0; p < this.workers; p++) {
        var wp = this.workerPos(p);
        ctx.beginPath();
        ctx.fillStyle = 'rgba(78,161,255,.75)';
        ctx.arc(wp.x, wp.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#8fa3c4';
        ctx.font = '11px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('#' + p, wp.x, wp.y - 13);
      }
      ctx.textAlign = 'left';
    }

    // ---------- монетки ----------------------------------------------------
    for (var k = this.coins.length - 1; k >= 0; k--) {
      var c = this.coins[k];
      var age = now - c.bornAt;
      var t = age / c.duration;
      if (t >= 1) {
        if (c.status === 'ok') {
          this.ring(c.to, '#35d07f');
          // монетка долетела: снимаем «в пути», баланс получателя подрастает
          this.pending[c.toIndex] = (this.pending[c.toIndex] || 0) - c.amount;
          if (this.pending[c.toIndex] === 0) delete this.pending[c.toIndex];
        }
        this.coins.splice(k, 1);
        continue;
      }
      var fade = 1;
      var prog = t;
      if (c.status !== 'ok') {
        // неудачная транзакция: монетка гаснет, не дойдя до получателя
        prog = Math.min(t / 0.75, 1) * 0.55;
        fade = t > 0.6 ? Math.max(0, 1 - (t - 0.6) / 0.4) : 1;
      } else {
        prog = 1 - Math.pow(1 - t, 2);     // мягкое «долетание»
      }

      // путь: квадратичная кривая с изгибом
      var mx = (c.from.x + c.to.x) / 2, my = (c.from.y + c.to.y) / 2;
      var dx = c.to.x - c.from.x, dy = c.to.y - c.from.y;
      var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      var bend = Math.min(60, len * 0.16);
      var cx2 = mx - dy / len * bend, cy2 = my + dx / len * bend;

      var px = (1 - prog) * (1 - prog) * c.from.x + 2 * (1 - prog) * prog * cx2 + prog * prog * c.to.x;
      var py = (1 - prog) * (1 - prog) * c.from.y + 2 * (1 - prog) * prog * cy2 + prog * prog * c.to.y;

      // след
      ctx.globalAlpha = 0.25 * fade;
      ctx.strokeStyle = c.status === 'ok' ? '#35d07f' : '#ff5d6c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.from.x, c.from.y);
      ctx.quadraticCurveTo(cx2, cy2, px, py);
      ctx.stroke();
      ctx.globalAlpha = fade;

      // сама монетка
      ctx.beginPath();
      ctx.fillStyle = c.status === 'ok' ? '#35d07f' : (c.status === 'abort' ? '#a78bfa' : '#ff5d6c');
      ctx.arc(px, py, c.status === 'ok' ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(7,11,22,.9)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // сумма рядом с монеткой
      if (fade > 0.5 && this.coins.length <= 24) {
        ctx.fillStyle = c.status === 'ok' ? '#d6ffe9' : '#ffd6da';
        ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(nf.format(c.amount || 0), px, py - 14);
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
    }

    // ---------- вспышки у узлов -------------------------------------------
    for (var r = this.rings.length - 1; r >= 0; r--) {
      var ring = this.rings[r];
      var rage = (now - ring.bornAt) / 620;
      if (rage >= 1) { this.rings.splice(r, 1); continue; }
      ctx.globalAlpha = 1 - rage;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, 30 + rage * 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---------- узлы-участники --------------------------------------------
    for (var a2 = 0; a2 < this.accounts.length; a2++) {
      var acc = this.accounts[a2];
      var pos = this.nodePos(a2);
      var R = this.mode === 'deposit' ? 42 : 46;
      var isPerson = this.mode !== 'deposit';

      // тело узла
      ctx.beginPath();
      ctx.fillStyle = 'rgba(17,26,48,.96)';
      ctx.arc(pos.x, pos.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = acc.locked ? '#ffb020' : acc.color;
      ctx.stroke();

      // признак блокировки
      if (acc.locked) {
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,176,32,.85)';
        ctx.lineWidth = 1.5;
        ctx.arc(pos.x, pos.y, R + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.textAlign = 'center';

      // силуэт человека — сразу видно, что это участник, а не просто счёт
      if (isPerson) {
        ctx.fillStyle = acc.locked ? '#ffb020' : acc.color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y - R * 0.52, 5.5, 0, Math.PI * 2);     // голова
        ctx.fill();
        ctx.beginPath();                                          // плечи
        ctx.arc(pos.x, pos.y - R * 0.24, 11, Math.PI * 1.08, Math.PI * 1.92);
        ctx.fill();
      }

      // имя и значение
      ctx.fillStyle = '#e6ecf7';
      ctx.font = 'bold 13px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(acc.name, pos.x, pos.y + (isPerson ? 14 : 2));

      ctx.fillStyle = '#9fb2d4';
      ctx.font = '11px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(nf.format(this.shownBalance(a2)) + ' ₽', pos.x, pos.y + (isPerson ? 30 : 16));

      // версия данных — то, по чему транзакция ловит конфликт
      ctx.fillStyle = 'rgba(78,161,255,.9)';
      ctx.font = '10px "JetBrains Mono", Consolas, monospace';
      ctx.fillText('v' + acc.version, pos.x + R - 14, pos.y - R + 8);
      if (acc.locked) {
        ctx.fillStyle = '#ffb020';
        ctx.font = 'bold 12px "Segoe UI", system-ui, sans-serif';
        ctx.fillText('ждёт', pos.x - R + 12, pos.y - R + 8);
      }
      ctx.textAlign = 'left';
    }

    // ---------- подпись схемы ---------------------------------------------
    ctx.font = '11px "JetBrains Mono", Consolas, monospace';
    ctx.fillStyle = this.captionColor || '#6d80a3';
    ctx.fillText(this.caption || (this.mode === 'deposit'
      ? 'потоки → счёт: каждая монетка = успешный CompareExchange'
      : 'линия = перевод; монетка = сумма; гаснет на полпути = откат транзакции'), 12, h - 12);
    if (this.skipped) {
      ctx.fillStyle = '#6d80a3';
      ctx.textAlign = 'right';
      ctx.fillText('анимаций пропущено: ' + this.skipped, w - 12, h - 12);
      ctx.textAlign = 'left';
    }
  };

  NetworkView.NAMES = NAMES;
  NetworkView.MAX_COINS = MAX_COINS;
  root.NetworkView = NetworkView;
})(typeof self !== 'undefined' ? self : this);
