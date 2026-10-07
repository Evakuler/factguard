/**
 * FactGuard — фоновий service worker (Manifest V3).
 *
 * Це "диспетчер" розширення:
 *   • створює пункт контекстного меню "Перевірити новину на фактчекінг";
 *   • приймає від content.js / popup.js повідомлення FG_VERIFY і робить запит до Python API
 *     (fetch до localhost дозволений саме тут завдяки host_permissions у manifest.json);
 *   • ставить значок-індикатор (OK / ? / !) на іконку розширення.
 *
 * Service worker у MV3 "засинає" після бездіяльності, тому ніякого стану тут не зберігаємо.
 */
'use strict';

const API_BASE = 'http://127.0.0.1:8000';
const VERIFY_ENDPOINT = API_BASE + '/api/verify-news';
const REQUEST_TIMEOUT_MS = 40000; // пошук у мережі може тривати кілька секунд
const MENU_ID = 'factguard-check-selection';
// Файли, які треба ін'єктувати, якщо вкладка відкрита ДО встановлення розширення.
const CONTENT_FILES = ['src/news-analyzer.js', 'src/ui.js', 'content.js'];

// Меню створюємо при встановленні/оновленні. removeAll — щоб не було дублів і помилки "duplicate id".
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Перевірити новину на фактчекінг',
      contexts: ['selection'] // пункт з'являється лише коли виділено текст
    });
  });
});

/**
 * Надсилає повідомлення у вкладку. Якщо там ще немає content script
 * (вкладка відкрита до встановлення), програмно ін'єктуємо його і пробуємо ще раз.
 * Для executeScript достатньо дозволу activeTab, який дає клік по меню/іконці.
 */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// Клік по пункту меню -> просимо content.js перевірити виділений текст.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  try {
    await sendToTab(tab.id, { type: 'FG_CHECK_SELECTION', selection: info.selectionText || '' });
  } catch (err) {
    // Наприклад, службові сторінки chrome:// — туди ін'єкція заборонена.
    console.warn('FactGuard: не вдалося запустити перевірку на цій сторінці', err);
    setBadge(tab.id, '!', '#6b7280');
  }
});

/** Малює маленький бейдж на іконці розширення для конкретної вкладки. */
function setBadge(tabId, text, color) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

/** Робить із відповіді FastAPI (наприклад, {"detail": "..."}) зрозумілий текст помилки. */
function describeServerError(body, status) {
  let detail = '';
  if (body && body.detail) {
    // При помилці валідації (422) detail — це масив об'єктів, тому серіалізуємо.
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  }
  return 'Сервер FactGuard повернув помилку ' + status + (detail ? ': ' + detail : '.');
}

/**
 * Відправляє новину на Python-сервер.
 * Завжди повертає об'єкт {ok:true,data} або {ok:false,error} — ніколи не кидає виняток,
 * тому викликачам (content/popup) не потрібен власний try/catch для мережі.
 */
async function verifyNews(payload) {
  // AbortController дозволяє перервати запит за таймаутом.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch (e) {
        /* тіло відповіді не JSON — не страшно */
      }
      return { ok: false, error: describeServerError(body, response.status) };
    }
    return { ok: true, data: await response.json() };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: 'Сервер не відповів вчасно. Спробуйте ще раз або перевірте, чи працює Python-сервер.' };
    }
    // Найчастіший випадок: сервер просто не запущено (fetch кидає TypeError "Failed to fetch").
    return {
      ok: false,
      error:
        'Не вдалося підключитися до сервера FactGuard (' + API_BASE + '). ' +
        'Перевірте, що Python-сервер запущено: у папці server виконайте «python main.py».'
    };
  } finally {
    clearTimeout(timer);
  }
}

// Єдине повідомлення, яке ми обробляємо тут: FG_VERIFY (від content.js та popup.js).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'FG_VERIFY') return false;
  verifyNews(message.payload || {}).then((result) => {
    // sender.tab є лише коли повідомлення прийшло зі сторінки (не з popup).
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (result.ok) {
      const map = { confirmed: ['OK', '#16a34a'], insufficient: ['?', '#d97706'], refuted: ['!', '#dc2626'] };
      const b = map[result.data.status] || ['?', '#d97706'];
      setBadge(tabId, b[0], b[1]);
    } else {
      setBadge(tabId, '!', '#6b7280');
    }
    sendResponse(result);
  });
  return true; // ОБОВ'ЯЗКОВО: повідомляє Chrome, що sendResponse буде викликано асинхронно
});
