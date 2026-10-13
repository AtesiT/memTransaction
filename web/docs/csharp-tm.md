# Транзакционная память на C# — код для лабораторной работы

Здесь лежат программы на C#, которые повторяют то, что показывает веб-стенд, и
заготовка для мобильного приложения на **.NET MAUI** (следующий этап работы).

---

## Пример 1. Оптимистичная блокировка через CAS (как в задании)

Тот же код, что и в задании: безопасное изменение баланса без `lock`.
Аналог в веб-версии — `depositViaCas` в `web/js/tm-core.js`.

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;

class Account
{
    private int _balance;                      // общая память потоков
    public int Balance => Volatile.Read(ref _balance);

    public void DepositTransactional(int amount)
    {
        int currentBalance, newBalance;
        do
        {
            currentBalance = Volatile.Read(ref _balance);   // 1. начало транзакции
            newBalance = currentBalance + amount;           // 2. локальное вычисление

            Thread.SpinWait(10);                            // имитация тяжёлой работы

            // 3. фиксация: записываем, только если никто не успел изменить баланс
        }
        while (Interlocked.CompareExchange(ref _balance, newBalance, currentBalance) != currentBalance);
    }
}

class Program
{
    static async Task Main()
    {
        var account = new Account();
        var tasks = new Task[100];
        for (int i = 0; i < tasks.Length; i++)
            tasks[i] = Task.Run(() => account.DepositTransactional(10));

        await Task.WhenAll(tasks);
        Console.WriteLine($"Итоговый баланс: {account.Balance}");   // всегда 1000
    }
}
```

**Что важно понять:** CAS — оптимистичная операция. Поток не блокирует никого,
но обязан повторить всю работу, если за время вычислений данные изменились.
Именно это и есть «откат + retry» в простейшем виде.

---

## Пример 2. Своя транзакционная память для связанных объектов

Когда в одной транзакции нужно изменить два объекта (перевод со счёта на счёт),
одной CAS-операции недостаточно: нужен журнал чтения/записи, версии данных,
валидация и повтор. Ниже — минимальная рабочая реализация.

```csharp
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace TransactionalMemory
{
    /// <summary>Версионируемое значение: версия нужна для проверки конфликтов.</summary>
    internal interface IVersioned
    {
        long Version { get; }
        void SetValue(object value);
    }

    /// <summary>Транзакционная переменная (аналог Ref в ScalaSTM, TVar в Haskell).</summary>
    public sealed class Transactional<T> : IVersioned
    {
        private T _value;
        private long _version = 1;

        public Transactional(T value) => _value = value;

        public T Read()
        {
            TxContext.Current?.LogRead(this, _version);
            return _value;
        }

        /// <summary>Запись идёт только в локальный журнал транзакции.</summary>
        public void Write(T value) => TxContext.Current?.LogWrite(this, value);

        long IVersioned.Version => Interlocked.Read(ref _version);
        void IVersioned.SetValue(object value)
        {
            _value = (T)value;
            Interlocked.Increment(ref _version);      // публикуем новую версию
        }
    }

    /// <summary>Контекст транзакции: журнал потока, валидация, фиксация, повтор.</summary>
    public sealed class TxContext
    {
        [ThreadStatic] private static TxContext _current;
        public static TxContext Current => _current;

        private readonly Dictionary<object, long> _readSet = new();
        private readonly Dictionary<object, object> _writeSet = new();

        // Фиксация должна быть неделимой: иначе несколько потоков успеют
        // провалидироваться на одной версии данных и оба запишут устаревшие
        // значения. В веб-стенде эту роль играет commit-lock.
        private static readonly object CommitGate = new();

        public static void ExecuteInTransaction(Action body, int maxAttempts = 1000)
        {
            for (int attempt = 1; ; attempt++)
            {
                var ctx = new TxContext();
                _current = ctx;
                try
                {
                    body();                    // все операции уходят в журнал
                }
                finally
                {
                    _current = null;           // журнал не «протекает» наружу
                }

                lock (CommitGate)              // короткий критический участок
                {
                    if (ctx.Validate())        // никто не изменил прочитанное?
                    {
                        ctx.Apply();           // применение write-set
                        return;                // успешная фиксация
                    }
                }

                if (attempt >= maxAttempts)
                    throw new InvalidOperationException("Слишком много конфликтов транзакции");
                // иначе — откат (журнал просто выбрасывается) и повтор
            }
        }

        internal void LogRead(object cell, long version) => _readSet[cell] = version;
        internal void LogWrite(object cell, object value) => _writeSet[cell] = value;

        private bool Validate()
        {
            foreach (var kv in _readSet)
                if (((IVersioned)kv.Key).Version != kv.Value) return false;
            return true;
        }

        private void Apply()
        {
            foreach (var kv in _writeSet)
                ((IVersioned)kv.Key).SetValue(kv.Value);
            _writeSet.Clear();
            _readSet.Clear();
        }
    }

    public class BankAccount
    {
        public readonly Transactional<int> Balance;
        public string Name { get; }
        public BankAccount(string name, int balance) { Name = name; Balance = new Transactional<int>(balance); }
    }

    public class Bank
    {
        public BankAccount[] Accounts { get; }

        public Bank(int count, int total)
        {
            Accounts = new BankAccount[count];
            int each = total / count;
            for (int i = 0; i < count; i++)
                Accounts[i] = new BankAccount(((char)('A' + i)).ToString(), each);
        }

        public void Transfer(int from, int to, int amount) =>
            TxContext.ExecuteInTransaction(() =>
            {
                if (Accounts[from].Balance.Read() < amount)
                    throw new InvalidOperationException("Недостаточно средств");

                Accounts[from].Balance.Write(Accounts[from].Balance.Read() - amount);
                Accounts[to].Balance.Write(Accounts[to].Balance.Read() + amount);
            });

        public int Total()
        {
            int sum = 0;
            foreach (var a in Accounts) sum += a.Balance.Read();
            return sum;
        }
    }

    class Program
    {
        static void Main()
        {
            var bank = new Bank(4, 10000);
            var rnd = new Random();
            var tasks = new Task[8];

            for (int i = 0; i < tasks.Length; i++)
                tasks[i] = Task.Run(() =>
                {
                    for (int k = 0; k < 2000; k++)
                    {
                        int a = rnd.Next(4), b = rnd.Next(4);
                        if (a == b) continue;
                        try { bank.Transfer(a, b, rnd.Next(1, 50)); }
                        catch (InvalidOperationException) { /* недостаточно средств */ }
                    }
                });

            Task.WaitAll(tasks);
            Console.WriteLine($"Сумма на счетах: {bank.Total()}");   // всегда 10000
        }
    }
}
```

> Проверка на живом примере: в веб-стенде этот алгоритм гоняется в 8–16 потоках,
> и сумма на счетах остаётся ровно 10 000 ₽, а счётчик откатов-конфликтов
> показывает, сколько раз транзакции пришлось переигрывать.

---

## Следующий этап: .NET MAUI

Мобильное приложение повторяет стенд, но вместо менеджера планировщика здесь
можно использовать **настоящие потоки** — .NET их поддерживает, поэтому
симулятор не нужен.

### Структура проекта

```
TmLab/
├── TmLab.csproj                 (net9.0-android;net9.0-ios;net9.0-maccatalyst;net9.0-windows…)
├── MauiProgram.cs
├── App.xaml(.cs)
├── AppShell.xaml(.cs)
├── Models/
│   ├── Transactional.cs         (Transactional<T>, IVersioned, TxContext)
│   └── Bank.cs                  (счета, перевод, инвариант)
├── Simulation/
│   ├── SimulationOptions.cs     (число потоков, число операций, пауза, работа в транзакции)
│   ├── WorkerTechnique.cs       (Stm / Lock / Cas / Unsafe)
│   └── SimulationRunner.cs      (запуск Task.Run, события о состоянии потоков)
├── Drawing/
│   └── TimelineDrawable.cs      (IDrawable: дорожки потоков, фазы транзакций)
└── Views/
    ├── MainPage.xaml(.cs)       (панель управления + графика)
    └── Controls/AccountCard.xaml
```

### Ключевые фрагменты

Запуск потоков и публикация событий в интерфейс:

```csharp
public sealed class SimulationRunner
{
    public event Action<WorkerEvent>? EventPublished;   // подписывается страница
    private readonly Bank _bank;
    private CancellationTokenSource? _cts;

    public void Start(SimulationOptions o)
    {
        _cts = new CancellationTokenSource();
        for (int i = 0; i < o.Workers; i++)
        {
            int pid = i;
            _ = Task.Run(() => RunWorker(pid, o, _cts.Token));   // настоящая параллельность
        }
    }

    private void RunWorker(int pid, SimulationOptions o, CancellationToken token)
    {
        var rnd = new Random(pid * 7919 + 13);
        while (!token.IsCancellationRequested)
        {
            int from = rnd.Next(o.Accounts), to = rnd.Next(o.Accounts);
            if (from == to) continue;

            EventPublished?.Invoke(WorkerEvent.OpBegin(pid, from, to));
            if (o.Technique == WorkerTechnique.Stm)
            {
                TxContext.ExecuteInTransaction(() =>
                {
                    EventPublished?.Invoke(WorkerEvent.Read(pid, from));
                    int a = _bank.Accounts[from].Balance.Read();
                    int b = _bank.Accounts[to].Balance.Read();
                    Thread.SpinWait(o.WorkSpin);                  // «тяжёлая работа»
                    _bank.Accounts[from].Balance.Write(a - o.Amount);
                    _bank.Accounts[to].Balance.Write(b + o.Amount);
                });
            }
            EventPublished?.Invoke(WorkerEvent.Commit(pid, from, to));
            Thread.Sleep(o.GapMs);                                // пауза между операциями
        }
    }
}
```

Отрисовка таймлайна (аналог `web/js/timeline.js`):

```csharp
public sealed class TimelineDrawable : IDrawable
{
    // События складываем в очередь, а разбираем и рисуем в Draw —
    // так интерфейс не блокируется потоками симуляции.
    private readonly ConcurrentQueue<WorkerEvent> _queue = new();
    private readonly Dictionary<int, List<Phase>> _lanes = new();

    public void Enqueue(WorkerEvent e) => _queue.Enqueue(e);

    public void Draw(ICanvas canvas, RectF dirtyRect)
    {
        while (_queue.TryDequeue(out var e)) Apply(e);

        float laneH = dirtyRect.Height / Math.Max(1, _lanes.Count);
        foreach (var (pid, phases) in _lanes)
        {
            float y = dirtyRect.Top + pid * laneH;
            foreach (var p in phases)
            {
                canvas.FillColor = p.Color;
                canvas.FillRectangle(p.X(dirtyRect, _windowMs), y + 3, p.Width(dirtyRect, _windowMs), laneH - 6);
            }
        }
    }
}
```

Периодический вызов перерисовки со страницы:

```csharp
// MainPage.xaml.cs
private IDispatcherTimer? _timer;

protected override void OnAppearing()
{
    base.OnAppearing();
    _timer = Dispatcher.CreateTimer();
    _timer.Interval = TimeSpan.FromMilliseconds(40);   // ~25 кадров в секунду
    _timer.Tick += (_, __) => TimelineView.Invalidate();
    _timer.Start();
}
```

### Соответствие веб-версии и C#

| Веб-версия | C# / MAUI | Комментарий |
|---|---|---|
| `Atomics.compareExchange` | `Interlocked.CompareExchange` | то же CAS, но в .NET доступен напрямую |
| busy-spin по `performance.now()` | `Thread.SpinWait(n)` | имитация тяжёлых вычислений |
| спин-блокировка на CAS | `lock (obj)` | в MAUI можно и честный `Monitor` |
| `Web Worker` + `SharedArrayBuffer` | `Task.Run` + общая память процесса | потоки видят общие объекты напрямую |
| `TxnLog` (read-set / write-set) | `TxContext._readSet` / `_writeSet` | журнал транзакции |
| `commit-lock` (глобальная блокировка фиксации) | `lock (CommitGate)` | неделимость валидации и коммита |
| `Timeline` на canvas | `IDrawable` + `GraphicsView` | графика параллелизма в MAUI |
| события воркеров через `postMessage` | `event Action<WorkerEvent>` + `MainThread.BeginInvokeOnMainThread` | обновление UI из потоков |

### Что стоит передать в мобильную версию

* переключение сценария: **STM / блокировки / CAS / без синхронизации**;
* счётчики: операции, коммиты, откаты-конфликты, эффективность;
* индикатор инварианта: сумма на счетах не должна меняться;
* таймлайн: дорожки потоков с фазами «чтение → вычисления → валидация → коммит»
  и красными блоками конфликтов;
* журнал выбранного потока (read-set / write-set);
* аккуратность при остановке: `CancellationTokenSource` + проверка токена
  между операциями (в веб-версии это флаг `STOP` в общей памяти).
