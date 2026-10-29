// UI text in the browser's language from _locales; a language without a
// translation gets English (default_locale). content.js, a classic script,
// calls chrome.i18n.getMessage the same way.
export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String));
}

// Fills each [data-i18n] element with its message and each
// [data-i18n-placeholder] input with its placeholder. Child elements such as
// <code> keep their place: the message holds each child's text where it goes.
export function localizePage() {
  document.documentElement.lang = t("languageTag");
  for (const element of document.querySelectorAll("[data-i18n]")) {
    let rest = t(element.dataset.i18n);
    const parts = [];
    for (const child of [...element.children]) {
      const [before, ...after] = rest.split(child.textContent);
      parts.push(before, child);
      rest = after.join(child.textContent);
    }
    element.replaceChildren(...parts, rest);
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
}
