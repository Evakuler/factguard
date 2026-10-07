/**
 * FactGuard — content script.
 *
 * Виконується всередині відкритої вкладки (у "ізольованому світі": бачить DOM сторінки,
 * але не бачить змінних самого сайту). Відповідає за:
 *   1) витягування заголовка (h1) і тексту статті;
 *   2) запуск локального аналізу (FactGuardAnalyzer) та запит до сервера через background.js;
 *   3) показ плаваючого оверлею з результатом.
 *
 * Оверлей створюється в Shadow DOM, щоб стилі сайту не ламали наш вигляд і навпаки.
 */
(function () {
  'use strict';

  // Захист від подвійного завантаження (скрипт можуть ін'єктувати повторно).
  if (window.__factguardLoaded) return;
  window.__factguardLoaded = true;

  const UI = window.FactGuardUI;             // з src/ui.js
  const Analyzer = window.FactGuardAnalyzer; // з src/news-analyzer.js
  const HOST_ID = 'factguard-overlay-host';
  const MAX_TEXT = 6000; // обмежуємо обсяг тексту, що відправляється на сервер

  // Додаткові стилі лише для рамки оверлея (стилі вмісту беруться з UI.CSS).
  const OVERLAY_CSS = `
:host{all:initial}
.fg-panel{width:390px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(15,23,42,.35);overflow:hidden;animation:fg-in .25s ease-out;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@keyframes fg-in{from{opacity:0;transform:translateY(-10px) scale(.98)}to{opacity:1;transform:none}}
.fg-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:linear-gradient(135deg,#1e293b,#4338ca);color:#fff}
.fg-brand{font-weight:700;font-size:15px;letter-spacing:.2px}
.fg-brand small{font-weight:400;opacity:.75;margin-left:6px;font-size:11px}
.fg-close{all:unset;cursor:pointer;width:26px;height:26px;border-radius:8px;text-align:center;line-height:26px;font-size:18px;color:#fff;background:rgba(255,255,255,.15)}
.fg-close:hover{background:rgba(255,255,255,.3)}
.fg-body{padding:14px;overflow-y:auto}
`;

  let host = null;   // елемент-контейнер оверлея на сторінці
  let bodyEl = null; // всередині Shadow DOM: сюди підставляється вміст

  function closeOverlay() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    bodyEl = null;
  }

  /** Створює оверлей, якщо його ще немає (або сайт його видалив зі сторінки). */
  function ensureOverlay() {
    if (host && document.documentElement.contains(host) && bodyEl) return;
    closeOverlay();

    host = document.createElement('div');
    host.id = HOST_ID;
    // fixed + максимальний z-index = завжди поверх сторінки, у правому верхньому куті.
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = UI.CSS + OVERLAY_CSS;

    const closeBtn = UI.h('button', { class: 'fg-close', title: 'Закрити', 'aria-label': 'Закрити', onClick: closeOverlay }, '×');
    bodyEl = UI.h('div', { class: 'fg-body' });
    const panel = UI.h(
      'div',
      { class: 'fg-panel', role: 'dialog', 'aria-label': 'FactGuard' },
      UI.h('div', { class: 'fg-head' }, UI.h('div', { class: 'fg-brand' }, '🛡️ FactGuard', UI.h('small', { text: 'Перевірка новин' })), closeBtn),
      bodyEl
    );

    shadow.appendChild(style);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
  }

  /** Замінює вміст оверлея на переданий DOM-вузол. */
  function showNode(node) {
    ensureOverlay();
    bodyEl.replaceChildren(node);
  }

  // Закриття оверлея клавішею Esc.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host) closeOverlay();
  });

  // ---------- Витягування новини зі сторінки ----------

  /** Заголовок: спершу h1 (краще всередині <article>), інакше og:title, інакше <title>. */
  function getHeadline() {
    const h1 = document.querySelector('article h1') || document.querySelector('h1');
    const fromH1 = h1 && (h1.innerText || h1.textContent || '').trim();
    if (fromH1) return fromH1;
    const og = document.querySelector('meta[property="og:title"]');
    return ((og && og.content) || document.title || '').trim();
  }

  /** Тексти всіх <p> усередині root, довших за minLen символів (відсікає меню, підписи, "Читайте також"). */
  function paragraphsOf(root, minLen) {
    return Array.from(root.querySelectorAll('p'))
      .map((p) => (p.innerText || p.textContent || '').trim())
      .filter((t) => t.length >= minLen);
  }

  /**
   * Основний текст: пробуємо типові контейнери статті. Беремо перший, де набралось >200 символів.
   * Якщо не вийшло — збираємо довгі абзаци з усієї сторінки.
   */
  function getArticleText() {
    const selectors = ['article', '[itemprop="articleBody"]', '.article-body', '.article__text', '.post-content', '.entry-content', 'main', '#content'];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const joined = paragraphsOf(node, 40).join('\n');
      if (joined.length > 200) return joined.slice(0, MAX_TEXT);
    }
    return paragraphsOf(document.body, 60).join('\n').slice(0, MAX_TEXT);
  }

  function extractArticle() {
    return { title: getHeadline(), text: getArticleText(), url: location.href };
  }

  /**
   * Для перевірки виділеного фрагмента:
   *  • короткий (≤250 символів) вважаємо заголовком/твердженням;
   *  • довгий — текстом, а заголовок беремо зі сторінки.
   */
  function articleFromSelection(selection) {
    const sel = (selection || window.getSelection().toString() || '').trim();
    if (sel.length <= 250) return { title: sel, text: '', url: location.href };
    return { title: getHeadline(), text: sel.slice(0, MAX_TEXT), url: location.href };
  }

  // ---------- Перевірка ----------

  /**
   * Повний цикл: локальний аналіз -> спінер -> запит до сервера -> результат.
   * Повертає {local, response}, щоб popup теж міг показати дані.
   */
  async function runCheck(article) {
    if (!article.title && !article.text) {
      const error = 'Не вдалося знайти текст новини на цій сторінці. Виділіть заголовок або абзац і виберіть «Перевірити новину на фактчекінг» у контекстному меню.';
      showNode(UI.renderResult({ error }));
      return { local: null, response: { ok: false, error } };
    }

    // 1) Миттєвий локальний аналіз стилю (не потребує сервера).
    const local = Analyzer.analyze(article);
    showNode(UI.renderLoading('Виконуємо перехресну перевірку у ЗМІ…'));

    // 2) Запит до сервера — через background.js. style_score допомагає серверу з вердиктом.
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'FG_VERIFY',
        payload: { title: article.title, text: article.text, url: article.url, style_score: local.score }
      });
      if (!response) throw new Error('empty response');
    } catch (err) {
      // Типово: розширення оновили/перезавантажили, а сторінка ще зі "старим" скриптом.
      response = { ok: false, error: 'Розширення не отримало відповіді від фонового скрипта. Перезавантажте сторінку та спробуйте ще раз.' };
    }

    // 3) Показ результату. Якщо сервер недоступний — все одно показуємо локальні маніпуляції + помилку.
    if (response.ok) showNode(UI.renderResult({ local, server: response.data }));
    else showNode(UI.renderResult({ local, error: response.error }));
    return { local, response };
  }

  // Повідомлення від popup (FG_SCAN_PAGE) та background (FG_CHECK_SELECTION).
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'FG_SCAN_PAGE' || message.type === 'FG_CHECK_SELECTION') {
      const article = message.type === 'FG_SCAN_PAGE' ? extractArticle() : articleFromSelection(message.selection);
      runCheck(article)
        .then((result) => sendResponse({ ok: true, article, local: result.local, response: result.response }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true; // відповідь асинхронна
    }
    return false;
  });
})();
