import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Lang = 'en' | 'ru';

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Game Library Aggregator',
  'app.by': 'by',

  'header.settings': '⚙️ Settings',
  'header.back': '← Library',
  'lang.label': 'Language',

  'theme.toLight': '☀️ Light',
  'theme.toDark': '🌙 Dark',

  'lib.loading': 'Loading…',
  'lib.error': 'Error',
  'lib.empty': 'No games yet. Open “Settings” to sync Steam and/or connect EGS.',

  'filter.all': 'All',
  'filter.steam': 'Steam',
  'filter.epic': 'Epic',
  'filter.both': 'Both',
  'filter.search': 'Search…',
  'filter.clear': 'Clear search',

  'card.noImage': 'no image',
  'card.hours': 'h',
  'store.choose': 'Open in…',

  'settings.steam': 'Steam',
  'settings.epic': 'Epic Games Store',
  'settings.account.steam': 'Steam',
  'settings.account.epic': 'Epic Games',
  'settings.notConfigured': '— not configured',
  'settings.notConnected': '— not connected',
  'settings.connected': 'connected',
  'settings.syncSteam': 'Sync Steam',
  'settings.syncEpic': 'Sync EGS',
  'settings.syncing': 'Syncing…',
  'settings.syncDone': 'Sync ({what}) finished.',

  'steam.help': 'Get a key at',
  'steam.publicProfile': '. Your profile must be public.',
  'steam.apiKey': 'Steam API key',
  'steam.steamId': 'SteamID64',
  'steam.save': 'Save & verify',
  'steam.saved': 'Saved',

  'epic.variantAuto': 'Option A — automatic:',
  'epic.autoDesc':
    'if Epic Games Launcher is installed and signed in on this PC (works only when the backend runs on the host, not in a container).',
  'epic.importLauncher': 'Import from launcher',
  'epic.variantManual': 'Option B — manual:',
  'epic.manualDesc': 'open Epic login, sign in, copy the {code} from the JSON and paste it here.',
  'epic.openLogin': '1. Open Epic login page ↗',
  'epic.pasteCode': '2. Paste authorizationCode',
  'epic.connect': '3. Connect',
  'epic.connectedAs': 'Connected{name}. EGS games: {count}.',
  'epic.requiresLogin': 'Sign-in required.',

  'ws.title': 'Workspace',
  'ws.desc':
    'Your private workspace token. Save it to open your library on another device or after clearing browser data. Anyone with this token sees your library — keep it secret.',
  'ws.show': 'Show token',
  'ws.hide': 'Hide',
  'ws.copy': 'Copy',
  'ws.copied': 'Copied!',
  'ws.useExisting': 'Paste an existing token to switch workspace',
  'ws.apply': 'Switch',

  'common.error': 'Error',
};

const ru: Dict = {
  'app.title': 'Game Library Aggregator',
  'app.by': 'by',

  'header.settings': '⚙️ Настройки',
  'header.back': '← Библиотека',
  'lang.label': 'Язык',

  'theme.toLight': '☀️ Светлая',
  'theme.toDark': '🌙 Тёмная',

  'lib.loading': 'Загрузка…',
  'lib.error': 'Ошибка',
  'lib.empty': 'Игр пока нет. Откройте «Настройки» и синхронизируйте Steam и/или подключите EGS.',

  'filter.all': 'Все',
  'filter.steam': 'Steam',
  'filter.epic': 'Epic',
  'filter.both': 'В обеих',
  'filter.search': 'Поиск…',
  'filter.clear': 'Очистить поиск',

  'card.noImage': 'нет изображения',
  'card.hours': 'ч',
  'store.choose': 'Открыть в…',

  'settings.steam': 'Steam',
  'settings.epic': 'Epic Games Store',
  'settings.account.steam': 'Steam',
  'settings.account.epic': 'Epic Games',
  'settings.notConfigured': '— не настроен',
  'settings.notConnected': '— не подключён',
  'settings.connected': 'подключён',
  'settings.syncSteam': 'Синхронизировать Steam',
  'settings.syncEpic': 'Синхронизировать EGS',
  'settings.syncing': 'Синхронизация…',
  'settings.syncDone': 'Синхронизация ({what}) завершена.',

  'steam.help': 'Ключ берётся на',
  'steam.publicProfile': '. Профиль должен быть публичным.',
  'steam.apiKey': 'Steam API key',
  'steam.steamId': 'SteamID64',
  'steam.save': 'Сохранить и проверить',
  'steam.saved': 'Сохранено',

  'epic.variantAuto': 'Вариант А — автоматически:',
  'epic.autoDesc':
    'если на этом ПК установлен и залогинен Epic Games Launcher (работает только когда бэкенд запущен на хосте, не в контейнере).',
  'epic.importLauncher': 'Импортировать из лаунчера',
  'epic.variantManual': 'Вариант B — вручную:',
  'epic.manualDesc': 'откройте вход Epic, войдите, скопируйте {code} из JSON и вставьте сюда.',
  'epic.openLogin': '1. Открыть страницу входа Epic ↗',
  'epic.pasteCode': '2. Вставьте authorizationCode',
  'epic.connect': '3. Подключить',
  'epic.connectedAs': 'Подключено{name}. Игр EGS: {count}.',
  'epic.requiresLogin': 'Требуется вход.',

  'common.error': 'Ошибка',

  'ws.title': 'Рабочее пространство',
  'ws.desc':
    'Секретный токен вашего пространства. Сохраните его, чтобы открыть библиотеку на другом устройстве или после очистки данных браузера. Любой, у кого есть токен, видит вашу библиотеку — держите его в секрете.',
  'ws.show': 'Показать токен',
  'ws.hide': 'Скрыть',
  'ws.copy': 'Копировать',
  'ws.copied': 'Скопировано!',
  'ws.useExisting': 'Вставьте существующий токен, чтобы переключить пространство',
  'ws.apply': 'Переключить',
};

const dicts: Record<Lang, Dict> = { en, ru };

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: keyof typeof en, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('lang');
    return saved === 'ru' ? 'ru' : 'en'; // default — EN
  });

  useEffect(() => {
    localStorage.setItem('lang', lang);
    document.documentElement.setAttribute('lang', lang);
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let str = dicts[lang][key] ?? dicts.en[key] ?? key;
      if (vars)
        for (const [k, v] of Object.entries(vars))
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      return str;
    },
    [lang]
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nContextValue => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
};
