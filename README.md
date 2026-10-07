# FactGuard — Перевірка новин

Chrome-розширення (Manifest V3) + локальний Python-сервер (FastAPI).

## Структура
```
factguard/
├── manifest.json        # опис розширення, дозволи, content scripts
├── background.js        # service worker: контекстне меню, зв'язок з API
├── content.js           # зчитує новину зі сторінки, показує оверлей
├── src/
│   ├── news-analyzer.js # локальна евристика (капслок, клікбейт, анонімні джерела, домени)
│   └── ui.js            # спільний рендер результатів (оверлей + popup)
├── popup/
│   ├── popup.html       # інтерфейс popup
│   └── popup.js         # логіка popup
└── server/
    ├── main.py          # FastAPI: ключові слова, пошук DDGS, вердикт
    └── requirements.txt
```

## Запуск Python-сервера

Потрібен Python 3.9+ (перевірка: `python --version`).

### Windows (PowerShell)
```powershell
cd factguard\server
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python main.py
```
Якщо PowerShell забороняє активацію: `Set-ExecutionPolicy -Scope Process Bypass`.

### macOS / Linux
```bash
cd factguard/server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

Сервер працює, коли в терміналі видно `Uvicorn running on http://127.0.0.1:8000`.
Термінал не закривайте. Зупинка — `Ctrl+C`.

### Перевірка
- Браузер: http://127.0.0.1:8000/api/health → `{"status":"ok"}`
- Swagger-інтерфейс для тестів: http://127.0.0.1:8000/docs
- Через curl:
```bash
curl -X POST http://127.0.0.1:8000/api/verify-news \
  -H "Content-Type: application/json" \
  -d '{"title":"Верховна Рада ухвалила держбюджет","text":"","url":""}'
```

### Типові проблеми
| Проблема | Рішення |
|---|---|
| `ModuleNotFoundError` | Активуйте venv і виконайте `pip install -r requirements.txt` |
| `Address already in use` | Порт 8000 зайнято: закрийте інший сервер або змініть порт у `main.py` та `background.js` (+ `host_permissions`) |
| Розширення пише «Не вдалося підключитися» | Сервер не запущено або зупинився |
| Помилка 503 «DuckDuckGo недоступна» | Тимчасове обмеження пошуку — зачекайте хвилину; оновіть пакет: `pip install -U duckduckgo_search` (або `ddgs`) |

## Встановлення розширення
1. `chrome://extensions` → увімкніть «Режим розробника».
2. «Завантажити розпаковане» → оберіть папку `factguard` (де лежить `manifest.json`).
3. Після зміни коду натисніть ⟳ на картці розширення і перезавантажте вкладку.
