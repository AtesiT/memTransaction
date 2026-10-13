/*
 * app.js — интерфейс лабораторного стенда.
 * ===========================================================================
 * Связывает движок (runner.js → worker.js / sim-engine.js) с визуализацией:
 *   • счета и их версии (что видит «память»);
 *   • состояния потоков;
 *   • таймлайн транзакций (timeline.js);
 *   • журнал выбранного потока: read-set / write-set;
 *   • поток событий и сводные показатели.
 * ===========================================================================
 */
(function () {
  'use strict';

  var TM = window.TMCore;
  var T = TM.TECHNIQUE;
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat('ru-RU');
  var nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

  // -------------------------------------------------------------------------
  // Сценарии: что показываем в каждом примере
  // -------------------------------------------------------------------------
  var DEMOS = {
    demo1: {
      title: 'Пример 1 · зачисление на счёт',
      accounts: 1,
      total: 1000,
      amount: 10,
      invariant: 'grow',
      techniques: [
        { id: T.CAS, name: 'CAS-цикл (как в задании)', hint: 'Оптимистичная блокировка: читаем значение, считаем новое, пытаемся заменить через Interlocked.CompareExchange. Не получилось — повторяем.', preset: {} },
        { id: T.LOCK, name: 'Спин-блокировка', hint: 'Пессимистичный подход: поток захватывает блокировку счёта и держит её во время вычислений — остальные ждут.', preset: {} },
        { id: T.UNSAFE, name: 'Без синхронизации', hint: 'Специально сломанный режим: чтение и запись без всякой синхронизации — часть пополнений «потеряется».', preset: {} }
      ]
    },
    demo2: {
      title: 'Пример 2 · переводы между счетами',
      accounts: 4,
      total: 10000,
      amount: 0,
      invariant: 'const',
      techniques: [
        { id: T.STM, name: 'STM: транзакции', hint: 'Перевод целиком выполняется в транзакции: чтения в журнал, валидация версий, коммит. При конфликте — откат и повтор.', preset: { mix: false } },
        { id: 99, name: 'Микс: STM + блокировки', hint: 'Половина потоков работает через транзакции, половина — через блокировки, на одних и тех же счетах. Инвариант всё равно сохраняется.', preset: { mix: true } },
        { id: T.LOCK, name: 'Только блокировки', hint: 'Классический пессимистичный подход: счета захватываются в порядке возрастания номера (иначе был бы deadlock).', preset: { mix: false } },
        { id: T.UNSAFE, name: 'Без синхронизации', hint: 'Специально сломанный режим: сумма на счетах «плывёт» на глазах — деньги теряются и появляются из ниоткуда.', preset: { mix: false } }
      ]
    }
  };

  // -------------------------------------------------------------------------
  // Состояние приложения
  // -------------------------------------------------------------------------
  var S = {
    tab: 'demo1',
    demo: 1,
    demoKey: 'demo1',
    technique: T.CAS,
    mix: false,
    workers: 8,
    workUs: 320,
    gapMs: 80,
    speed: 3,
    boost: true,
    accounts: 1,
    total: 1000,
    amount: 10,
    tempo: 'normal',
    status: 'idle',     // idle | running | paused | finished
    clock: Date.now(),  // «сейчас» в шкале текущего режима (мс эпохи или виртуальные)
    mode: 'idle',
    lastOps: 0,
    lastOpsAt: 0,
    rate: 0,
    selectedPid: 0,
    invBadSince: 0,
    eventsSeen: 0,
    dropped: false
  };

  var runner = null;
  var timeline = null;
  var network = null;   // схема переводов между участниками
  var workerStates = [];      // последнее состояние каждого потока
  var workerLastEvent = [];   // когда поток в последний раз подавал признаки жизни
  var accountsFlash = [];     // {pid, kind, until} — подсветка счёта
  var journal = [];           // строки журнала выбранного потока
  var journalAttempt = 0;

  // -------------------------------------------------------------------------
  // Вкладки и сценарии
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Темп показа: «медленно и наглядно» ↔ «нагрузка»
  // -------------------------------------------------------------------------
  var TEMPO = {
    show:   { gap: 420, work: 1200, speed: 2, windowMs: 14000, title: 'показ' },
    normal: { gap: 80,  work: 320,  speed: 3, windowMs: 9000,  title: 'обычный' },
    load:   { gap: 4,   work: 200,  speed: 6, windowMs: 6000,  title: 'нагрузка' }
  };

  function applyTempo(name) {
    var t = TEMPO[name] || TEMPO.normal;
    S.tempo = name;
    S.gapMs = t.gap;
    S.workUs = t.work;
    S.speed = t.speed;

    $('gap').value = t.gap;
    $('gap-val').textContent = t.gap;
    $('work').value = t.work;
    $('work-val').textContent = t.work;
    $('speed').value = t.speed;
    $('speed-val').textContent = t.speed;
    timeline.opts.windowMs = t.windowMs;
    timeline.windowMs = t.windowMs;

    if (runner) {
      runner.setGapMs(t.gap);
      runner.setWorkUs(t.work);
      runner.setSpeed(t.speed);
    }

    var chips = document.querySelectorAll('#tempo-chips .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-tempo') === name);
    }
    logEvent('info', 'темп «' + t.title + '»: пауза ' + t.gap + ' мс, работа в транзакции ' + t.work + ' мкс');
  }

  function setupTempo() {
    var chips = document.querySelectorAll('#tempo-chips .chip');
    for (var i = 0; i < chips.length; i++) {
      (function (chip) {
        chip.addEventListener('click', function () { applyTempo(chip.getAttribute('data-tempo')); });
      })(chips[i]);
    }
  }

  function setupTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var name = this.getAttribute('data-tab');
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
        this.classList.add('active');
        var panes = document.querySelectorAll('.tabpane');
        for (var k = 0; k < panes.length; k++) panes[k].classList.remove('active');
        $('pane-' + name).classList.add('active');
        timeline.resize();

        if (name === 'demo1' || name === 'demo2') {
          if (S.tab !== name) {
            S.tab = name;
            applyDemo(name, true);
          }
        }
      });
    }
  }

  function applyDemo(key, restart) {
    var d = DEMOS[key];
    S.demoKey = key;
    S.demo = key === 'demo1' ? 1 : 2;
    S.accounts = d.accounts;
    S.total = d.total;
    S.amount = d.amount;
    S.technique = d.techniques[0].id;
    S.mix = false;

    $('d1-tag').textContent = key === 'demo1' ? 'CAS · Interlocked.CompareExchange' : '';
    $('d2-tag').textContent = key === 'demo2' ? 'STM · перевод между счетами' : '';

    renderTechniqueChips();
    buildAccounts();
    buildWorkerGrid();
    setupNetworkView();
    // Перезапуск по смене сценария: если демонстрация шла — продолжаем её
    // в новом режиме, а не оставляем пользователя с погасшим экраном.
    if (restart) {
      var wasRunning = (S.status === 'running' || S.status === 'paused');
      stopRun();
      clearAll();
      if (wasRunning) startRun();
    }
  }

  function renderTechniqueChips() {
    var d = DEMOS[S.demoKey];
    var box = $('technique-chips');
    box.innerHTML = '';
    d.techniques.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'chip' + (t.id === S.technique ? ' active' : '') + (t.id === T.UNSAFE ? ' chip-unsafe' : '');
      b.textContent = t.name;
      b.addEventListener('click', function () {
        S.technique = t.id;
        S.mix = !!(t.preset && t.preset.mix);
        renderTechniqueChips();
        $('technique-hint').textContent = t.hint;
        updateNetworkCaption();
        restartRun();
      });
      box.appendChild(b);
    });
    var cur = d.techniques.filter(function (t) { return t.id === S.technique; })[0];
    $('technique-hint').textContent = cur ? cur.hint : '';
  }

  // -------------------------------------------------------------------------
  // Разметка панелей
  // -------------------------------------------------------------------------
  function buildAccounts() {
    var pane = S.demo === 1 ? $('accounts1') : $('accounts2');
    var other = S.demo === 1 ? $('accounts2') : $('accounts1');
    other.innerHTML = '';
    pane.innerHTML = '';
    for (var i = 0; i < S.accounts; i++) {
      var el = document.createElement('div');
      el.className = 'account';
      el.id = 'acc-' + i;
      el.innerHTML =
        '<div class="acc-head"><span>Счёт ' + String.fromCharCode(65 + i) + '</span>' +
        '<span class="acc-lock" id="lock-' + i + '"></span></div>' +
        '<div class="acc-balance" id="bal-' + i + '">—</div>' +
        '<div class="acc-meta">версия <b id="ver-' + i + '">1</b> · <span id="share-' + i + '">—</span></div>' +
        '<div class="acc-bar"><i id="bar-' + i + '" style="width:0%"></i></div>';
      pane.appendChild(el);
    }
    accountsFlash = [];
  }

  function buildWorkerGrid() {
    var grid = $('workers-grid');
    grid.innerHTML = '';
    for (var i = 0; i < S.workers; i++) {
      var el = document.createElement('div');
      el.className = 'worker';
      el.id = 'w-' + i;
      el.setAttribute('data-state', 'idle');
      el.innerHTML =
        '<div class="w-top"><span>поток #' + i + '</span><span id="w-lock-' + i + '"></span></div>' +
        '<div class="w-state" id="ws-' + i + '">ожидание</div>' +
        '<div class="w-stats" id="wst-' + i + '">оп 0 · retry 0 · ожид. 0</div>';
      grid.appendChild(el);
    }
    workerStates = new Array(S.workers).fill('idle');
    workerLastEvent = new Array(S.workers).fill(0);
    timeline.setWorkerCount(S.workers);
    if (network) { network.workers = S.workers; }

    var sel = $('pid-select');
    sel.innerHTML = '';
    for (var k = 0; k < S.workers; k++) {
      var o = document.createElement('option');
      o.value = k; o.textContent = '#' + k;
      sel.appendChild(o);
    }
    sel.value = S.selectedPid = 0;
    journal = [];
    renderJournal();
  }

  /** Схема переводов: в переводах — участники по кругу, в зачислении — счёт в центре. */
  function setupNetworkView() {
    if (!network) return;
    var deposit = (S.demo === 1);
    network.workers = S.workers;
    network.setup(deposit ? 'deposit' : 'transfer', S.accounts, S.workers);

    $('net-title').innerHTML = deposit
      ? 'Зачисление на счёт <span class="tag" id="net-tag">потоки → одна ячейка памяти</span>'
      : 'Переводы между участниками <span class="tag" id="net-tag">живая схема транзакций</span>';
    $('net-hint').textContent = deposit
      ? 'Кружки по краям — потоки. Монетка долетает до счёта только тогда, когда CompareExchange прошёл: если другой поток успел изменить баланс, монетка (красная) гаснет и операция повторяется.'
      : 'Каждая линия — попытка перевода. Зелёная монетка долетает до получателя — транзакция зафиксирована; красная гаснет на полпути — конфликт версий, транзакция откатилась и будет переиграна.';

    $('net-legend').innerHTML = deposit
      ? '<span><i class="sw sw-commit"></i>CompareExchange прошёл — монетка долетела</span>' +
        '<span><i class="sw sw-conflict"></i>конфликт: баланс изменили — повтор</span>' +
        '<span><i class="sw sw-wait"></i>поток ждёт освобождения счёта</span>'
      : '<span><i class="sw sw-commit"></i>перевод зафиксирован — деньги дошли</span>' +
        '<span><i class="sw sw-conflict"></i>конфликт версий: транзакция откатилась, деньги не ушли</span>' +
        '<span><i class="sw sw-validate"></i>отказ: недостаточно средств</span>' +
        '<span><i class="sw sw-wait"></i>счёт заблокирован, поток ждёт</span>';
    network.clear();
    updateNetworkCaption();
  }

  /** Подпись под схемой: отдельно выделяем «сломанный» и смешанный режимы. */
  function updateNetworkCaption() {
    if (!network) return;
    var unsafe = (S.technique === T.UNSAFE);
    var mixed = (S.demo === 2 && S.mix);
    if (unsafe) {
      network.caption = 'БЕЗ СИНХРОНИЗАЦИИ: транзакций нет, деньги теряются и появляются из ниоткуда';
      network.captionColor = '#ff5d6c';
    } else if (mixed) {
      network.caption = 'смешанный режим: чётные потоки — транзакции, нечётные — блокировки';
      network.captionColor = '#ffb020';
    } else {
      network.caption = '';
      network.captionColor = '#6d80a3';
    }
  }

  // -------------------------------------------------------------------------
  // Запуск / остановка
  // -------------------------------------------------------------------------
  function makeConfig() {
    return {
      demo: S.demo,
      technique: S.technique,
      accounts: S.accounts,
      total: S.total,
      workers: S.workers,
      workUs: S.workUs,
      gapMs: S.gapMs,
      conflictBoost: S.boost,
      stepsPerTick: S.speed,
      tickMs: 16,
      workerUrl: 'js/worker.js',
      idleQuanta: Math.max(1, Math.round(S.gapMs / 3))
    };
  }

  function isMixed() { return S.demo === 2 && S.mix; }

  function startRun() {
    if (S.status === 'paused') { runner.pause(false); S.status = 'running'; syncButtons(); return; }
    if (S.status === 'running') return;

    stopRun();
    clearAll();
    timeline.setWorkerCount(S.workers);

    var cfg = makeConfig();
    runner = new window.Runner(cfg, {
      onEvent: onEvent,
      onStats: function () { /* сводку берём по таймеру */ },
      onMode: function (mode, reason) {
        S.mode = mode;
        var badge = $('mode-badge');
        if (mode === 'real') {
          badge.className = 'badge badge-real';
          badge.textContent = '● настоящие потоки (SharedArrayBuffer + Atomics)';
        } else {
          badge.className = 'badge badge-sim';
          badge.textContent = '● симулятор планировщика (без SharedArrayBuffer)';
        }
        $('mode-note').textContent = reason;
        // В режиме настоящих потоков «скорость симулятора» не нужна
        $('field-speed').style.display = mode === 'real' ? 'none' : 'block';
      },
      onNotice: function (kind) {
        if (kind === 'throttled' && !S.dropped) {
          S.dropped = true;
          logEvent('info', 'поток событий слишком плотный — детальные шаги скрываются, важные события продолжают идти');
        }
      },
      onError: function (msg) { logEvent('abort', 'ошибка потока: ' + msg); },
      onFinish: function () {
        if (S.status === 'running') { S.status = 'idle'; syncButtons(); logEvent('info', 'все потоки завершены'); }
      }
    });

    // смешанный режим: половина потоков — транзакции, половина — блокировки
    if (isMixed()) runner.cfg.techniqueBy = function (pid) { return pid % 2 ? T.LOCK : T.STM; };

    runner.start();
    if (isMixed()) logEvent('info', 'смешанный режим: потоки с чётными номерами — STM, с нечётными — блокировки');

    S.status = 'running';
    S.lastOpsAt = performance.now();
    S.lastOps = 0;
    $('events').innerHTML = '';
    S.eventsSeen = 0;
    S.dropped = false;
    syncButtons();
  }

  function stopRun() {
    if (runner) { runner.stop(); runner = null; }
    S.status = 'idle';
    syncButtons();
  }

  function restartRun() {
    var wasRunning = (S.status === 'running' || S.status === 'paused');
    stopRun();
    clearAll();
    if (wasRunning || true) startRun();
  }

  function clearAll() {
    journal = [];
    journalAttempt = 0;
    renderJournal();
    $('events').innerHTML = '';
    timeline.clear();
    if (network) network.clear();
    timeline.setWorkerCount(S.workers);
    for (var i = 0; i < S.workers; i++) {
      workerStates[i] = 'idle';
      workerLastEvent[i] = 0;
      setWorkerState(i, 'idle');
    }
    ['m-ops', 'm-commits', 'm-retries', 'm-aborts', 'm-rate'].forEach(function (id) { $(id).textContent = '0'; });
    $('m-efficiency').textContent = '—';
    $('events-count').textContent = '0';
    buildAccounts();
    updateInvariant(null);
  }

  function syncButtons() {
    $('btn-start').disabled = (S.status === 'running');
    $('btn-pause').disabled = (S.status !== 'running' && S.status !== 'paused');
    $('btn-pause').textContent = S.status === 'paused' ? '▶ Продолжить' : '⏸ Пауза';
  }

  // -------------------------------------------------------------------------
  // Обработка событий от потоков
  // -------------------------------------------------------------------------
  function clockOf(ev) { return S.mode === 'sim' ? ev.wall : ev.wall; }

  function onEvent(ev) {
    S.eventsSeen++;
    var t = clockOf(ev);
    if (t > S.clock) S.clock = t;
    var pid = ev.pid;
    workerLastEvent[pid] = t;

    switch (ev.ev) {
      case 'op-begin':
        timeline.attemptBegin(pid, t, ev.kind);
        setWorkerState(pid, 'compute', 'операция ' + ev.opId);
        if (ev.kind === 'transfer') {
          logEvent('info', '#' + pid + ' перевод ' + ev.amount + ' ₽ со счёта ' + letter(ev.from) + ' на ' + letter(ev.to));
        }
        break;

      case 'txn-begin':
        timeline.attemptBegin(pid, t, 'попытка ' + ev.attempt);
        if (pid === S.selectedPid) {
          journalAttempt = ev.attempt;
          journal = [];
          addJournal('начало транзакции, попытка ' + ev.attempt, '', '', '');
        }
        setWorkerState(pid, 'read', 'транзакция, попытка ' + ev.attempt);
        break;

      case 'step':
        handleStep(pid, ev, t);
        break;

      case 'spin':
        timeline.phase(pid, 'compute', t);
        setWorkerState(pid, 'compute', ev.label || 'вычисления');
        break;

      case 'idle':
        timeline.phase(pid, 'idle', t);
        setWorkerState(pid, 'idle', 'пауза между операциями');
        break;

      case 'wait':
      case 'locked':
        timeline.phase(pid, 'wait', t);
        setWorkerState(pid, 'wait', 'ожидание блокировки');
        break;

      case 'cas-success':
        setWorkerState(pid, 'commit', 'CAS удался' + (ev.spins ? ' после ' + ev.spins + ' повторов' : ''));
        network.send({ pid: pid, amount: ev.amount, status: 'ok', from: 0, to: 0 });
        break;

      case 'conflict':
        timeline.phase(pid, 'conflict', t);
        timeline.attemptEnd(pid, t, 'conflict');
        setWorkerState(pid, 'conflict', 'CAS не совпал → повтор');
        network.send({ pid: pid, amount: ev.amount, status: 'conflict', from: 0, to: 0 });
        logEvent('conflict', '#' + pid + ' конфликт CAS (попытка ' + ev.attempt + ') на счёте ' + letter(ev.acc));
        break;

      case 'txn-commit':
        timeline.phase(pid, 'commit', t);
        timeline.attemptEnd(pid, t, 'commit');
        setWorkerState(pid, 'commit', 'коммит');
        network.send({ from: ev.from, to: ev.to, amount: ev.amount, status: 'ok', pid: pid });
        if (pid === S.selectedPid) addJournal('транзакция зафиксирована (попытка ' + ev.attempt + ')', '', '', '');
        logEvent('commit', '#' + pid + ' перевод ' + ev.amount + ' ₽: ' + letter(ev.from) + ' → ' + letter(ev.to) +
          ' зафиксирован (попытка ' + ev.attempt + ')');
        break;

      case 'txn-conflict':
        timeline.phase(pid, 'conflict', t);
        timeline.attemptEnd(pid, t, 'conflict');
        setWorkerState(pid, 'conflict', 'конфликт → откат');
        network.send({ from: ev.from, to: ev.to, amount: ev.amount, status: 'conflict', pid: pid });
        if (pid === S.selectedPid) addJournal('конфликт версий → откат и повтор', '', '', '');
        logEvent('conflict', '#' + pid + ' перевод ' + ev.amount + ' ₽: ' + letter(ev.from) + ' → ' + letter(ev.to) +
          ' конфликт (попытка ' + ev.attempt + ') → откат и повтор');
        break;

      case 'txn-abort':
        timeline.attemptEnd(pid, t, 'abort');
        setWorkerState(pid, 'conflict', ev.reason === 'insufficient' ? 'нет средств' : 'отказ');
        if (ev.reason === 'insufficient') {
          network.send({ from: ev.from, to: ev.to, amount: ev.amount, status: 'abort', pid: pid });
          logEvent('abort', '#' + pid + ' перевод ' + ev.amount + ' ₽: ' + letter(ev.from) + ' → ' + letter(ev.to) +
            ' — недостаточно средств, транзакция отменена');
        } else {
          logEvent('abort', '#' + pid + ' отказ по причине ' + ev.reason);
        }
        break;

      case 'op-done':
        setWorkerState(pid, 'idle', 'операция завершена');
        break;

      default:
        break;
    }
  }

  function handleStep(pid, ev, t) {
    var acc = ev.acc;
    switch (ev.kind) {
      case 'begin':
        timeline.attemptBegin(pid, t, '');
        break;
      case 'read':
        timeline.phase(pid, 'read', t);
        setWorkerState(pid, 'read', 'чтение счёта ' + letter(acc));
        if (pid === S.selectedPid) addJournal('чтение', letter(acc), nf.format(ev.value), '');
        break;
      case 'load':
        timeline.phase(pid, 'read', t);
        setWorkerState(pid, 'read', 'чтение счёта ' + letter(acc));
        break;
      case 'write':
        timeline.phase(pid, 'compute', t);
        if (pid === S.selectedPid) addJournal('запись в журнал', letter(acc), nf.format(ev.value), '');
        break;
      case 'store':
        timeline.phase(pid, 'commit', t);
        if (pid === S.selectedPid) {
          addJournal(ev.unsynced ? 'запись в память БЕЗ синхронизации' : 'запись в память', letter(acc), nf.format(ev.value), '');
        }
        break;
      case 'cas':
        timeline.phase(pid, ev.ok ? 'commit' : 'conflict', t);
        if (pid === S.selectedPid) {
          addJournal('CAS ' + (ev.ok ? 'удачен' : 'не совпал') + (ev.lockBlocked ? ' (счёт занят)' : ''),
            letter(acc), ev.expected + ' → ' + ev.desired, '');
        }
        break;
      case 'lock':
        timeline.phase(pid, 'wait', t);
        if (!ev.ok) setWorkerState(pid, 'wait', 'ожидание блокировки');
        break;
      case 'unlock':
        break;
      case 'validate':
        timeline.phase(pid, 'validate', t);
        setWorkerState(pid, 'validate', ev.ok ? 'валидация пройдена' : 'валидация не прошла');
        if (pid === S.selectedPid) addJournal('валидация: ' + (ev.ok ? 'версии совпали' : 'обнаружен конфликт'), '', '', '');
        break;
      case 'commit':
        timeline.phase(pid, 'commit', t);
        setWorkerState(pid, 'commit', 'применяем изменения');
        flashAccounts(ev.accounts || [], 'commit');
        break;
      case 'rollback':
        timeline.phase(pid, 'conflict', t);
        if (ev.reason === 'conflict') flashAccounts([], 'conflict');
        break;
    }
  }

  function letter(i) {
    if (i === undefined || i === null) return '';
    return String.fromCharCode(65 + Number(i));
  }

  // -------------------------------------------------------------------------
  // Журнал выбранного потока
  // -------------------------------------------------------------------------
  function addJournal(what, acc, value, version) {
    journal.push({ what: what, acc: acc, value: value, version: version });
    if (journal.length > 26) journal.shift();
    renderJournal();
  }

  function renderJournal() {
    var body = $('journal-body');
    if (!journal.length) {
      body.innerHTML = '<tr><td colspan="4" class="dim">выберите поток и запустите демонстрацию</td></tr>';
      $('journal-state').textContent = '';
      return;
    }
    var cls = function (w) {
      if (/конфликт|откат|не прошла|не совпал/.test(w)) return 'r-conflict';
      if (/зафиксирована|коммит|удачен|запись в память/.test(w)) return 'r-commit';
      if (/^запись/.test(w)) return 'r-write';
      if (/^чтение/.test(w)) return 'r-read';
      return '';
    };
    var html = '';
    for (var i = journal.length - 1; i >= 0; i--) {
      var r = journal[i];
      html += '<tr class="' + cls(r.what) + '"><td>' + r.what + '</td><td>' + (r.acc || '') +
        '</td><td>' + (r.value || '') + '</td><td>' + (r.version || '') + '</td></tr>';
    }
    body.innerHTML = html;
    $('journal-state').textContent = 'попытка №' + (journalAttempt || 1);
  }

  // -------------------------------------------------------------------------
  // Состояния потоков и счётчики
  // -------------------------------------------------------------------------
  var STATE_TEXT = { idle: 'пауза/ожидание', read: 'чтение', compute: 'вычисления', validate: 'валидация', commit: 'коммит', conflict: 'конфликт', wait: 'ожидание блокировки' };

  function setWorkerState(pid, state, detail) {
    workerStates[pid] = state;
    var el = $('w-' + pid);
    if (!el) return;
    el.setAttribute('data-state', state);
    var s = $('ws-' + pid);
    if (s) s.textContent = detail || STATE_TEXT[state] || state;
  }

  function flashAccounts(accounts, kind) {
    for (var i = 0; i < accounts.length; i++) {
      accountsFlash.push({ acc: Number(accounts[i]), kind: kind, until: performance.now() + 220 });
    }
  }

  // -------------------------------------------------------------------------
  // Отрисовка по таймеру
  // -------------------------------------------------------------------------
  function tickUI() {
    requestAnimationFrame(tickUI);
    if (!runner || !runner.mem) { timeline.render(S.clock || performance.now() - 5000); return; }

    var snap = runner.snapshot();
    if (!snap) return;

    drawAccounts(snap);
    drawNetwork(snap);
    drawWorkers(snap);
    drawMetrics(snap);
    updateInvariant(snap);
    timeline.render(S.clock || performance.now());
  }

  function drawAccounts(snap) {
    var sum = 0;
    for (var i = 0; i < snap.balances.length; i++) sum += snap.balances[i];
    for (var a = 0; a < snap.balances.length; a++) {
      var bal = $('bal-' + a);
      if (!bal) continue;
      bal.textContent = nf.format(snap.balances[a]) + ' ₽';
      $('ver-' + a).textContent = snap.versions[a];
      var share = sum > 0 ? Math.round(snap.balances[a] / sum * 100) : 0;
      $('share-' + a).textContent = share + '% от суммы';
      $('bar-' + a).style.width = Math.max(0, Math.min(100, share)) + '%';

      var locked = runner.mem.isLocked(a);
      var el = $('acc-' + a);
      el.classList.toggle('locked', !!locked);
      $('lock-' + a).innerHTML = locked ? '<span class="lock-badge">🔒 заблокирован</span>' : '';
    }

    // подсветка изменений
    var now = performance.now();
    var flashCommit = {}, flashConflict = {};
    for (var f = accountsFlash.length - 1; f >= 0; f--) {
      var fl = accountsFlash[f];
      if (fl.until < now) { accountsFlash.splice(f, 1); continue; }
      if (fl.kind === 'commit') flashCommit[fl.acc] = true; else flashConflict[fl.acc] = true;
    }
    for (var k = 0; k < snap.balances.length; k++) {
      var el2 = $('acc-' + k);
      if (!el2) continue;
      el2.classList.toggle('flash-commit', !!flashCommit[k]);
      el2.classList.toggle('flash-conflict', !!flashConflict[k]);
    }
  }

  function drawNetwork(snap) {
    if (!network) return;
    network.setAccounts(snap.balances, snap.versions, function (i) { return runner.mem.isLocked(i); });
    network.render(performance.now());
  }

  function drawWorkers(snap) {
    var now = S.mode === 'sim' ? S.clock - 400 : Date.now() - 900;
    for (var pid = 0; pid < snap.workerStats.length; pid++) {
      var st = snap.workerStats[pid];
      var el = $('wst-' + pid);
      if (el) el.textContent = 'оп ' + st.ops + ' · retry ' + st.retries + ' · ожид ' + st.spins;
      if (workerLastEvent[pid] && workerLastEvent[pid] < now && workerStates[pid] !== 'idle') {
        setWorkerState(pid, 'idle', 'пауза между операциями');
      }
    }
    for (var a = 0; a < snap.balances.length; a++) {
      var le = $('lock-' + a);
      if (le && !runner.mem.isLocked(a)) le.textContent = '';
    }
  }

  function drawMetrics(snap) {
    $('m-ops').textContent = nf.format(snap.ops);
    $('m-commits').textContent = nf.format(snap.commits);
    $('m-retries').textContent = nf.format(snap.retries);
    $('m-aborts').textContent = nf.format(snap.aborts);

    var now = performance.now();
    if (now - S.lastOpsAt > 700) {
      S.rate = (snap.ops - S.lastOps) / ((now - S.lastOpsAt) / 1000);
      S.lastOps = snap.ops;
      S.lastOpsAt = now;
      $('m-rate').textContent = nf2.format(S.rate);
    }
    var attempts = snap.commits + snap.retries;
    $('m-efficiency').textContent = attempts ? nf2.format(snap.commits / attempts * 100) + '%' : '—';
    $('events-count').textContent = nf.format(S.eventsSeen);
  }

  function updateInvariant(snap) {
    var box = $('invariant'), body = $('inv-body');
    if (!snap) {
      box.className = 'invariant';
      body.textContent = 'ожидание запуска';
      return;
    }

    // Снимок памяти и счётчики читаются в разные моменты, поэтому на границе
    // операции «на один кадр» возможна видимая разница. Показываем тревогу
    // только если расхождение держится дольше 450 мс — это уже реальная гонка.
    var mismatch = (S.demo === 1)
      ? (snap.sum !== S.total + snap.ops * S.amount)
      : (snap.sum !== S.total);
    var nowMs = performance.now();
    if (mismatch) {
      if (!S.invBadSince) S.invBadSince = nowMs;
      if (nowMs - S.invBadSince < 450) {
        box.className = 'invariant';
        body.innerHTML = 'сверка значений…';
        return;
      }
    } else {
      S.invBadSince = 0;
    }

    if (S.demo === 1) {
      var expected = S.total + snap.ops * S.amount;
      var lost = expected - snap.sum;
      if (lost === 0) {
        box.className = 'invariant ok';
        body.innerHTML = 'Все пополнения учтены: ' + nf.format(snap.sum) + ' ₽ ✔';
      } else {
        box.className = 'invariant bad';
        body.innerHTML = 'Потеряно ' + nf.format(lost) + ' ₽ из ' + nf.format(snap.ops * S.amount) +
          '<br><span class="small">на счету ' + nf.format(snap.sum) + ' вместо ' + nf.format(expected) + '</span>';
      }
    } else {
      var diff = snap.sum - S.total;
      if (diff === 0) {
        box.className = 'invariant ok';
        body.innerHTML = 'Сумма на счетах ' + nf.format(snap.sum) + ' ₽ — не изменилась ✔';
      } else {
        box.className = 'invariant bad';
        body.innerHTML = (diff > 0 ? 'Деньги появились: +' : 'Деньги потеряны: ') + nf.format(Math.abs(diff)) + ' ₽' +
          '<br><span class="small">сумма ' + nf.format(snap.sum) + ' вместо ' + nf.format(S.total) + '</span>';
      }
    }
  }

  var lastLog = 0;
  function logEvent(kind, text) {
    var box = $('events');
    if (!box) return;
    var now = new Date();
    var stamp = String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0') +
      '.' + String(now.getMilliseconds()).padStart(3, '0');
    var d = document.createElement('div');
    d.className = 'e-' + kind;
    d.textContent = stamp + '  ' + text;
    box.insertBefore(d, box.firstChild);
    while (box.childNodes.length > 130) box.removeChild(box.lastChild);
  }

  // -------------------------------------------------------------------------
  // Органы управления
  // -------------------------------------------------------------------------
  function setupControls() {
    var w = $('workers');
    w.addEventListener('input', function () {
      S.workers = Number(this.value);
      $('workers-val').textContent = S.workers;
      buildWorkerGrid();
      restartRun();
    });

    var work = $('work');
    work.addEventListener('input', function () {
      S.workUs = Number(this.value);
      $('work-val').textContent = S.workUs;
      if (runner) runner.setWorkUs(S.workUs);
    });

    var gap = $('gap');
    gap.addEventListener('input', function () {
      S.gapMs = Number(this.value);
      $('gap-val').textContent = S.gapMs;
      if (runner) runner.setGapMs(S.gapMs);
    });

    var sp = $('speed');
    sp.addEventListener('input', function () {
      S.speed = Number(this.value);
      $('speed-val').textContent = S.speed;
      if (runner) runner.setSpeed(S.speed);
    });

    $('boost').addEventListener('change', function () {
      S.boost = this.checked;
      if (runner) runner.setConflictBoost(S.boost);
    });

    $('btn-start').addEventListener('click', startRun);
    $('btn-pause').addEventListener('click', function () {
      if (S.status === 'running') { runner.pause(true); S.status = 'paused'; }
      else if (S.status === 'paused') { runner.pause(false); S.status = 'running'; }
      syncButtons();
    });
    $('btn-reset').addEventListener('click', function () { stopRun(); clearAll(); });

    setupTempo();

    $('pid-select').addEventListener('change', function () {
      S.selectedPid = Number(this.value);
      journal = [];
      renderJournal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        if (S.status === 'running') { runner.pause(true); S.status = 'paused'; }
        else if (S.status === 'paused') { runner.pause(false); S.status = 'running'; }
        else startRun();
        syncButtons();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Инициализация
  // -------------------------------------------------------------------------
  function init() {
    timeline = new window.Timeline($('timeline'), { windowMs: TEMPO.normal.windowMs });
    network = new window.NetworkView($('network'), {});

    // Небольшая отладочная ручка: состояние стенда видно из консоли браузера
    // (и используется автотестами интерфейса).
    window.STMLab = {
      get state() { return S; },
      get runner() { return runner; },
      get network() { return network; },
      get timeline() { return timeline; },
      tempo: function (name) { applyTempo(name); },
      start: function () { startRun(); },
      reset: function () { stopRun(); clearAll(); }
    };
    setupTabs();
    setupControls();
    applyDemo('demo1', false);
    buildAccounts();
    buildWorkerGrid();
    updateInvariant(null);

    if (window.Runner.supportsRealThreads()) {
      $('mode-badge').className = 'badge badge-real';
      $('mode-badge').textContent = '● настоящие потоки доступны';
      $('mode-note').textContent = 'SharedArrayBuffer разрешён: будут запущены Web Workers с общей памятью и Atomics.';
      $('field-speed').style.display = 'none';
    } else {
      $('mode-badge').className = 'badge badge-sim';
      $('mode-badge').textContent = '● будет использован симулятор планировщика';
      $('mode-note').textContent = window.isSecureContext === false
        ? 'Страница открыта не через сервер (file://). Запустите: node server.js'
        : 'Браузер не разрешил SharedArrayBuffer (нужны заголовки COOP/COEP). Алгоритм тот же — только планировщик модельный.';
    }

    tickUI();
    // Демонстрация стартует сама — чтобы не пришлось искать кнопку.
    setTimeout(function () { if (S.status === 'idle') startRun(); }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
