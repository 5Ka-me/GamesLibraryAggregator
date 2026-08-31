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
  'lib.recent': 'Recent',
  'lib.sort': 'Sort',
  'lib.sort.name': 'By name',
  'lib.sort.playtime': 'By playtime',

  'filter.all': 'All',
  'filter.installed': 'Installed',
  'filter.search': 'Search…',
  'filter.clear': 'Clear search',

  'sidebar.library': 'Library',
  'sidebar.store': 'Store',
  'sidebar.settings': 'Settings',
  'sidebar.quit': 'Quit',
  'settings.appearance': 'Appearance',

  'store.home': 'Featured',
  'store.wishlist': 'Wishlist',
  'store.featuredSection': 'Featured & recommended',
  'store.showAll': 'Show all →',
  'store.section.specials': 'Specials',
  'store.section.top_sellers': 'Top Sellers',
  'store.section.new_releases': 'New Releases',
  'store.section.coming_soon': 'Coming Soon',
  'store.section.under_budget': 'Deals under $10',
  'store.genre.action': 'Action',
  'store.genre.rpg': 'RPG',
  'store.genre.strategy': 'Strategy',
  'store.genre.indie': 'Indie',

  'details.openInSteam': 'Open in Steam',
  'details.openInEpic': 'Open in Epic',
  'details.actions': 'Launch & install',
  'details.buy': 'Buy',
  'details.cheaper': 'cheaper by {d} than on {p}',
  'details.dearer': 'more expensive by {d} than on {p}',
  'details.samePrice': 'same price as on {p}',
  'details.epicNoData': 'This game was not found in the Epic Games Store.',
  'details.notOnPlatform': 'not on this platform',
  'details.rating': 'EGS rating',
  'details.approxFx': 'Approximate — converted at the daily USD exchange rate',
  'details.inLibrary': 'In your {p} library',
  'details.ownedElsewhere': 'Already in your {p} library — no need to buy',

  'viewer.close': 'Close',
  'viewer.openBrowser': 'Open in browser',

  'settings.regions': 'Store regions',
  'settings.regions.desc':
    'Prices are shown in each store’s regional currency. Auto-detected from your accounts; override with a 2-letter ISO code (UA, KZ, US…). Fallback: US.',
  'details.release': 'Release',
  'details.developer': 'Developer',
  'details.publisher': 'Publisher',
  'details.genres': 'Genres',
  'details.tags': 'Popular tags',
  'details.platforms': 'Platforms',
  'details.reviews': 'Reviews',
  'details.playersNow': 'playing now',
  'details.hours': 'h',
  'details.screenshots': 'Screenshots',
  'details.achievements': 'Achievements',
  'details.achProgress': '{u} of {t} unlocked',
  'details.achUnavailable': 'Achievement data unavailable (no achievements, not played, or private profile).',
  'details.hiddenAch': 'Hidden achievement — click to reveal',
  'details.metacritic': 'Metacritic',
  'details.comingSoon': 'Coming soon',

  'sidebar.stats': 'Statistics',
  'stats.title': 'Statistics',
  'stats.games': 'Games',
  'stats.hours': 'Total hours',
  'stats.played': 'Played at least once',
  'stats.topByPlaytime': 'Top by playtime',
  'stats.recent2w': 'Last 2 weeks (Steam)',
  'lib.recent2w': '{h} h in 2 weeks',
  'stats.noData': 'No data yet — sync your libraries in Settings.',
  'stats.noPlaytime': 'No playtime data for the selected platforms.',
  'store.searchPlaceholder': 'Search the Steam store…',
  'store.results': 'Search results',
  'store.noResults': 'Nothing found.',
  'store.hideOwned': 'Hide games I own',
  'store.free': 'Free',
  'store.inLib.steam': 'Already in your Steam library',
  'store.inLib.epic': 'Already in your EGS library',
  'store.needSteam': 'Set your SteamID in Settings to load the wishlist.',
  'store.wl.empty': 'The wishlist is empty or the profile is private.',
  'store.wl.sort': 'Sort by',
  'store.wl.sort.rank': 'Your rank',
  'store.wl.sort.date': 'Date added',
  'store.wl.sort.name': 'Name',
  'store.wl.sort.price': 'Price',
  'store.wl.sort.discount': 'Discount',
  'store.wl.discountOnly': 'On sale only',
  'store.wl.filter': 'Filter by name…',
  'store.wl.remove': 'Remove from wishlist',
  'store.wl.removeFail': 'Could not remove from the wishlist (sign in to Steam in Settings).',
  'store.personal.popularNew': 'Popular New Releases',
  'store.personal.becauseTag': 'Because you like {tag}',
  'store.personal.becausePlayed': 'Because you played {game}',

  'store.dq.tab': 'Discovery Queue',
  'store.dq.start': 'Generate my queue',
  'store.dq.empty':
    'A personal queue of games Steam picked for you. It is generated only when you ask — no queue is wasted.',
  'store.dq.finished': 'You have reached the end of this queue.',
  'store.dq.next': 'Next',
  'store.dq.details': 'Details',
  'store.dq.addWishlist': 'Add to wishlist',
  'store.dq.inWishlist': 'In wishlist',
  'store.dq.needLogin': 'Sign in to Steam (Settings) to get your personal queue.',
  'store.dq.wishlistFail': 'Could not add to the wishlist.',

  'store.sort.default': 'Default',
  'store.sort.priceAsc': 'Price: low → high',
  'store.sort.priceDesc': 'Price: high → low',
  'store.sort.release': 'Release date',
  'store.sort.reviews': 'Reviews',
  'store.sort.name': 'Name',

  'card.noImage': 'no image',
  'card.hours': 'h',
  'store.choose': 'Open in…',
  'card.play': 'Play',
  'card.install': 'Install',
  'card.uninstall': 'Uninstall',
  'card.cancel': 'Cancel',
  'card.installed': 'Installed',
  'epic.embeddedLogin': 'Sign in to Epic (in-app)',
  'epic.embeddedDesc':
    'Opens Epic sign-in inside the launcher, then authorizes downloads (legendary) and syncs your library.',
  'epic.legendaryMissing':
    'legendary was not found. EGS downloads are disabled — run "npm run fetch:legendary".',

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
  'steam.webLogin': 'Sign in through Steam',
  'steam.webLoginDesc':
    'Opens Steam’s official sign-in inside the app (password & Steam Guard stay with Valve — never seen by this app). No API key needed; works for private profiles.',
  'steam.remember': 'Keep me signed in on this device',
  'steam.signOut': 'Sign out',
  'steam.signedInAs': 'Signed in as {name}. Steam games: {count}.',
  'steam.signedOut': 'Signed out of Steam.',
  'steam.advanced': 'Advanced: sign in with an API key instead',

  'epic.variantAuto': 'Option A — automatic:',
  'epic.autoDesc':
    'if the Epic Games Launcher is installed and signed in on this PC, import its session.',
  'epic.importLauncher': 'Import from launcher',
  'epic.variantManual': 'Option B — manual:',
  'epic.manualDesc': 'open Epic login, sign in, copy the {code} from the JSON and paste it here.',
  'epic.openLogin': '1. Open Epic login page ↗',
  'epic.pasteCode': '2. Paste authorizationCode',
  'epic.connect': '3. Connect',
  'epic.connectedAs': 'Connected{name}. EGS games: {count}.',
  'epic.requiresLogin': 'Sign-in required.',

  'web.landing.title': 'Your Steam + Epic library in one place',
  'web.landing.desc':
    'Sign in through Steam to see your Steam library right in the browser — no keys or tokens needed. With the desktop launcher installed, connect it for the full picture: both stores, playtime and installed games.',
  'web.signIn': 'Sign in through Steam',
  'web.logout': 'Sign out',
  'web.loginFailed': 'Steam sign-in failed — try again.',
  'web.account.desc':
    'Signing in through Steam only proves your SteamID — the site never sees your password. The library is read with a server-side key and requires public game details.',
  'web.source.steamOnly': 'Steam library (web mode)',
  'web.bridge.desc':
    'When the desktop launcher runs on this computer, the site can read its full merged library (both stores, playtime, installed games). The launcher asks for your permission first.',
  'web.bridge.available': 'Desktop launcher detected on this computer.',
  'web.bridge.connect': 'Connect to launcher',
  'web.bridge.connected': 'Data from the launcher (both stores)',
  'web.bridge.disconnect': 'Disconnect',
  'web.bridge.notFound': 'Launcher not detected on this computer.',
  'web.bridge.denied': 'The launcher denied access (or the request was dismissed).',
  'epic.signOut': 'Sign out of Epic',
  'epic.signedOut': 'Signed out of Epic.',

  'bridge.title': 'Web bridge',
  'bridge.desc':
    'Lets the web version on this machine read your library from the launcher (read-only: library, stats, achievements). Each website asks for your permission first.',
  'bridge.enabled': 'Enable local bridge',
  'bridge.listening': 'Listening on 127.0.0.1:{port}',
  'bridge.paired': 'Connected sites',
  'bridge.none': 'No sites connected yet.',
  'bridge.revoke': 'Revoke',

  'update.title': 'Updates',
  'update.version': 'Version {version}',
  'update.check': 'Check for updates',
  'update.checking': 'Checking…',
  'update.none': 'You are up to date.',
  'update.downloading': 'Downloading {version}… {pct}%',
  'update.ready': 'Update {version} is ready',
  'update.restart': 'Restart to update',
  'update.devBuild': 'Updates work only in the installed app.',

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
  'lib.recent': 'Недавние',
  'lib.sort': 'Сортировка',
  'lib.sort.name': 'По имени',
  'lib.sort.playtime': 'По времени в игре',

  'filter.all': 'Все',
  'filter.installed': 'Установленные',
  'filter.search': 'Поиск…',
  'filter.clear': 'Очистить поиск',

  'sidebar.library': 'Библиотека',
  'sidebar.store': 'Магазин',
  'sidebar.settings': 'Настройки',
  'sidebar.quit': 'Выход',
  'settings.appearance': 'Оформление',

  'store.home': 'Главная',
  'store.wishlist': 'Вишлист',
  'store.featuredSection': 'Рекомендуемое',
  'store.showAll': 'Показать все →',
  'store.section.specials': 'Скидки',
  'store.section.top_sellers': 'Лидеры продаж',
  'store.section.new_releases': 'Новинки',
  'store.section.coming_soon': 'Скоро выйдет',
  'store.section.under_budget': 'Скидки до 500 ₽',
  'store.genre.action': 'Экшен',
  'store.genre.rpg': 'RPG',
  'store.genre.strategy': 'Стратегии',
  'store.genre.indie': 'Инди',

  'details.openInSteam': 'Открыть в Steam',
  'details.openInEpic': 'Открыть в Epic',
  'details.actions': 'Запуск и установка',
  'details.buy': 'Купить',
  'details.cheaper': 'дешевле на {d}, чем в {p}',
  'details.dearer': 'дороже на {d}, чем в {p}',
  'details.samePrice': 'цена как в {p}',
  'details.epicNoData': 'Игра не найдена в Epic Games Store.',
  'details.notOnPlatform': 'нет на платформе',
  'details.rating': 'Оценка EGS',
  'details.approxFx': 'Приблизительно — по дневному курсу к доллару',
  'details.inLibrary': 'В библиотеке {p}',
  'details.ownedElsewhere': 'Уже есть в вашей библиотеке {p} — покупать не нужно',

  'viewer.close': 'Закрыть',
  'viewer.openBrowser': 'Открыть в браузере',

  'settings.regions': 'Регионы магазинов',
  'settings.regions.desc':
    'Цены показываются в региональной валюте каждого магазина. Определяется из аккаунтов автоматически; можно переопределить 2-буквенным ISO-кодом (UA, KZ, US…). Fallback: US.',
  'details.release': 'Релиз',
  'details.developer': 'Разработчик',
  'details.publisher': 'Издатель',
  'details.genres': 'Жанры',
  'details.tags': 'Метки',
  'details.platforms': 'Платформы',
  'details.reviews': 'Отзывы',
  'details.playersNow': 'сейчас играют',
  'details.hours': 'ч',
  'details.screenshots': 'Скриншоты',
  'details.achievements': 'Достижения',
  'details.achProgress': 'Открыто {u} из {t}',
  'details.achUnavailable': 'Данные о достижениях недоступны (нет достижений, не запускалась или приватный профиль).',
  'details.hiddenAch': 'Скрытое достижение — нажмите, чтобы раскрыть',
  'details.metacritic': 'Metacritic',
  'details.comingSoon': 'Скоро выйдет',

  'sidebar.stats': 'Статистика',
  'stats.title': 'Статистика',
  'stats.games': 'Игр',
  'stats.hours': 'Всего часов',
  'stats.played': 'Запускалось хоть раз',
  'stats.topByPlaytime': 'Топ по времени',
  'stats.recent2w': 'За 2 недели (Steam)',
  'lib.recent2w': '{h} ч за 2 недели',
  'stats.noData': 'Данных пока нет — синхронизируйте библиотеки в настройках.',
  'stats.noPlaytime': 'Нет данных о времени для выбранных платформ.',
  'store.searchPlaceholder': 'Поиск по магазину Steam…',
  'store.results': 'Результаты поиска',
  'store.noResults': 'Ничего не найдено.',
  'store.hideOwned': 'Скрывать имеющиеся',
  'store.free': 'Бесплатно',
  'store.inLib.steam': 'Уже в вашей библиотеке Steam',
  'store.inLib.epic': 'Уже в вашей библиотеке EGS',
  'store.needSteam': 'Укажите SteamID в настройках, чтобы загрузить вишлист.',
  'store.wl.empty': 'Вишлист пуст или профиль приватный.',
  'store.wl.sort': 'Сортировка',
  'store.wl.sort.rank': 'Ваш порядок',
  'store.wl.sort.date': 'Дата добавления',
  'store.wl.sort.name': 'Название',
  'store.wl.sort.price': 'Цена',
  'store.wl.sort.discount': 'Скидка',
  'store.wl.discountOnly': 'Только со скидкой',
  'store.wl.filter': 'Фильтр по названию…',
  'store.wl.remove': 'Убрать из вишлиста',
  'store.wl.removeFail': 'Не удалось убрать из вишлиста (войдите в Steam в Настройках).',
  'store.personal.popularNew': 'Популярные новинки',
  'store.personal.becauseTag': 'Потому что вам нравится: {tag}',
  'store.personal.becausePlayed': 'Потому что вы играли в {game}',

  'store.dq.tab': 'Очередь исследования',
  'store.dq.start': 'Сгенерировать очередь',
  'store.dq.empty':
    'Персональная очередь игр, подобранных Steam. Генерируется только по вашей команде — очередь не расходуется зря.',
  'store.dq.finished': 'Вы просмотрели всю очередь.',
  'store.dq.next': 'Дальше',
  'store.dq.details': 'Подробнее',
  'store.dq.addWishlist': 'В вишлист',
  'store.dq.inWishlist': 'В вишлисте',
  'store.dq.needLogin': 'Войдите в Steam (Настройки), чтобы получить персональную очередь.',
  'store.dq.wishlistFail': 'Не удалось добавить в вишлист.',

  'store.sort.default': 'По умолчанию',
  'store.sort.priceAsc': 'Цена: по возрастанию',
  'store.sort.priceDesc': 'Цена: по убыванию',
  'store.sort.release': 'Дата выхода',
  'store.sort.reviews': 'Отзывы',
  'store.sort.name': 'Название',

  'card.noImage': 'нет изображения',
  'card.hours': 'ч',
  'store.choose': 'Открыть в…',
  'card.play': 'Играть',
  'card.install': 'Установить',
  'card.uninstall': 'Удалить',
  'card.cancel': 'Отмена',
  'card.installed': 'Установлена',
  'epic.embeddedLogin': 'Войти в Epic (в приложении)',
  'epic.embeddedDesc':
    'Откроет вход Epic внутри лаунчера, затем авторизует загрузки (legendary) и синхронизирует библиотеку.',
  'epic.legendaryMissing':
    'legendary не найден. Загрузки EGS отключены — выполните «npm run fetch:legendary».',

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
  'steam.webLogin': 'Войти через Steam',
  'steam.webLoginDesc':
    'Откроет официальный вход Steam внутри приложения (пароль и Steam Guard остаются у Valve — приложение их не видит). API-ключ не нужен; работает и с приватным профилем.',
  'steam.remember': 'Оставаться в системе на этом устройстве',
  'steam.signOut': 'Выйти',
  'steam.signedInAs': 'Вход выполнен: {name}. Игр Steam: {count}.',
  'steam.signedOut': 'Выход из Steam выполнен.',
  'steam.advanced': 'Дополнительно: вход по API-ключу',

  'epic.variantAuto': 'Вариант А — автоматически:',
  'epic.autoDesc':
    'если на этом ПК установлен и залогинен Epic Games Launcher — импортировать его сессию.',
  'epic.importLauncher': 'Импортировать из лаунчера',
  'epic.variantManual': 'Вариант B — вручную:',
  'epic.manualDesc': 'откройте вход Epic, войдите, скопируйте {code} из JSON и вставьте сюда.',
  'epic.openLogin': '1. Открыть страницу входа Epic ↗',
  'epic.pasteCode': '2. Вставьте authorizationCode',
  'epic.connect': '3. Подключить',
  'epic.connectedAs': 'Подключено{name}. Игр EGS: {count}.',
  'epic.requiresLogin': 'Требуется вход.',

  'update.title': 'Обновления',
  'update.version': 'Версия {version}',
  'update.check': 'Проверить обновления',
  'update.checking': 'Проверка…',
  'update.none': 'У вас последняя версия.',
  'update.downloading': 'Загрузка {version}… {pct}%',
  'update.ready': 'Обновление {version} готово',
  'update.restart': 'Перезапустить и обновить',
  'update.devBuild': 'Обновления работают только в установленном приложении.',

  'common.error': 'Ошибка',

  'web.landing.title': 'Ваши библиотеки Steam и Epic в одном месте',
  'web.landing.desc':
    'Войдите через Steam, чтобы увидеть свою библиотеку Steam прямо в браузере — без ключей и токенов. А если установлен десктоп-лаунчер, подключите его и получите полную картину: оба стора, наигранное время и установленные игры.',
  'web.signIn': 'Войти через Steam',
  'web.logout': 'Выйти',
  'web.loginFailed': 'Вход через Steam не удался — попробуйте ещё раз.',
  'web.account.desc':
    'Вход через Steam лишь подтверждает ваш SteamID — сайт никогда не видит пароль. Библиотека читается серверным ключом и требует публичных данных об играх в профиле.',
  'web.source.steamOnly': 'Библиотека Steam (веб-режим)',
  'web.bridge.desc':
    'Если на этом компьютере запущен десктоп-лаунчер, сайт может читать его полную объединённую библиотеку (оба стора, время, установленные игры). Лаунчер сначала спросит вашего разрешения.',
  'web.bridge.available': 'На этом компьютере найден десктоп-лаунчер.',
  'web.bridge.connect': 'Подключить лаунчер',
  'web.bridge.connected': 'Данные из лаунчера (оба стора)',
  'web.bridge.disconnect': 'Отключить',
  'web.bridge.notFound': 'Лаунчер на этом компьютере не найден.',
  'web.bridge.denied': 'Лаунчер отклонил доступ (или запрос был закрыт).',
  'epic.signOut': 'Выйти из Epic',
  'epic.signedOut': 'Выход из Epic выполнен.',

  'bridge.title': 'Мост для веба',
  'bridge.desc':
    'Позволяет веб-версии на этом компьютере читать библиотеку из лаунчера (только чтение: библиотека, статистика, ачивки). Каждый сайт сначала запрашивает ваше разрешение.',
  'bridge.enabled': 'Включить локальный мост',
  'bridge.listening': 'Слушает 127.0.0.1:{port}',
  'bridge.paired': 'Подключённые сайты',
  'bridge.none': 'Пока нет подключённых сайтов.',
  'bridge.revoke': 'Отозвать',
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
