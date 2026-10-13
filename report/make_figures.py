"""Рисунки для отчёта: схемы алгоритмов, схема переводов, экран, таймлайн."""
from PIL import Image, ImageDraw, ImageFont

F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FM = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

BG, PANEL, CARD, BORDER = "#0b1220", "#111a30", "#0c1224", "#22304f"
ACCENT, GREEN, AMBER, RED, PURPLE, CYAN = "#2b6cff", "#35d07f", "#ffb020", "#ff5d6c", "#a78bfa", "#4ea1ff"
TEXT, MUTED = "#e6ecf7", "#8fa3c4"

def font(size, bold=False, mono=False):
    path = FM if mono else (FB if bold else F)
    return ImageFont.truetype(path, size)

def rr(d, box, r, fill=None, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def ctext(d, cx, cy, s, f, fill=TEXT, anchor="mm"):
    d.text((cx, cy), s, font=f, fill=fill, anchor=anchor)

def arrow(d, x1, y1, x2, y2, color=BORDER, width=3, head=10):
    d.line((x1, y1, x2, y2), fill=color, width=width)
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    for s in (-1, 1):
        d.line((x2, y2, x2 - head * math.cos(ang - s * 0.42), y2 - head * math.sin(ang - s * 0.42)),
               fill=color, width=width)

# ---------------------------------------------------------------- рисунок 1
def figure_algorithms(path="img/fig1-algorithms.png"):
    W, H = 1440, 780
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    f14, f13, f12 = font(21), font(19), font(18)

    # ---------------- левая половина — Пример 1 (CAS)
    d.text((50, 34), "Пример 1. Цикл CAS: зачисление на счёт", font=font(27, True), fill=CYAN)
    x, y, w, h = 50, 96, 610, 92
    steps1 = [
        ("current = balance", "читаем текущее значение счёта"),
        ("next = current + amount", "считаем новое значение локально"),
        ("Thread.SpinWait(...)", "имитация тяжёлой работы"),
    ]
    for title, sub in steps1:
        rr(d, (x, y, x + w, y + h), 12, fill=CARD, outline=BORDER, width=2)
        d.text((x + 22, y + 18), title, font=f14, fill=TEXT)
        d.text((x + 22, y + 50), sub, font=f12, fill=MUTED)
        arrow(d, x + w / 2, y + h, x + w / 2, y + h + 24)
        y += h + 24

    rr(d, (x, y, x + w, y + 124), 12, fill="#0f2a22", outline=GREEN, width=3)
    d.text((x + 22, y + 16), "CompareExchange(balance, next, current)", font=font(20, True), fill=GREEN)
    d.text((x + 22, y + 50), "вернулось current  →  попытка принята", font=f13, fill=TEXT)
    d.text((x + 22, y + 76), "вернулось другое  →  данные устарели, повтор", font=f13, fill=RED)
    d.text((x + 22, y + 100), "цикл повторяется, пока CAS не пройдёт", font=f12, fill=MUTED)

    # ---------------- правая половина — Пример 2 (STM)
    x2 = 780
    d.text((x2, 34), "Пример 2. Транзакция над счетами", font=font(27, True), fill=PURPLE)
    x, y = x2, 96
    steps2 = [
        ("Чтение счетов A и B", "значения и версии попадают в журнал", CYAN),
        ("Изменения — только в журнале", "общая память пока не тронута", ACCENT),
        ("Валидация версий", "изменил ли кто-то прочитанные данные?", PURPLE),
    ]
    for title, sub, col in steps2:
        rr(d, (x, y, x + w, y + h), 12, fill=CARD, outline=BORDER, width=2)
        d.rectangle((x, y + 10, x + 6, y + h - 10), fill=col)
        d.text((x + 22, y + 18), title, font=f14, fill=TEXT)
        d.text((x + 22, y + 50), sub, font=f12, fill=MUTED)
        arrow(d, x + w / 2, y + h, x + w / 2, y + h + 24)
        y += h + 24

    rr(d, (x, y, x + w, y + 118), 12, fill="#0f2a22", outline=GREEN, width=3)
    d.text((x + 22, y + 14), "Версии совпали → фиксация", font=font(20, True), fill=GREEN)
    d.text((x + 22, y + 48), "журнал применяется к общей памяти,", font=f13, fill=TEXT)
    d.text((x + 22, y + 74), "другие потоки увидят изменение целиком", font=f13, fill=TEXT)

    y += 140
    rr(d, (x + 40, y, x + w - 40, y + 108), 12, fill="#2a1218", outline=RED, width=3)
    d.text((x + 62, y + 14), "Версии изменились → откат", font=font(20, True), fill=RED)
    d.text((x + 62, y + 48), "журнал выбрасывается, транзакция", font=f13, fill=TEXT)
    d.text((x + 62, y + 74), "выполняется заново целиком", font=f13, fill=TEXT)

    im.save(path)
    print("готово:", path, im.size)

# ---------------------------------------------------------------- рисунок 2
def figure_transfer(path="img/fig2-transfer.png"):
    import math
    W, H = 1440, 820
    im = Image.new("RGB", (W, H), PANEL)
    d = ImageDraw.Draw(im)
    d.rectangle((12, 12, W - 12, H - 12), outline=BORDER, width=3)
    d.text((44, 30), "Переводы между счетами: линия — попытка транзакции", font=font(27, True), fill=TEXT)
    d.text((44, 72), "зелёная монетка долетела — транзакция зафиксирована;   "
                     "красная погасла на полпути — конфликт версий и откат", font=font(18), fill=MUTED)

    R = 84
    pts = {
        "Аня":   (300, 300, 3100, 4, False),
        "Борис": (900, 300, 2400, 7, False),
        "Вика":  (300, 600, 2900, 3, False),
        "Гриша": (900, 600, 1600, 5, True),
    }

    def edge(p1, p2):
        """точка на границе кружка со стороны соседа"""
        x, y = p1[0], p1[1]
        dx, dy = p2[0] - x, p2[1] - y
        ln = math.hypot(dx, dy)
        return (x + dx / ln * (R + 8), y + dy / ln * (R + 8))

    def quad(p1, p2, t, bend=60):
        a, b = edge(p1, p2), edge(p2, p1)
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = max(1.0, math.hypot(dx, dy))
        cx, cy = mx - dy / ln * bend, my + dx / ln * bend      # контрольная точка

        def q(u):
            return ((1 - u) ** 2 * a[0] + 2 * (1 - u) * u * cx + u ** 2 * b[0],
                    (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * cy + u ** 2 * b[1])
        return q, (a, b)

    def flight(name1, name2, t, ok, amount, bend=60):
        p1, p2 = pts[name1], pts[name2]
        q, _ = quad(p1, p2, t, bend)
        col = GREEN if ok else RED

        # хвост полёта (у отката он короче)
        t_end = t if ok else min(t * 0.75, 0.62)
        pts_line = [q(i / 48) for i in range(0, int(48 * t_end) + 1)]
        if len(pts_line) > 1:
            d.line(pts_line, fill=col, width=4)

        px, py = q(t_end)
        r = 17 if ok else 13
        d.ellipse((px - r, py - r, px + r, py + r), fill=col, outline=BG, width=3)

        # плашка с суммой — рядом с монеткой, но не на линии
        txt = f"{amount} ₽"
        f = font(19, True)
        tw = d.textlength(txt, font=f)
        bx, by = px + 22, py - 46
        rr(d, (bx, by, bx + tw + 20, by + 32), 8, fill=CARD, outline=col, width=2)
        d.text((bx + 10, by + 16), txt, font=f, fill=col, anchor="lm")

    # кто кому переводит: две успешные и две откатившиеся попытки
    flight("Аня", "Борис", 1.0, True, 1200, bend=30)
    flight("Борис", "Гриша", 0.62, True, 300, bend=40)
    flight("Вика", "Аня", 0.5, False, 800, bend=-60)
    flight("Гриша", "Вика", 0.42, False, 1500, bend=-70)

    for name, (cx, cy, bal, ver, locked) in pts.items():
        d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=CARD, outline=ACCENT, width=5)
        if locked:
            d.ellipse((cx - R - 14, cy - R - 14, cx + R + 14, cy + R + 14), outline=AMBER, width=3)
            d.text((cx - R - 8, cy - R - 46), "ждёт", font=font(19, True), fill=AMBER)
        ctext(d, cx, cy - 14, name, font(25, True), TEXT)
        ctext(d, cx, cy + 24, f"{bal:,} ₽".replace(",", " "), font(20), MUTED)
        d.text((cx + R - 34, cy - R + 8), f"v{ver}", font=font(19, True), fill=CYAN)

    d.text((44, H - 74), "Сумма на счетах: 10 000 ₽ — не изменилась ✔", font=font(23, True), fill=GREEN)
    d.text((W - 470, H - 70), "откатов: 2   ·   операций/с: 20", font=font(20), fill=MUTED)
    im.save(path)
    print("готово:", path, im.size)

# ---------------------------------------------------------------- рисунок 3
def figure_screen(path="img/fig3-screen.png"):
    W, H = 1440, 930
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    rr(d, (18, 18, W - 18, H - 18), 16, fill="#070b16", outline=BORDER, width=3)
    d.rectangle((18, 18, W - 18, 62), fill=CARD)
    d.text((42, 28), "Транзакционная память", font=font(21, True), fill=TEXT)
    for i, s_ in enumerate(("—", "□", "✕")):
        d.text((W - 150 + i * 42, 28), s_, font=font(19), fill=MUTED)

    L = 48
    y = 88

    # 1. переключатель примера
    rr(d, (L, y, L + 380, y + 50), 10, fill="#16213c")
    ctext(d, L + 190, y + 25, "Пример 1 · зачисление", font(20), MUTED)
    rr(d, (L + 392, y, L + 756, y + 50), 10, fill=ACCENT)
    ctext(d, L + 574, y + 25, "Пример 2 · переводы", font(20, True), "#ffffff")
    y += 72

    # 2. параметры (свёрнуты)
    rr(d, (L, y, L + 756, y + 48), 10, fill="#16213c")
    d.text((L + 24, y + 13), "▾ Параметры запуска", font=font(20), fill=CYAN)
    y += 66
    d.text((L, y), "сценарий · темп показа · потоки · работа · пауза",
           font=font(17), fill=MUTED)
    y += 40

    # 4. показатели
    rr(d, (L, y, L + 756, y + 146), 12, fill=CARD, outline=BORDER, width=2)
    cells = [("Операций", "412", TEXT), ("Коммитов", "398", TEXT), ("Откатов", "61", AMBER),
             ("Отказов", "14", TEXT), ("Операций/сек", "20", TEXT), ("Эффективность", "86,7 %", TEXT)]
    for i, (cap, val, col) in enumerate(cells):
        cx = L + 26 + (i % 3) * 250
        cy = y + 22 + (i // 3) * 68
        d.text((cx, cy), cap, font=font(17), fill=MUTED)
        d.text((cx, cy + 24), val, font=font(23, True), fill=col)
    y += 168

    # 5. инвариант
    rr(d, (L, y, L + 756, y + 56), 10, fill="#0f2a22", outline=GREEN, width=3)
    d.text((L + 24, y + 15), "Сумма на счетах 10 000 ₽ — не изменилась ✔", font=font(21, True), fill=GREEN)
    y += 76

    # 8. управление (значки рисуем сами: в шрифте отчёта нет символа паузы)
    def button(x, w, label, fill, text_col, icon, bold=False):
        rr(d, (x, y, x + w, y + 54), 12, fill=fill)
        f = font(20, bold)
        tw = d.textlength(label, font=f)
        ix = x + (w - tw - 44) / 2
        iy = y + 27
        if icon == "play":
            d.polygon([(ix, iy - 11), (ix, iy + 11), (ix + 17, iy)], fill=text_col)
        elif icon == "pause":
            d.rectangle((ix, iy - 11, ix + 7, iy + 11), fill=text_col)
            d.rectangle((ix + 12, iy - 11, ix + 19, iy + 11), fill=text_col)
        elif icon == "reset":
            d.arc((ix, iy - 11, ix + 22, iy + 11), start=40, end=320, fill=text_col, width=3)
            d.polygon([(ix + 18, iy - 12), (ix + 26, iy - 4), (ix + 15, iy + 1)], fill=text_col)
        d.text((ix + 36, iy), label, font=f, fill=text_col, anchor="lm")

    button(L, 240, "Запустить", ACCENT, "#ffffff", "play", bold=True)
    button(L + 258, 240, "Пауза", "#16213c", MUTED, "pause")
    button(L + 516, 240, "Сброс", "#16213c", MUTED, "reset")

    # ---- правая колонка
    rx = 838
    ry = 88
    sch_h = 470
    rr(d, (rx, ry, W - 48, ry + sch_h), 14, fill=PANEL, outline=BORDER, width=3)
    d.text((rx + 26, ry + 16), "Переводы между счетами", font=font(20), fill=MUTED)

    nodes = {"Аня": (rx + 175, ry + 205, "2 860 ₽", 4, False),
             "Борис": (rx + 440, ry + 205, "2 400 ₽", 7, False),
             "Вика": (rx + 175, ry + 355, "2 640 ₽", 3, False),
             "Гриша": (rx + 440, ry + 355, "2 100 ₽", 5, True)}
    R = 58
    for name, (cx, cy, bal, ver, locked) in nodes.items():
        d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=CARD, outline=ACCENT, width=4)
        if locked:
            d.ellipse((cx - R - 11, cy - R - 11, cx + R + 11, cy + R + 11), outline=AMBER, width=2)
            d.text((cx - R - 4, cy - R - 36), "ждёт", font=font(16, True), fill=AMBER)
        ctext(d, cx, cy - 10, name, font(19, True), TEXT)
        ctext(d, cx, cy + 16, bal, font(15), MUTED)
        d.text((cx + R - 26, cy - R + 4), f"v{ver}", font=font(15, True), fill=CYAN)

    # линии и монетки
    d.line([(nodes["Аня"][0] + R, nodes["Аня"][1]), (nodes["Борис"][0] - R, nodes["Борис"][1])],
           fill=GREEN, width=4)
    d.ellipse((nodes["Аня"][0] + 150, nodes["Аня"][1] - 11,
               nodes["Аня"][0] + 172, nodes["Аня"][1] + 11), fill=GREEN, outline=BG, width=2)
    d.line([(nodes["Вика"][0], nodes["Вика"][1] - R), (nodes["Аня"][0], nodes["Аня"][1] + R)],
           fill=RED, width=4)
    d.ellipse((nodes["Вика"][0] - 11, nodes["Вика"][1] - 130,
               nodes["Вика"][0] + 11, nodes["Вика"][1] - 108), fill=RED, outline=BG, width=2)
    d.text((rx + 26, ry + sch_h - 34), "зелёная монетка долетела — коммит;   красная погасла — откат",
           font=font(16), fill=MUTED)

    # 6. переключатель панелей
    ry += sch_h + 22
    for i, (label, active) in enumerate([("Потоки", True), ("Таймлайн", False), ("Журнал", False)]):
        x0 = rx + i * 186
        rr(d, (x0, ry, x0 + 172, ry + 42), 10, fill=ACCENT if active else "#16213c")
        ctext(d, x0 + 86, ry + 21, label, font(18, True if active else False),
              "#ffffff" if active else MUTED)

    # 7. панель «Потоки»
    ry += 60
    rr(d, (rx, ry, W - 48, H - 46), 12, fill=CARD, outline=BORDER, width=2)
    for i in range(3):
        for j in range(2):
            x0 = rx + 20 + j * 274
            y0 = ry + 18 + i * 74
            rr(d, (x0, y0, x0 + 254, y0 + 60), 8, fill="#16213c", outline=BORDER, width=1)
            d.text((x0 + 14, y0 + 8), f"поток #{i * 2 + j}", font=font(16), fill=MUTED)
            d.text((x0 + 14, y0 + 30), "оп 52 · retry 7 · ожид 0", font=font(14), fill="#6d80a3")

    im.save(path)
    print("готово:", path, im.size)

# ---------------------------------------------------------------- рисунок 4
def figure_timeline(path="img/fig4-timeline.png"):
    W, H = 1500, 720
    im = Image.new("RGB", (W, H), PANEL)
    d = ImageDraw.Draw(im)
    d.rectangle((12, 12, W - 12, H - 12), outline=BORDER, width=3)
    d.text((40, 30), "Таймлайн: дорожка на каждый поток", font=font(28, True), fill=TEXT)

    import random
    random.seed(7)
    x0, x1 = 110, W - 60
    lanes = 5
    top, lane_h = 100, 96
    colors = {"чтение": CYAN, "вычисление": "#63e6f0", "валидация": PURPLE,
              "коммит": GREEN, "конфликт": RED, "ожидание": AMBER}

    for i in range(lanes):
        y = top + i * lane_h
        d.text((40, y + 22), f"#{i}", font=font(20, True), fill=MUTED)
        rr(d, (x0, y + 8, x1, y + 56), 8, fill=CARD)
        x = x0 + 10
        while x < x1 - 10:
            name = random.choice(list(colors.keys()))
            if name == "ожидание" and i % 2 == 0:
                name = "чтение"
            w = random.randint(26, 70) if name != "конфликт" else random.randint(20, 40)
            if x + w > x1 - 10:
                w = x1 - 10 - x
            d.rounded_rectangle((x, y + 14, x + w, y + 50), radius=4, fill=colors[name])
            x += w + random.randint(4, 12)

    # легенда
    lx, ly = 40, H - 96
    for i, (name, col) in enumerate(colors.items()):
        bx = lx + i * 240
        d.rounded_rectangle((bx, ly, bx + 34, ly + 22), radius=5, fill=col)
        d.text((bx + 46, ly - 4), name, font=font(20), fill=TEXT)
    d.text((40, H - 52), "красные участки — попытки, которые откатились; жёлтые — поток ждал освобождения счёта (режим блокировок)",
           font=font(18), fill=MUTED)
    im.save(path)
    print("готово:", path, im.size)

if __name__ == "__main__":
    figure_algorithms()
    figure_transfer()
    figure_screen()
    figure_timeline()
