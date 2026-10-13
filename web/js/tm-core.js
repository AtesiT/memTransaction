/*
 * tm-core.js — ядро транзакционной памяти (общий код для браузера и Node)
 * ===========================================================================
 *
 * Зачем этот файл
 * ---------------
 * В задании два примера функционала:
 *   1) «Симуляция механизма STM на чистом C# (через CAS-операции)» —
 *      оптимистичная блокировка через Interlocked.CompareExchange.
 *   2) «Использование STM-подхода для связанных объектов» — транзакционный
 *      перевод денег между счетами (Transactional<T> + TransactionContext).
 *
 * Здесь реализованы оба механизма на JavaScript:
 *   - аналог Interlocked.CompareExchange  ->  Atomics.compareExchange
 *   - локальный журнал транзакции (read-set / write-set)
 *   - версии ячеек памяти           (validation = «Проверка конфликтов»)
 *   - фиксация (commit) и откат (rollback) + автоматический повтор (retry)
 *
 * Ключевое архитектурное решение
 * ------------------------------
 * Алгоритм каждой операции написан ОДИН раз — в виде генератора шагов:
 *
 *      yield { t: 'READ', acc: 0 }
 *
 * Генератор ничего не знает про потоки. Его «крутит» драйвер (StepDriver),
 * который выполняет ровно один шаг за вызов stepOnce():
 *
 *   * worker.js      — реальный поток (Web Worker + SharedArrayBuffer).
 *                      Драйвер вызывает шаги без остановки, SPIN = реальное
 *                      вращение процессора, конфликты настоящие.
 *   * sim-engine.js  — симулятор планировщика: между шагами управление
 *                      возвращается планировщику, который перемешивает
 *                      порядок «потоков» и тем самым создаёт конфликты.
 *
 * За счёт этого визуализация и реальный режим исполняют одну и ту же логику.
 *
 * Аналогии с C# (для переноса на .NET MAUI):
 *   Interlocked.CompareExchange(ref _balance, next, cur)  <->  Mem.casBalance()
 *   Thread.SpinWait(n)                                    <->  busySpin()
 *   lock (obj) / Monitor.Enter                            <->  Mem.acquireLock()
 *   Task.Run(() => ...)                                   <->  new Worker(...)
 * ===========================================================================
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TMCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Раскладка общей памяти (один Int32Array на всех "потоков")
  // ---------------------------------------------------------------------------
  var MAX_WORKERS = 32;
  var MAX_ACCOUNTS = 8;

  var H = {                      // индексы заголовка
    COMMITS: 0,                  // успешных фиксаций всего
    RETRIES: 1,                  // откатов из-за конфликтов (retry)
    OPS: 2,                      // выполненных операций (зачислений/переводов)
    STOP: 3,                     // 1 = потоки должны завершиться
    ALIVE: 4,                    // сколько воркеров ещё работает
    ACCOUNTS: 5,                 // сколько счетов реально используется
    ABORTS: 6,                   // отказов по бизнес-логике (недостаточно средств)
    WORK_US: 7,                  // «тяжёлая работа» внутри транзакции, микросекунды
    DEMO: 8,                     // 1 = зачисление (CAS), 2 = переводы (STM)
    CONFLICT_BOOST: 9,           // 1 = агрессивный режим конфликтов
    PAUSE: 10,                   // 1 = пауза (проверяется между операциями)
    RESERVED: 11
  };

  var STATS_OFFSET = 16;         // статистика воркеров: [commits, retries, ops, spins]
  var STATS_STRIDE = 4;
  var BALANCE_OFFSET = STATS_OFFSET + MAX_WORKERS * STATS_STRIDE;   // 16 + 128 = 144
  var VERSION_OFFSET = BALANCE_OFFSET + MAX_ACCOUNTS;               // 144 + 8  = 152
  var LOCK_OFFSET = VERSION_OFFSET + MAX_ACCOUNTS;                  // 152 + 8  = 160
  var WRITER_OFFSET = LOCK_OFFSET + MAX_ACCOUNTS;                   // 160 + 8  = 168 (кто писал: pid+1)
  var TOTAL_INTS = 256;

  // ---------------------------------------------------------------------------
  // 2. Техники синхронизации (то, что переключается в интерфейсе)
  // ---------------------------------------------------------------------------
  var MAX_RETRIES = 5000;   // предохранитель от бесконечного «живого» ожидания

  // Номер "виртуального счёта" для глобальной блокировки фиксации.
  // Нужна, чтобы валидация и коммит были неделимы относительно друг друга
  // (иначе несколько потоков одновременно пройдут валидацию и испортят данные).
  var COMMIT_LOCK_SLOT = MAX_ACCOUNTS;

  var TECHNIQUE = {
    STM: 1,        // оптимистичная транзакционная память
    LOCK: 2,       // пессимистичная блокировка (спин-лок)
    CAS: 3,        // оптимистичная блокировка через CAS-цикл (пример 1 задания)
    UNSAFE: 4      // без синхронизации — специально сломанный режим для сравнения
  };

  var TECHNIQUE_NAME = {
    1: 'STM (транзакции)',
    2: 'Блокировка (lock)',
    3: 'CAS-цикл',
    4: 'Без синхронизации'
  };

  // ---------------------------------------------------------------------------
  // 3. Доступ к общей памяти
  // ---------------------------------------------------------------------------
  /**
   * @param {Int32Array} int32              — буфер (из SharedArrayBuffer или обычный)
   * @param {boolean}    useAtomics         — использовать атомарные операции
   */
  function Mem(int32, useAtomics) {
    this.i32 = int32;
    this.useAtomics = !!useAtomics;
  }

  Mem.prototype._load = function (i) {
    return this.useAtomics ? Atomics.load(this.i32, i) : this.i32[i];
  };
  Mem.prototype._store = function (i, v) {
    if (this.useAtomics) Atomics.store(this.i32, i, v); else this.i32[i] = v;
  };
  Mem.prototype._add = function (i, v) {
    if (this.useAtomics) return Atomics.add(this.i32, i, v);
    var old = this.i32[i]; this.i32[i] = old + v; return old;
  };
  Mem.prototype._cas = function (i, expected, desired) {
    if (this.useAtomics) return Atomics.compareExchange(this.i32, i, expected, desired);
    var old = this.i32[i];
    if (old === expected) this.i32[i] = desired;
    return old;
  };

  // --- заголовок ------------------------------------------------------------
  Mem.prototype.get = function (key) { return this._load(key); };
  Mem.prototype.set = function (key, v) { this._store(key, v); };
  Mem.prototype.bump = function (key, v) { this._add(key, v === undefined ? 1 : v); };
  Mem.prototype.isStopped = function () { return this._load(H.STOP) !== 0; };

  // --- счета ----------------------------------------------------------------
  // ВАЖНО: индекс счёта всегда приводится к числу. В read-set журнала ключи
  // строковые (Object.keys даёт строки), а `152 + '0'` в JS — это склейка
  // строк "1520", а не 153. Такая ошибка приводит к вечному retry.
  function acc2int(acc) { return Number(acc) | 0; }

  Mem.prototype.balance = function (acc) { return this._load(BALANCE_OFFSET + acc2int(acc)); };
  Mem.prototype.version = function (acc) { return this._load(VERSION_OFFSET + acc2int(acc)); };
  Mem.prototype.bumpVersion = function (acc) { this._add(VERSION_OFFSET + acc2int(acc), 1); };
  Mem.prototype.writerOf = function (acc) { return this._load(WRITER_OFFSET + acc2int(acc)); };

  /** Аналог Interlocked.CompareExchange(ref _balance, next, cur). */
  Mem.prototype.casBalance = function (acc, expected, desired, pid) {
    acc = acc2int(acc);
    var idx = BALANCE_OFFSET + acc;
    var was = this._cas(idx, expected, desired);
    if (was === expected) {
      this.bumpVersion(acc);              // публикуем новую версию ячейки
      this._store(WRITER_OFFSET + acc, (pid || 0) + 1);
      return true;
    }
    return false;
  };

  /** Безусловная запись (используется после победы в CAS или внутри блокировки). */
  Mem.prototype.storeBalance = function (acc, value, pid) {
    this._store(BALANCE_OFFSET + acc, value);
  };

  // --- спин-блокировки (пессимистичный подход, для сравнения) ----------------
  Mem.prototype.acquireLock = function (acc) {
    return this._cas(LOCK_OFFSET + acc2int(acc), 0, 1) === 0;
  };
  Mem.prototype.releaseLock = function (acc) {
    this._store(LOCK_OFFSET + acc2int(acc), 0);
  };
  Mem.prototype.isLocked = function (acc) {
    return this._load(LOCK_OFFSET + acc2int(acc)) !== 0;
  };

  // --- статистика по потокам ------------------------------------------------
  Mem.prototype.workerStat = function (pid, field) {
    return this._load(STATS_OFFSET + pid * STATS_STRIDE + field);
  };
  Mem.prototype.workerStatAdd = function (pid, field, v) {
    this._add(STATS_OFFSET + pid * STATS_STRIDE + field, v === undefined ? 1 : v);
  };

  // ---------------------------------------------------------------------------
  // 4. Локальный контекст транзакции (журнал потока)
  // ---------------------------------------------------------------------------
  /**
   * Журнал транзакции. Живёт в потоке-исполнителе и НИКОГДА не шарится между
   * потоками — ровно как описано в лекции: «Поток выполняет все операции
   * внутри транзакции в своём изолированном пространстве (лог транзакции)».
   */
  function TxnLog() {
    this.reset();
  }
  TxnLog.prototype.reset = function () {
    this.readSet = {};    // acc -> версия, которую мы прочитали
    this.readValues = {}; // acc -> значение, которое мы прочитали
    this.writeSet = {};   // acc -> новое значение
    this.attempt = 0;     // номер попытки (для визуализации retry)
    this.reads = 0;
    this.writes = 0;
  };
  /**
   * Чтение внутри транзакции.
   *
   * ВАЖНО (почему так сложно). Пара «значение + версия» должна быть согласована.
   * Если прочитать сначала значение, а потом версию, то между этими двумя
   * чтениями другой поток может успеть зафиксировать транзакцию: мы запомним
   * СТАРОЕ значение, но НОВУЮ версию — и валидация ошибочно пропустит коммит
   * (потерянное обновление). В реальных многопоточных программах это
   * воспроизводится, в симуляторе — нет, поэтому баг легко пропустить.
   *
   * Решение — приём seqlock: читаем версию ДО и ПОСЛЕ значения и повторяем,
   * если версия изменилась или счёт находится под чужой блокировкой.
   * Повторное чтение той же ячейки возвращает своё же записанное значение
   * (read-your-writes), как в настоящей STM.
   */
  TxnLog.prototype.read = function (mem, acc) {
    acc = Number(acc);
    if (this.writeSet[acc] !== undefined) return this.writeSet[acc];

    var tries = 0;
    for (;;) {
      var vBefore = mem.version(acc);
      var value = mem.balance(acc);
      var vAfter = mem.version(acc);
      if (vBefore === vAfter && !mem.isLocked(acc)) {
        this.readSet[acc] = vBefore;      // именно эта версия попадёт в валидацию
        this.readValues[acc] = value;
        this.reads++;
        return value;
      }
      if (++tries > 1000000) {            // теоретическая защита от вечного голодания
        this.readSet[acc] = vAfter;
        this.readValues[acc] = value;
        this.reads++;
        return value;
      }
    }
  };
  TxnLog.prototype.write = function (acc, value) {
    this.writeSet[acc] = value;
    this.writes++;
  };
  /**
   * Валидация read-set: не изменили ли читаемые ячейки другие потоки.
   * Дополнительно проверяем, что ни один затрагиваемый счёт не захвачен
   * «пессимистичным» потоком (метод lock): иначе его устаревшее значение
   * затрёт наш коммит. Так же поступает TL2 — конфликтует с чужой блокировкой.
   */
  TxnLog.prototype.validate = function (mem) {
    for (var acc in this.readSet) {
      if (mem.version(Number(acc)) !== this.readSet[acc]) return false;
    }
    for (var w in this.writeSet) {
      if (mem.isLocked(Number(w))) return false;
    }
    for (var r in this.readSet) {
      if (mem.isLocked(Number(r))) return false;
    }
    return true;
  };
  /** Применение write-set к общей памяти («Фиксация (Commit)»). */
  TxnLog.prototype.commit = function (mem, pid) {
    for (var acc in this.writeSet) {
      mem.storeBalance(Number(acc), this.writeSet[acc], pid);
      mem.bumpVersion(Number(acc));
    }
  };
  TxnLog.prototype.touchedAccounts = function () {
    var out = {};
    for (var a in this.readSet) out[a] = true;
    for (var b in this.writeSet) out[b] = true;
    return Object.keys(out).map(Number);
  };

  // ---------------------------------------------------------------------------
  // 5. Состояние одного "потока"
  // ---------------------------------------------------------------------------
  function WorkerContext(pid, mem, demo, opts) {
    this.pid = pid;
    this.mem = mem;
    this.demo = demo;                       // 1 = зачисление, 2 = переводы
    this.txn = new TxnLog();
    this.opts = opts || {};
    this.stopRequested = false;
    this.seq = 0;                           // сквозной номер операции
    this.trySeq = 0;                        // сквозной номер попытки транзакции
    this.currentOp = null;                  // { id, kind, acc, amount }
    this.stats = { commits: 0, retries: 0, ops: 0, aborts: 0, spins: 0 };
    this.emit = this.opts.emit || function () {};
  }

  WorkerContext.prototype.nextOp = function (state) {
    this.seq++;
    if (this.demo === 1) {
      var acc = state.depositAccount !== undefined ? state.depositAccount : 0;
      this.currentOp = { id: this.seq, kind: 'deposit', acc: acc, amount: state.depositAmount || 10 };
    } else {
      var n = state.accounts || 4;
      var from = Math.floor(Math.random() * n);
      var to = Math.floor(Math.random() * n);
      while (to === from) to = Math.floor(Math.random() * n);
      this.currentOp = {
        id: this.seq, kind: 'transfer', from: from, to: to,
        amount: 1 + Math.floor(Math.random() * Math.max(1, Math.min(50, state.transferMax || 50)))
      };
    }
    this.txn.reset();
    return this.currentOp;
  };

  // ---------------------------------------------------------------------------
  // 6. ШАГИ АЛГОРИТМА (генераторы) — сердце демонстрации
  // ---------------------------------------------------------------------------
  // Все операции описаны через yield-шаги. Список шагов:
  //   { t:'BEGIN' }                          — «начало транзакции»
  //   { t:'READ',  acc }              -> int  — чтение с фиксацией версии
  //   { t:'WRITE', acc, value }               — запись в локальный журнал
  //   { t:'SPIN',  us, label }                — «тяжёлая работа» / модельная задержка
  //   { t:'VALIDATE' }               -> bool  — проверка конфликтов
  //   { t:'COMMIT' }                          — публикация write-set
  //   { t:'ROLLBACK', reason }                — откат
  //   { t:'CAS',   acc, expected, desired } -> bool
  //   { t:'LOAD',  acc }              -> int
  //   { t:'STORE', acc, value }
  //   { t:'LOCK',  acc }              -> bool
  //   { t:'UNLOCK', acc }
  //   { t:'SLEEP', us }                       — пауза между операциями (вне транзакции)

  /**
   * Захват блокировки счёта «пессимистичным» потоком.
   *
   * Захват выполняется ПОД глобальной блокировкой фиксации. Это принципиально:
   * иначе возможна такая последовательность, при которой транзакция (STM)
   * провалидируется, «пессимистичный» поток сразу после этого прочитает
   * устаревшее значение и затрёт результат коммита. Взаимная блокировка при
   * этом невозможна: счета захватываются в порядке возрастания номера,
   * а глобальная блокировка держится только на время самого захвата.
   */
  function* lockAccount(ctx, acc, op) {
    var mem = ctx.mem;
    for (;;) {
      var gotGlobal = yield { t: 'LOCK', acc: COMMIT_LOCK_SLOT, label: 'commit-lock', opId: op.id };
      if (!gotGlobal) {
        yield { t: 'SPIN', us: 12, label: 'ожидание фиксации', opId: op.id };
        continue;
      }
      if (mem.isLocked(acc)) {                     // счёт занят другим потоком
        yield { t: 'UNLOCK', acc: COMMIT_LOCK_SLOT, label: 'commit-lock', opId: op.id };
        yield { t: 'SPIN', us: 12, label: 'ожидание счёта', opId: op.id };
        ctx.emit({ ev: 'wait', pid: ctx.pid, opId: op.id, acc: acc });
        continue;
      }
      yield { t: 'LOCK_UNDER_COMMIT', acc: acc, opId: op.id };   // собственно захват
      yield { t: 'UNLOCK', acc: COMMIT_LOCK_SLOT, label: 'commit-lock', opId: op.id };
      ctx.emit({ ev: 'locked', pid: ctx.pid, opId: op.id, acc: acc });
      return true;
    }
  }

  /** ПРИМЕР 1 из задания: зачисление через CAS-цикл (оптимистичная блокировка). */
  function* depositViaCas(ctx, state) {
    for (;;) {
      if (ctx.stopRequested) return;
      var op = ctx.nextOp(state);
      ctx.emit({ ev: 'op-begin', pid: ctx.pid, opId: op.id, kind: 'deposit', acc: op.acc, amount: op.amount });

      var spins = 0;
      for (;;) {                            // do { ... } while (CAS != current)
        var cur = yield { t: 'LOAD', acc: op.acc, opId: op.id };
        var next = cur + op.amount;
        yield { t: 'SPIN', us: state.workUs, label: 'вычисление', opId: op.id };
        var ok = yield { t: 'CAS', acc: op.acc, expected: cur, desired: next, opId: op.id, opEnd: true };
        if (ok) { ctx.emit({ ev: 'cas-success', pid: ctx.pid, opId: op.id, spins: spins }); break; }
        spins++;
        ctx.stats.retries++;
        ctx.mem.bump(H.RETRIES);
        ctx.mem.workerStatAdd(ctx.pid, 1, 1);
        ctx.emit({ ev: 'conflict', pid: ctx.pid, opId: op.id, kind: 'cas', acc: op.acc, attempt: spins });
        if (spins > MAX_RETRIES) break;     // защита от «живой блокировки»
      }

      yield { t: 'SLEEP', us: state.gapUs };
    }
  }

  /** Демо 1 «специально сломанный» режим: без CAS — потерянные обновления. */
  function* depositUnsafe(ctx, state) {
    for (;;) {
      if (ctx.stopRequested) return;
      var op = ctx.nextOp(state);
      ctx.emit({ ev: 'op-begin', pid: ctx.pid, opId: op.id, kind: 'deposit', acc: op.acc, amount: op.amount });
      var cur = yield { t: 'LOAD', acc: op.acc, opId: op.id };
      yield { t: 'SPIN', us: state.workUs, label: 'вычисление', opId: op.id };
      yield { t: 'STORE', acc: op.acc, value: cur + op.amount, opId: op.id, unsynced: true, opEnd: true };
      yield { t: 'SLEEP', us: state.gapUs };
    }
  }

  /** Демо 1 через пессимистичную блокировку — для сравнения подходов. */
  function* depositViaLock(ctx, state) {
    for (;;) {
      if (ctx.stopRequested) return;
      var op = ctx.nextOp(state);
      ctx.emit({ ev: 'op-begin', pid: ctx.pid, opId: op.id, kind: 'deposit', acc: op.acc, amount: op.amount });
      yield* lockAccount(ctx, op.acc, op);
      var cur = yield { t: 'LOAD', acc: op.acc, opId: op.id };
      yield { t: 'SPIN', us: state.workUs, label: 'крит. секция', opId: op.id };
      yield { t: 'STORE', acc: op.acc, value: cur + op.amount, opId: op.id, underLock: true, opEnd: true };
      yield { t: 'UNLOCK', acc: op.acc, opId: op.id };
      yield { t: 'SLEEP', us: state.gapUs };
    }
  }

  /**
   * ПРИМЕР 2 из задания: перевод между счетами внутри транзакции
   * (аналог TransactionManager / TxContext.ExecuteInTransaction + Transactional<T>).
   */
  function* transferViaStm(ctx, state) {
    for (;;) {
      if (ctx.stopRequested) return;
      var op = ctx.nextOp(state);
      ctx.emit({ ev: 'op-begin', pid: ctx.pid, opId: op.id, kind: 'transfer', from: op.from, to: op.to, amount: op.amount });

      var attempt = 0;
      for (;;) {
        attempt++;
        var tryId = ++ctx.trySeq;
        yield { t: 'BEGIN' };
        ctx.emit({ ev: 'txn-begin', pid: ctx.pid, opId: op.id, tryId: tryId, attempt: attempt });

        var from = yield { t: 'READ', acc: op.from, opId: op.id, tryId: tryId };
        var to = yield { t: 'READ', acc: op.to, opId: op.id, tryId: tryId };

        if (from < op.amount) {                       // бизнес-отказ, не конфликт
          ctx.emit({ ev: 'txn-abort', pid: ctx.pid, opId: op.id, tryId: tryId, reason: 'insufficient' });
          yield { t: 'ROLLBACK', reason: 'insufficient', opId: op.id, tryId: tryId, opEnd: true };
          break;
        }

        yield { t: 'SPIN', us: state.workUs, label: 'вычисления', opId: op.id, tryId: tryId };
        yield { t: 'WRITE', acc: op.from, value: from - op.amount, opId: op.id, tryId: tryId };
        yield { t: 'WRITE', acc: op.to, value: to + op.amount, opId: op.id, tryId: tryId };

        // --- Фаза фиксации (commit phase) -----------------------------------
        // Валидация и запись должны быть НЕДЕЛИМЫ, иначе два потока успеют
        // провалидироваться на одной и той же версии и оба запишут устаревшие
        // значения. Поэтому фиксация идёт через короткий критический участок:
        // ровно так же поступают реальные STM (TL2 блокирует write-set).
        var gotCommit = false;
        var waits = 0;
        while (!gotCommit) {
          gotCommit = yield { t: 'LOCK', acc: COMMIT_LOCK_SLOT, label: 'commit-lock', opId: op.id, tryId: tryId };
          if (!gotCommit) {
            waits++;
            yield { t: 'SPIN', us: 0, label: 'ожидание фиксации', opId: op.id, tryId: tryId };
          }
        }

        var valid = yield { t: 'VALIDATE', opId: op.id, tryId: tryId };
        if (!valid) {
          yield { t: 'UNLOCK', acc: COMMIT_LOCK_SLOT, label: 'commit-lock', opId: op.id, tryId: tryId };
          ctx.stats.retries++;
          ctx.mem.bump(H.RETRIES);
          ctx.mem.workerStatAdd(ctx.pid, 1, 1);
          yield { t: 'ROLLBACK', reason: 'conflict' };
          ctx.emit({ ev: 'txn-conflict', pid: ctx.pid, opId: op.id, tryId: tryId, attempt: attempt });
          if (attempt > MAX_RETRIES) {                // теоретический livelock
            ctx.stats.aborts++;
            ctx.mem.bump(H.ABORTS);
            ctx.emit({ ev: 'txn-abort', pid: ctx.pid, opId: op.id, tryId: tryId, reason: 'livelock' });
            break;
          }
          continue;                                   // Retry: транзакция целиком заново
        }

        yield { t: 'COMMIT', opId: op.id, tryId: tryId, opEnd: true };
        yield { t: 'UNLOCK', acc: COMMIT_LOCK_SLOT, label: 'commit-lock', opId: op.id, tryId: tryId };
        ctx.emit({ ev: 'txn-commit', pid: ctx.pid, opId: op.id, tryId: tryId, attempt: attempt });
        break;
      }

      yield { t: 'SLEEP', us: state.gapUs };
    }
  }

  /** Демо 2 без синхронизации — наглядно ломаем инвариант суммы. */
  function* transferUnsafe(ctx, state) {
    for (;;) {
      if (ctx.stopRequested) return;
      var op = ctx.nextOp(state);
      ctx.emit({ ev: 'op-begin', pid: ctx.pid, opId: op.id, kind: 'transfer', from: op.from, to: op.to, amount: op.amount });
      var from = yield { t: 'LOAD', acc: op.from, opId: op.id };
      var to = yield { t: 'LOAD', acc: op.to, opId: op.id };
      yield { t: 'SPIN', us: state.workUs, label: 'вычисления', opId: op.id };
      if (from >= op.amount) {
        yield { t: 'STORE', acc: op.from, value: from - op.amount, opId: op.id, unsynced: true };
        yield { t: 'STORE', acc: op.to, value: to + op.amount, opId: op.id, unsynced: true, opEnd: true };
        ctx.emit({ ev: 'txn-commit', pid: ctx.pid, opId: op.id, attempt: 1, unsynced: true });
      } else {
        ctx.emit({ ev: 'txn-abort', pid: ctx.pid, opId: op.id, reason: 'insufficient' });
        yield { t: 'ROLLBACK', reason: 'insufficient', opId: op.id, opEnd: true };
      }
      yield { t: 'SLEEP', us: state.gapUs };
    }
  }

  /**
   * Демо 2 на пессимистичных блокировках. Счета захватываются в порядке
   * возрастания индекса — это исключает взаимную блокировку (deadlock),
   * о возможности которой предупреждает лекция.
   */
  function* transferViaLock(ctx, state) {
    for (;;) {
      if (ctx.stopRequested) return;
      var op = ctx.nextOp(state);
      ctx.emit({ ev: 'op-begin', pid: ctx.pid, opId: op.id, kind: 'transfer', from: op.from, to: op.to, amount: op.amount });

      // Счета захватываются в порядке возрастания номера (защита от deadlock).
      var first = Math.min(op.from, op.to);
      var second = Math.max(op.from, op.to);
      yield* lockAccount(ctx, first, op);
      if (second !== first) yield* lockAccount(ctx, second, op);

      var from = yield { t: 'LOAD', acc: op.from, opId: op.id };
      var to = yield { t: 'LOAD', acc: op.to, opId: op.id };
      yield { t: 'SPIN', us: state.workUs, label: 'крит. секция', opId: op.id };

      if (from >= op.amount) {
        yield { t: 'STORE', acc: op.from, value: from - op.amount, opId: op.id, underLock: true };
        yield { t: 'STORE', acc: op.to, value: to + op.amount, opId: op.id, underLock: true, opEnd: true };
        ctx.emit({ ev: 'txn-commit', pid: ctx.pid, opId: op.id, attempt: 1, underLock: true });
      } else {
        ctx.emit({ ev: 'txn-abort', pid: ctx.pid, opId: op.id, reason: 'insufficient' });
        yield { t: 'ROLLBACK', reason: 'insufficient', opId: op.id, opEnd: true };
      }

      if (second !== first) yield { t: 'UNLOCK', acc: second, opId: op.id };
      yield { t: 'UNLOCK', acc: first, opId: op.id };
      yield { t: 'SLEEP', us: state.gapUs };
    }
  }

  /** Фабрика: выбираем генератор по демо и технике синхронизации. */
  function createAlgorithm(demo, technique) {
    if (demo === 1) {
      if (technique === TECHNIQUE.CAS) return depositViaCas;
      if (technique === TECHNIQUE.LOCK) return depositViaLock;
      return depositUnsafe;
    }
    if (technique === TECHNIQUE.STM) return transferViaStm;
    if (technique === TECHNIQUE.LOCK) return transferViaLock;
    if (technique === TECHNIQUE.CAS) return transferViaStm;   // CAS через STM-журнал
    return transferUnsafe;
  }

  /**
   * «Живое» состояние параметров: значения читаются прямо из общей памяти,
   * поэтому ползунки в интерфейсе действуют на ходу, не перезапуская потоки.
   */
  function makeState(mem, cfg) {
    cfg = cfg || {};
    return {
      get workUs() {
        var u = mem.get(H.WORK_US);
        if (mem.get(H.CONFLICT_BOOST)) u = Math.round(u * (1 + Math.random() * 4));
        return u;
      },
      get accounts() { return mem.get(H.ACCOUNTS); },
      get gapUs() { return cfg.gapUs || 0; },
      get depositAccount() { return 0; },
      get depositAmount() { return cfg.depositAmount || 10; },
      get transferMax() { return cfg.transferMax || 50; }
    };
  }

  // ---------------------------------------------------------------------------
  // 7. Драйвер шагов
  // ---------------------------------------------------------------------------
  /**
   * Драйвер исполняет ровно один шаг генератора за вызов stepOnce().
   * Именно он превращает «описание алгоритма» в реальные действия с памятью.
   *
   * @param {boolean} interactiveSpin — true в реальном потоке: SPIN честно
   *        сжигает процессор (аналог Thread.SpinWait). false в симуляторе:
   *        SPIN — просто точка переключения планировщика.
   */
  function StepDriver(ctx, gen, mem, interactiveSpin) {
    this.ctx = ctx;
    this.gen = gen;
    this.mem = mem;
    this.interactiveSpin = !!interactiveSpin;
    this.done = false;
    this.opDone = false;      // операция доехала до конца (можно сделать паузу)
    this.idleUs = 0;
    this.send = undefined;
    this.step();
  }

  StepDriver.prototype.stepOnce = function () {
    if (this.done) return false;
    return this.step();
  };

  StepDriver.prototype.step = function () {
    var self = this;
    var res = this.gen.next(this.send);
    if (res.done) { this.done = true; return false; }
    var s = res.value;
    var em = this.ctx.emit;
    var out;

    switch (s.t) {
      case 'BEGIN':
        this.ctx.txn.reset();
        em({ ev: 'step', pid: this.ctx.pid, kind: 'begin', opId: s.opId, tryId: s.tryId });
        break;

      case 'READ':
        out = this.ctx.txn.read(this.mem, s.acc);
        em({ ev: 'step', pid: this.ctx.pid, kind: 'read', acc: s.acc, value: out, opId: s.opId, tryId: s.tryId });
        break;

      case 'WRITE':
        this.ctx.txn.write(s.acc, s.value);
        em({ ev: 'step', pid: this.ctx.pid, kind: 'write', acc: s.acc, value: s.value, opId: s.opId, tryId: s.tryId });
        break;

      case 'LOAD':
        out = this.mem.balance(s.acc);
        em({ ev: 'step', pid: this.ctx.pid, kind: 'load', acc: s.acc, value: out, opId: s.opId });
        break;

      case 'STORE':
        this.mem.storeBalance(s.acc, s.value, this.ctx.pid);
        // Несинхронизированная запись специально НЕ поднимает версию:
        // это честно показывает, что «оптимистичный» механизм ломается,
        // если писать в память в обход него.
        if (!s.unsynced) this.mem.bumpVersion(s.acc);
        em({
          ev: 'step', pid: this.ctx.pid, kind: 'store', acc: s.acc, value: s.value,
          opId: s.opId, unsynced: !!s.unsynced, underLock: !!s.underLock
        });
        // Счётчики операции меняются ЗДЕСЬ ЖЕ, в одном шаге с записью в память:
        // иначе интерфейс успевает увидеть «баланс изменился, а операция ещё
        // не посчитана» и инвариант на миг выглядит нарушенным.
        if (s.opEnd) this.finishOp(s, 'ok');
        break;

      case 'CAS':
        // CAS уважает блокировки: если счёт захвачен «пессимистичным» потоком,
        // сравнение проводить нельзя — иначе затрём его незавершённую работу.
        if (this.mem.isLocked(s.acc)) {
          out = false;
          em({ ev: 'step', pid: this.ctx.pid, kind: 'cas', acc: s.acc, ok: false, lockBlocked: true, opId: s.opId });
          break;
        }
        out = this.mem.casBalance(s.acc, s.expected, s.desired, this.ctx.pid);
        em({
          ev: 'step', pid: this.ctx.pid, kind: 'cas', acc: s.acc,
          expected: s.expected, desired: s.desired, ok: out, opId: s.opId
        });
        if (out && s.opEnd) this.finishOp(s, 'ok');
        break;

      case 'LOCK_UNDER_COMMIT':
        // Захват счёта, выполняемый под глобальной блокировкой фиксации.
        out = this.mem.acquireLock(s.acc);
        em({ ev: 'step', pid: this.ctx.pid, kind: 'lock', acc: s.acc, ok: out, underCommit: true, opId: s.opId });
        break;

      case 'LOCK':
        out = this.mem.acquireLock(s.acc);
        em({
          ev: 'step', pid: this.ctx.pid, kind: 'lock', acc: s.acc, ok: out,
          label: s.label, opId: s.opId, tryId: s.tryId
        });
        break;

      case 'UNLOCK':
        this.mem.releaseLock(s.acc);
        em({
          ev: 'step', pid: this.ctx.pid, kind: 'unlock', acc: s.acc,
          label: s.label, opId: s.opId, tryId: s.tryId
        });
        break;

      case 'VALIDATE':
        out = this.ctx.txn.validate(this.mem);
        em({ ev: 'step', pid: this.ctx.pid, kind: 'validate', ok: out, opId: s.opId, tryId: s.tryId });
        break;

      case 'COMMIT':
        this.ctx.txn.commit(this.mem, this.ctx.pid);
        em({
          ev: 'step', pid: this.ctx.pid, kind: 'commit', opId: s.opId, tryId: s.tryId,
          accounts: Object.keys(this.ctx.txn.writeSet).map(Number)
        });
        if (s.opEnd) this.finishOp(s, 'ok');
        break;

      case 'ROLLBACK':
        em({ ev: 'step', pid: this.ctx.pid, kind: 'rollback', reason: s.reason, opId: s.opId, tryId: s.tryId });
        this.ctx.txn.reset();
        if (s.opEnd) this.finishOp(s, 'abort');
        break;

      case 'SPIN':
        this.ctx.stats.spins++;
        this.mem.workerStatAdd(this.ctx.pid, 3, 1);
        em({ ev: 'spin', pid: this.ctx.pid, us: s.us, label: s.label, opId: s.opId, tryId: s.tryId });
        if (this.interactiveSpin) busySpin(s.us);
        break;

      case 'SLEEP':
        // Пауза между операциями. В реальном потоке она выполняется через await
        // (см. worker.js), поэтому здесь только помечаем, что операция закончена.
        this.opDone = true;
        this.idleUs = s.us;
        em({ ev: 'idle', pid: this.ctx.pid, us: s.us });
        break;

      default:
        throw new Error('Неизвестный шаг: ' + s.t);
    }

    this.send = out;
    return true;
  };

  /** Завершение операции: статистика + счётчики памяти + событие для интерфейса. */
  StepDriver.prototype.finishOp = function (s, result) {
    var ctx = this.ctx;
    ctx.stats.ops++;
    this.mem.bump(H.OPS);
    if (result === 'abort') {
      ctx.stats.aborts++;
      this.mem.bump(H.ABORTS);
    } else {
      ctx.stats.commits++;
      this.mem.bump(H.COMMITS);
      this.mem.workerStatAdd(ctx.pid, 0, 1);
    }
    this.ctx.emit({ ev: 'op-done', pid: ctx.pid, opId: s.opId, result: result });
  };

  /** Аналог Thread.SpinWait(n): короткое реальное «сжигание» процессора. */
  function busySpin(us) {
    if (!us || us <= 0) return;
    if (us > 5000) us = 5000;
    var end = now() + us / 1000;
    var x = 0;
    while (now() < end) { x += Math.sqrt(x + 1); }   // держим CPU занятым
    return x;
  }

  if (typeof performance !== 'undefined' && performance.now) {
    var now = function () { return performance.now(); };
  } else {
    var now = function () { return Date.now(); };
  }

  // ---------------------------------------------------------------------------
  // 8. Инициализация памяти
  // ---------------------------------------------------------------------------
  function initMemory(mem, cfg) {
    for (var i = 0; i < TOTAL_INTS; i++) mem.i32[i] = 0;
    mem.set(H.DEMO, cfg.demo);
    mem.set(H.ACCOUNTS, cfg.accounts);
    mem.set(H.WORK_US, cfg.workUs);
    mem.set(H.CONFLICT_BOOST, cfg.conflictBoost ? 1 : 0);
    mem.set(H.ALIVE, cfg.workers);
    mem.set(H.STOP, 0);
    var perAccount = Math.floor(cfg.total / cfg.accounts);
    for (var a = 0; a < cfg.accounts; a++) {
      mem.i32[BALANCE_OFFSET + a] = perAccount;
      mem.i32[VERSION_OFFSET + a] = 1;      // версии начинаются с 1
    }
  }

  /** Сумма, которая обязана сохраняться при переводах (инвариант). */
  function invariantSum(mem, accounts) {
    var s = 0;
    for (var i = 0; i < accounts; i++) s += mem.balance(i);
    return s;
  }

  return {
    MAX_WORKERS: MAX_WORKERS,
    MAX_ACCOUNTS: MAX_ACCOUNTS,
    H: H,
    STATS_OFFSET: STATS_OFFSET,
    STATS_STRIDE: STATS_STRIDE,
    BALANCE_OFFSET: BALANCE_OFFSET,
    VERSION_OFFSET: VERSION_OFFSET,
    LOCK_OFFSET: LOCK_OFFSET,
    WRITER_OFFSET: WRITER_OFFSET,
    TOTAL_INTS: TOTAL_INTS,
    COMMIT_LOCK_SLOT: COMMIT_LOCK_SLOT,
    TECHNIQUE: TECHNIQUE,
    TECHNIQUE_NAME: TECHNIQUE_NAME,
    Mem: Mem,
    TxnLog: TxnLog,
    WorkerContext: WorkerContext,
    StepDriver: StepDriver,
    createAlgorithm: createAlgorithm,
    makeState: makeState,
    initMemory: initMemory,
    invariantSum: invariantSum,
    busySpin: busySpin,
    depositViaCas: depositViaCas,
    depositUnsafe: depositUnsafe,
    depositViaLock: depositViaLock,
    transferViaStm: transferViaStm,
    transferUnsafe: transferUnsafe,
    transferViaLock: transferViaLock,
    lockAccount: lockAccount
  };
});
