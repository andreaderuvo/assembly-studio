const BUILTIN_LOCALES = Object.freeze({ en: "English", it: "Italiano", fr: "Français", es: "Español" });
const STORAGE_KEY = "rc-car-custom-locales-v1";
const catalogs = new Map();
let activeLocale = "en";

function customPacks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

function validatePack(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid translation file");
  const locale = String(value.locale || "").toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z0-9]{2,8})*$/.test(locale)) throw new Error("Invalid locale code");
  if (!value.messages || typeof value.messages !== "object" || Array.isArray(value.messages)) {
    throw new Error("The translation file must contain a messages object");
  }
  const messages = {};
  for (const [key, message] of Object.entries(value.messages)) {
    if (typeof message !== "string") throw new Error(`Translation ${key} must be text`);
    messages[key] = message;
  }
  return { locale, name: String(value.name || locale), messages };
}

async function loadLocale(locale) {
  if (catalogs.has(locale)) return catalogs.get(locale);
  const custom = customPacks()[locale];
  if (custom) {
    const pack = validatePack(custom); catalogs.set(locale, pack); return pack;
  }
  if (!BUILTIN_LOCALES[locale]) return null;
  const response = await fetch(`/locales/${locale}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load locale: ${locale}`);
  const pack = validatePack(await response.json()); catalogs.set(locale, pack); return pack;
}

export function t(key, variables = {}) {
  const localized = catalogs.get(activeLocale)?.messages[key];
  const template = localized || catalogs.get("en")?.messages[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? `{${name}}`));
}

export function translateDocument(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of root.querySelectorAll("[data-i18n-title]")) element.title = t(element.dataset.i18nTitle);
  for (const element of root.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
}

export async function setLocale(locale) {
  const requested = String(locale || "en").toLowerCase();
  const fallback = requested.split("-")[0];
  activeLocale = await loadLocale(requested) ? requested : await loadLocale(fallback) ? fallback : "en";
  document.documentElement.lang = activeLocale;
  document.documentElement.dir = "ltr";
  localStorage.setItem("rc-car-locale", activeLocale);
  translateDocument();
  window.dispatchEvent(new CustomEvent("i18n:changed", { detail: { locale: activeLocale } }));
}

export async function initI18n() {
  await loadLocale("en");
  await setLocale(localStorage.getItem("rc-car-locale") || document.documentElement.lang || navigator.language);
}

export function availableLocales() {
  const custom = customPacks();
  return Object.entries(BUILTIN_LOCALES).map(([locale, name]) => ({ locale, name }))
    .concat(Object.values(custom).map((value) => ({ locale: value.locale, name: value.name })))
    .filter((item, index, values) => values.findIndex((other) => other.locale === item.locale) === index);
}

export function currentLocale() { return activeLocale; }

export async function importLocaleFile(file) {
  const pack = validatePack(JSON.parse(await file.text()));
  const englishKeys = Object.keys(catalogs.get("en").messages);
  const unknownKeys = Object.keys(pack.messages).filter((key) => !englishKeys.includes(key));
  const packs = customPacks(); packs[pack.locale] = pack;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(packs));
  catalogs.set(pack.locale, pack);
  await setLocale(pack.locale);
  return { ...pack, translated: Object.keys(pack.messages).length, total: englishKeys.length, unknownKeys };
}

export function downloadLocaleTemplate() {
  const messages = Object.fromEntries(Object.keys(catalogs.get("en").messages).map((key) => [key, ""]));
  const payload = { "$schema": "/locales/translation.schema.json", locale: "xx", name: "Language name", messages };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "assembly-studio.locale-template.json"; anchor.click();
  URL.revokeObjectURL(url);
}
