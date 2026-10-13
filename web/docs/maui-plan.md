# Экран мобильного приложения (MAUI): раскладка

Документ отвечает на вопрос «не будет ли на телефоне каши из панелей».
Ответ: будет ровно то, что уже сейчас видно в веб-версии, если сузить окно
до ширины телефона (меньше 900 px) — раскладка специально сделана телефонной.

```
┌──────────────────────────────────────────┐
│ Транзакционная память            ● потоки│   шапка: заголовок + режим исполнения
├──────────────────────────────────────────┤
│  Пример 1 · зачисление │ Пример 2 · пере-│   сегментированный переключатель примера
│  на счёт               │ воды           │
├──────────────────────────────────────────┤
│ ▸ Параметры запуска                      │   свёрнуто! открывается по тапу
├──────────────────────────────────────────┤
│                                          │
│        СХЕМА (графика, ~40% высоты)      │   ГЛАВНОЕ: линии и монетки
│        потоки → счёт / переводы          │   GraphicsView
│                                          │
├──────────────────────────────────────────┤
│ Операций  │ Коммитов │ Откатов │ эфф.    │   компактная полоса показателей
│  1 234    │  1 180   │   54    │ 96%     │
├──────────────────────────────────────────┤
│ Инвариант: сумма 10 000 ₽ не изменилась ✔│   крупная строка состояния
├──────────────────────────────────────────┤
│ [ Потоки ] [ Таймлайн ] [ Журнал ]       │   три панели по одной, а не все сразу
├──────────────────────────────────────────┤
│  #0  читает B      #1  коммит            │   содержимое выбранной панели
│  #2  ожидает       #3  вычисления        │
├──────────────────────────────────────────┤
│   ▶ Запустить      ⏸ Пауза      ⟲ Сброс  │   управление всегда под рукой
└──────────────────────────────────────────┘
```

Принцип: **сверху вниз по важности**. Сначала то, что показывает суть
(схема), затем сводка (показатели и инвариант), затем подробности
(потоки / таймлайн / журнал), и только потом настройки.

## Что где будет в MAUI

| Блок | Контрол MAUI | Примечание |
|---|---|---|
| Переключатель примера | `SegmentedControl` (или 2 `Button` в `Grid`) | одна страница, два режима расчёта |
| Параметры запуска | `Expander`, свёрнут по умолчанию | внутри: сценарий, темп, число потоков |
| Схема переводов | `GraphicsView` + ваш `IDrawable` | занимает `*` в `Grid` — растягивается по высоте |
| Показатели | `HorizontalStackLayout` из 4 карточек | числа моноширинным шрифтом |
| Инвариант | `Label` + смена цвета (`Green`/`Red`) | самая говорящая строка на защите |
| Потоки / Таймлайн / Журнал | переключатель + `ContentView` | показываем одну панель из трёх |
| Потоки | `CollectionView` (2 колонки) | состояние, операции, retry |
| Таймлайн | `GraphicsView` + второй `IDrawable` | дорожки потоков |
| Журнал | `CollectionView` со строками событий | первые ~20 строк — самые свежие |
| Кнопки | `Grid` из 3 `Button` | запуск / пауза / сброс |

## Разметка страницы (XAML, эскиз)

```xml
<ContentPage Title="Транзакционная память">
  <Grid RowDefinitions="Auto,Auto,Auto,*,Auto,Auto,Auto"
        Padding="12" RowSpacing="10">

    <!-- 1. Пример: 1 = зачисление, 2 = переводы -->
    <Grid Grid.Row="0" ColumnDefinitions="*,*" ColumnSpacing="8">
      <Button Text="Пример 1" Clicked="OnDemo1" />
      <Button Grid.Column="1" Text="Пример 2" Clicked="OnDemo2" />
    </Grid>

    <!-- 2. Параметры: свёрнуты, чтобы не мешать -->
    <Expander Grid.Row="1" Header="Параметры запуска" IsExpanded="False">
      <VerticalStackLayout Spacing="8">
        <Label Text="Сценарий синхронизации" />
        <HorizontalStackLayout Spacing="6">
          <Button Text="STM" Clicked="OnTechStm" />
          <Button Text="Блокировки" Clicked="OnTechLock" />
          <Button Text="Без синхронизации" Clicked="OnTechUnsafe" />
        </HorizontalStackLayout>
        <Label Text="Темп показа" />
        <HorizontalStackLayout Spacing="6">
          <Button Text="🐢 показ" Clicked="OnTempoShow" />
          <Button Text="▶ обычный" Clicked="OnTempoNormal" />
          <Button Text="⚡ нагрузка" Clicked="OnTempoLoad" />
        </HorizontalStackLayout>
        <Label x:Name="WorkersLabel" Text="Потоков: 8" />
        <Slider x:Name="WorkersSlider" Minimum="2" Maximum="16" Value="8"
                ValueChanged="OnWorkersChanged" />
      </VerticalStackLayout>
    </Expander>

    <!-- 3. СХЕМА: главный элемент, тянется по высоте -->
    <Border Grid.Row="2" StrokeThickness="1" Padding="8">
      <GraphicsView x:Name="NetworkView" Drawable="{StaticResource NetworkDrawable}" />
    </Border>

    <!-- 4. Показатели -->
    <Grid Grid.Row="3" ColumnDefinitions="*,*,*,*" ColumnSpacing="8">
      <VerticalStackLayout><Label Text="Операций" /><Label x:Name="OpsLabel" Text="0" /></VerticalStackLayout>
      <VerticalStackLayout Grid.Column="1"><Label Text="Коммитов" /><Label x:Name="CommitsLabel" Text="0" /></VerticalStackLayout>
      <VerticalStackLayout Grid.Column="2"><Label Text="Откатов" /><Label x:Name="RetriesLabel" Text="0" /></VerticalStackLayout>
      <VerticalStackLayout Grid.Column="3"><Label Text="Эффективность" /><Label x:Name="EffLabel" Text="—" /></VerticalStackLayout>
    </Grid>

    <!-- 5. Инвариант -->
    <Label Grid.Row="4" x:Name="InvariantLabel" Text="ожидание запуска" FontSize="16" />

    <!-- 6. Три панели по одной -->
    <Grid Grid.Row="5" ColumnDefinitions="*,*,*" ColumnSpacing="6">
      <Button Text="Потоки"   Clicked="OnPanelWorkers" />
      <Button Grid.Column="1" Text="Таймлайн" Clicked="OnPanelTimeline" />
      <Button Grid.Column="2" Text="Журнал"   Clicked="OnPanelJournal" />
    </Grid>

    <Grid Grid.Row="6">
      <CollectionView x:Name="WorkersList" ItemsSource="{Binding Workers}" />
      <GraphicsView x:Name="TimelineView" IsVisible="False" />
      <CollectionView x:Name="JournalList" ItemsSource="{Binding Journal}" IsVisible="False" />
    </Grid>

    <!-- 7. Управление -->
    <Grid Grid.Row="7" ColumnDefinitions="*,*,*" ColumnSpacing="8">
      <Button Text="▶ Запустить" Clicked="OnStart" />
      <Button Grid.Column="1" Text="⏸ Пауза" Clicked="OnPause" />
      <Button Grid.Column="2" Text="⟲ Сброс" Clicked="OnReset" />
    </Grid>
  </Grid>
</ContentPage>
```

## Как это работает без нагрузки на интерфейс

1. **Потоки пишут в очередь, а не в UI.** Рабочие потоки (`Task.Run`) кладут
   события в `ConcurrentQueue<WorkerEvent>` — рисование забирает их в `Draw`
   или в таймере. Так интерфейс не блокируется и не «дёргается».
2. **Обновление ~25 раз в секунду**, а не на каждое событие: `IDispatcherTimer`
   с интервалом 40 мс. На телефоне этого достаточно, батарея не съедается.
3. **Числа читаются из памяти одним снимком** (обычные `int` под `Interlocked`),
   поэтому карточки показателей не требуют блокировок.
4. **Схема — единственный «дорогой» элемент**, и она рисуется на GPU-ускоренном
   `GraphicsView`. Всё остальное — лёгкие `Label`/`CollectionView`.

## Что можно убрать, если экран всё ещё тесный

Порядок отказа (от менее важного к более важному):

1. **Журнал** — на защите его можно показать один раз, а не держать постоянно;
2. **Таймлайн** — заменить его «полосками» прямо в карточках потоков;
3. **Тонкая настройка** — оставить только темп (три кнопки) и число потоков;
4. **Схема и инвариант остаются всегда** — без них работа теряет смысл.

Такой же набор отключаемых блоков уже есть в веб-версии
(переключатель «Потоки / Таймлайн / Журнал» и свёрнутые параметры) — то есть
раскладку можно «пощупать» до того, как начнётся перенос в MAUI.
