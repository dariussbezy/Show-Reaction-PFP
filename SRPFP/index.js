"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { findAssetId } = rain.api.assets;
const { after, before, instead } = rain.api.patcher;
const { createPluginStore } = rain.api.storage;
const { showToast } = rain.api.ui.toasts;
const { findInReactTree } = rain.utils;
const { findByName, findByProps, findByStoreName, findByTypeDisplayName } = rain.metro;
const { clipboard, FluxDispatcher, NavigationNative, React, ReactNative: RN } = rain.metro.common;
const { ChannelStore, MessageStore, PrivateChannelSortStore, SelectedChannelStore, UserStore } = rain.metro.common.stores;
/* ------------------------------------------------------------------ */
/* constants + settings store                                          */
/* ------------------------------------------------------------------ */
const BUILD = "v1.0.8";
const QT_TEXT_BRIDGE_KEY = "__rainQuickTranslateTextBridge";
const FLAG_TOGGLE = 0x04000000;
const ACCENT = "#8EA1FF";
const MAX_TRANSLATIONS = 300;
const MAX_CACHE = 200;
const MAX_HISTORY = 100;
const MAX_FAVS = 6;
const TIMEOUT = 12000;
const REQUEST_GAP = 1200;
const MAX_PENDING_AUTO_REQUESTS = 4;
const DEFAULT_429_COOLDOWN = 60000;
const PROTECT = /```[\s\S]*?```|`[^`\n]+`|<a?:\w+:\d+>|<[@#][!&]?\d+>|<t:-?\d+(?::[A-Za-z])?>|https?:\/\/[^\s<>]+/g;
const INLINE = new Set(["text", "strong", "em", "u", "s", "inlineCode", "customEmoji"]);
const HEX = /^#[0-9A-Fa-f]{6}$/;
const LANGS = [
    ["en", "English"], ["ro", "Romanian"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
    ["pt", "Portuguese"], ["ru", "Russian"], ["uk", "Ukrainian"], ["pl", "Polish"], ["nl", "Dutch"], ["tr", "Turkish"],
    ["ar", "Arabic"], ["he", "Hebrew"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"],
    ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"], ["id", "Indonesian"], ["th", "Thai"],
    ["vi", "Vietnamese"], ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["cs", "Czech"],
    ["sk", "Slovak"], ["hu", "Hungarian"], ["el", "Greek"], ["bg", "Bulgarian"], ["sr", "Serbian"], ["hr", "Croatian"],
    ["sl", "Slovenian"], ["lt", "Lithuanian"], ["lv", "Latvian"], ["et", "Estonian"], ["fa", "Persian"], ["bn", "Bengali"],
    ["ur", "Urdu"], ["ms", "Malay"], ["ta", "Tamil"], ["te", "Telugu"], ["sw", "Swahili"], ["af", "Afrikaans"],
    ["ca", "Catalan"], ["tl", "Filipino"], ["is", "Icelandic"], ["ga", "Irish"], ["cy", "Welsh"], ["sq", "Albanian"],
    ["mk", "Macedonian"], ["ka", "Georgian"], ["hy", "Armenian"], ["az", "Azerbaijani"], ["kk", "Kazakh"],
    ["uz", "Uzbek"], ["mn", "Mongolian"], ["ne", "Nepali"], ["si", "Sinhala"], ["my", "Myanmar"], ["km", "Khmer"],
    ["lo", "Lao"], ["la", "Latin"], ["eo", "Esperanto"],
];
const LANG_NAME = new Map(LANGS);
const COLOR_PRESETS = [
    ["Default", ACCENT], ["Red", "#ED4245"], ["Orange", "#F07B3E"], ["Gold", "#F1C40F"], ["Green", "#43B581"],
    ["Teal", "#1ABC9C"], ["Blue", "#3498DB"], ["Indigo", "#5865F2"], ["Purple", "#9B59B6"], ["Pink", "#EB459E"], ["Gray", "#80848E"],
];
const { useStore: useQuickTranslate } = createPluginStore("quicktranslate", {
    settingsVersion: 0,
    targetOut: "en",
    targetIn: "en",
    sourceOut: "auto",
    immersive: true,
    translationColor: ACCENT,
    showButton: true,
    draftBeforeSend: true,
    saveHistory: true,
    rememberLanguagesPerChat: true,
    chatLanguages: {},
    highlightDraftButton: true,
    keepArmed: true,
    hideGiftButton: true,
    provider: "google",
    deeplApiKey: "",
    anchor: "actions",
    favLangs: ["en", "es", "fr", "de", "ro", "ru"],
    showSourceLanguage: false,
    autoChannelIds: [],
    autoIncomingImmersive: true,
    protectedWords: [],
    historyEntries: [],
    cacheEntries: [],
    keepMessageTranslations: true,
    messageTranslations: [],
});
const qt = new Proxy(Object.create(null), {
    get(_target, prop) { return Reflect.get(useQuickTranslate.getState(), prop); },
});
const updateQuickTranslateSettings = (patch) => useQuickTranslate.getState().updateSettings(patch);
const translations = new Map();
const cache = new Map();
const inFlight = new Map();
const providerCooldownUntil = new Map();
let pendingRequestCount = 0;
let cacheGeneration = 0;
const autoSeen = new Set();
const unpatches = [];
const bridge = { text: "", change: null, inst: null, seen: 0 };
const refWrappers = new WeakMap();
const buttonListeners = new Set();
let armed = null;
let lastChannelId = null;
let lastOriginal = null;
let lastOriginalChannelId = null;
let renderErrors = 0;
let renderUnpatch = null;
let pluginStarted = false;
let ThemeStore;
let persistentReady = false;
let historyEntries = [];
let requestTail = Promise.resolve();
let lastRequestAt = 0;
let bulkSelectionRequest = null;
let bulkSelectionNonce = 0;
let pendingMessageRequest = null;
let messageRequestNonce = 0;
const toast = (t) => { try {
    showToast(t);
}
catch (_) { /* ignore */ } };
const safe = (fn, fallback) => { try {
    return fn();
}
catch (_) {
    return fallback;
} };
const trimMap = (m, max) => { while (m.size > max)
    m.delete(m.keys().next().value); };
const langName = (code) => (code === "auto" ? "Auto-detect" : LANG_NAME.get(code) || code);
const notifyButton = () => buttonListeners.forEach(f => { try {
    f();
}
catch (_) { /* ignore */ } });
const getMessage = (c, id) => safe(() => MessageStore.getMessage(c, id) || null, null);
const getChannel = (id) => safe(() => (id ? ChannelStore.getChannel(id) : null), null);
const isDM = (ch) => !!ch && (ch.type === 1 || ch.type === 3);
const nameOf = (u) => (u ? u.globalName || u.global_name || u.username || "Unknown" : "Unknown");
function getChannelDisplayName(channelId) {
    const channel = getChannel(channelId);
    if (!channel)
        return channelId ? "Unavailable channel" : "Draft (not sent)";
    if (isDM(channel)) {
        const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
        const names = recipients.map((id) => nameOf(safe(() => UserStore.getUser(String(id)), null)));
        return channel.name || names.join(", ") || "Direct message";
    }
    return channel.name ? "# " + channel.name : "Channel";
}
function currentChannelId() {
    return safe(() => SelectedChannelStore.getChannelId?.() ?? SelectedChannelStore.getCurrentlySelectedChannelId?.() ?? null, null);
}
function getChatLanguages(channelId = currentChannelId()) {
    const stored = channelId && qt.rememberLanguagesPerChat !== false ? qt.chatLanguages?.[channelId] : null;
    return { sourceOut: stored?.sourceOut || qt.sourceOut || "auto", targetOut: stored?.targetOut || qt.targetOut || "en" };
}
function saveChatLanguages(channelId, patch) {
    if (!channelId || qt.rememberLanguagesPerChat === false) {
        const globalPatch = {};
        if (patch.sourceOut)
            globalPatch.sourceOut = patch.sourceOut;
        if (patch.targetOut)
            globalPatch.targetOut = patch.targetOut;
        useQuickTranslate.getState().updateSettings(globalPatch);
        return;
    }
    const chatLanguages = Object.assign({}, useQuickTranslate.getState().chatLanguages || {});
    chatLanguages[channelId] = Object.assign({}, chatLanguages[channelId] || getChatLanguages(channelId), patch);
    useQuickTranslate.getState().updateSettings({ chatLanguages });
}
function persistLocalData() {
    if (!persistentReady)
        return;
    try {
        useQuickTranslate.getState().updateSettings({
            historyEntries: historyEntries.slice(0, MAX_HISTORY),
            cacheEntries: Array.from(cache.entries()).slice(-MAX_CACHE),
        });
    }
    catch (_) { /* settings may still be hydrating */ }
}
function clearTranslationData() {
    const state = useQuickTranslate.getState();
    const historyCount = historyEntries.length;
    const cacheCount = Math.max(cache.size, Array.isArray(state.cacheEntries) ? state.cacheEntries.length : 0);
    cacheGeneration++;
    cache.clear();
    inFlight.clear();
    historyEntries = [];
    state.updateSettings({ historyEntries: [], cacheEntries: [], messageTranslations: [] });
    persistLocalData();
    toast(`Translation history, saved message translations and cache cleared (${historyCount} history, ${cacheCount} cached)`);
}
function hydrateLocalData() {
    const generationAtStart = cacheGeneration;
    const load = () => {
        const state = useQuickTranslate.getState();
        historyEntries = Array.isArray(state.historyEntries) ? state.historyEntries.filter((x) => x && typeof x.original === "string" && typeof x.translated === "string").slice(0, MAX_HISTORY) : [];
        cache.clear();
        if (generationAtStart === cacheGeneration && Array.isArray(state.cacheEntries)) {
            for (const entry of state.cacheEntries.slice(-MAX_CACHE)) {
                if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1] && typeof entry[1].text === "string")
                    cache.set(entry[0], entry[1]);
            }
        }
        persistentReady = true;
        restoreMessageTranslations();
        persistLocalData();
    };
    const state = useQuickTranslate.getState();
    if (state._hasHydrated) {
        load();
        return;
    }
    const unsubscribe = useQuickTranslate.subscribe((next) => {
        if (!next._hasHydrated)
            return;
        unsubscribe();
        load();
    });
    unpatches.push(unsubscribe);
}
function restoreMessageTranslations() {
    const state = useQuickTranslate.getState();
    if (state.keepMessageTranslations === false || !Array.isArray(state.messageTranslations))
        return;
    const restoredIds = new Set();
    for (const entry of state.messageTranslations.slice(0, MAX_TRANSLATIONS)) {
        if (!entry || typeof entry.messageId !== "string" || typeof entry.channelId !== "string" || typeof entry.translated !== "string")
            continue;
        const entryId = entry.channelId + "|" + entry.messageId;
        if (restoredIds.has(entryId))
            continue;
        restoredIds.add(entryId);
        translations.set(entry.messageId, {
            text: entry.translated, src: entry.source || "auto", tl: entry.target || "en",
            at: Number(entry.at) || Date.now(), ch: entry.channelId,
            provider: entry.provider || "google", immersive: entry.immersive, autoIncoming: !!entry.autoIncoming,
        });
    }
    trimMap(translations, MAX_TRANSLATIONS);
    for (const entry of state.messageTranslations.slice(0, MAX_TRANSLATIONS)) {
        if (entry && entry.channelId && entry.messageId && getMessage(entry.channelId, entry.messageId))
            refreshRow(entry.channelId, entry.messageId);
    }
}
function saveMessageTranslation(message, result, target, channelId, autoIncoming, immersiveOverride) {
    const state = useQuickTranslate.getState();
    if (state.keepMessageTranslations === false || !message?.id || !channelId || !result?.text)
        return;
    const messageId = String(message.id);
    const channel = String(channelId);
    const id = channel + "|" + messageId;
    const entries = Array.isArray(state.messageTranslations) ? state.messageTranslations : [];
    const next = [{
        id, messageId, channelId: channel, original: String(message.content || ""),
        translated: result.text, source: result.src || "auto", target, at: Date.now(),
        provider: result.provider || qt.provider || "google", autoIncoming: !!autoIncoming, immersive: immersiveOverride,
    }, ...entries.filter(entry => entry?.id !== id)].slice(0, MAX_TRANSLATIONS);
    state.updateSettings({ messageTranslations: next });
}
function addHistory(original, translated, result, target, channelId = currentChannelId(), messageId = null) {
    if (!persistentReady || qt.saveHistory === false || !translated || result.same)
        return;
    const provider = result.provider || qt.provider || "google";
    const id = [channelId || "draft", messageId || "", provider, result.src || "auto", target, original].join("|");
    historyEntries = historyEntries.filter(item => item.id !== id);
    historyEntries.unshift({
        id, original, translated, source: result.src || "auto", target,
        provider, at: Date.now(), channelId, channelName: getChannelDisplayName(channelId), messageId,
    });
    historyEntries = historyEntries.slice(0, MAX_HISTORY);
    persistLocalData();
}
function enqueueRequest(work, automatic = false) {
    if (automatic && pendingRequestCount >= MAX_PENDING_AUTO_REQUESTS)
        return Promise.reject(new Error("Automatic translation skipped because the request queue is busy"));
    pendingRequestCount++;
    const task = requestTail.catch(() => undefined).then(async () => {
        const wait = Math.max(0, REQUEST_GAP - (Date.now() - lastRequestAt));
        if (wait)
            await new Promise(resolve => setTimeout(resolve, wait));
        lastRequestAt = Date.now();
        return work();
    });
    requestTail = task.then(() => { pendingRequestCount = Math.max(0, pendingRequestCount - 1); }, () => { pendingRequestCount = Math.max(0, pendingRequestCount - 1); });
    return task;
}
function palette() {
    const light = safe(() => {
        ThemeStore = ThemeStore || findByStoreName("ThemeStore");
        return !!ThemeStore && ThemeStore.theme === "light";
    }, false);
    return light
        ? { text: "#060607", sub: "#5C5E66", bg: "#FFFFFF", card: "#F2F3F5", blurple: "#5865F2", card2: "rgba(0,0,0,0.045)", chip: "rgba(0,0,0,0.07)", press: "rgba(0,0,0,0.06)", off: "#B5BAC1" }
        : { text: "#FFFFFF", sub: "#B5BAC1", bg: "#1E1F22", card: "#2B2D31", blurple: "#5865F2", card2: "rgba(255,255,255,0.06)", chip: "rgba(255,255,255,0.10)", press: "rgba(255,255,255,0.07)", off: "#4E5058" };
}
const translationColor = () => (HEX.test(String(qt.translationColor || "")) ? String(qt.translationColor).toUpperCase() : ACCENT);
const LANGUAGE_FLAGS = {
    en: "🇺🇸", ro: "🇷🇴", es: "🇪🇸", fr: "🇫🇷", de: "🇩🇪", it: "🇮🇹", pt: "🇧🇷", ru: "🇷🇺", uk: "🇺🇦", pl: "🇵🇱",
    nl: "🇳🇱", tr: "🇹🇷", ar: "🇸🇦", he: "🇮🇱", hi: "🇮🇳", ja: "🇯🇵", ko: "🇰🇷", "zh-CN": "🇨🇳", "zh-TW": "🇹🇼",
    id: "🇮🇩", th: "🇹🇭", vi: "🇻🇳", sv: "🇸🇪", da: "🇩🇰", no: "🇳🇴", fi: "🇫🇮", cs: "🇨🇿", sk: "🇸🇰", hu: "🇭🇺",
    el: "🇬🇷", bg: "🇧🇬", sr: "🇷🇸", hr: "🇭🇷", sl: "🇸🇮", lt: "🇱🇹", lv: "🇱🇻", et: "🇪🇪", fa: "🇮🇷", bn: "🇧🇩",
    ur: "🇵🇰", ms: "🇲🇾", sw: "🇰🇪", af: "🇿🇦", tl: "🇵🇭", is: "🇮🇸", ga: "🇮🇪",
};
const languageLabel = (code, name = langName(code)) => (LANGUAGE_FLAGS[code] ? LANGUAGE_FLAGS[code] + "  " : "") + name;
/* ---- shared settings design kit (identical in AML / GPL / QT) ---- */
const KIT_TILES = {
  lang: ["LanguageIcon", "\u6587", "#5865F2"], paint: ["PaintPaletteIcon", "\u25C9", "#EB459E"], time: ["ClockIcon", "\u25F7", "#E58A00"],
  store: ["ClipboardListIcon", "\u25A3", "#3BA55D"], trash: ["TrashIcon", "\u232B", "#ED4245"], edit: ["PencilIcon", "\u270E", "#F07B3E"],
  shield: ["ShieldIcon", "\u2298", "#80848E"], bell: ["BellIcon", "!", "#E58A00"], at: ["BellIcon", "@", "#ED4245"],
  reply: ["ChatMarkUnreadIcon", "\u21A9", "#5865F2"], search: ["CompassIcon", "\u2315", "#1ABC9C"], chat: ["ChatMarkUnreadIcon", "\u25A4", "#5865F2"],
  plus: ["PlusSmallIcon", "+", "#5865F2"], link: ["LinkIcon", "\u2197", "#3498DB"], test: ["WrenchIcon", "\u25B7", "#9B59B6"],
  star: ["StarIcon", "\u2605", "#D99700"], server: ["PinIcon", "\u25C7", "#3498DB"], power: ["SettingsIcon", "\u25CF", "#43B581"],
  text: ["PencilIcon", "Aa", "#F07B3E"], guide: ["ClipboardCheckIcon", "?", "#5865F2"], gear: ["SettingsIcon", "\u2022", "#80848E"]
};
const KIT_RULES = [
  [/^(default|red|orange|gold|green|teal|blue|indigo|purple|pink|gray)$/i, null],
  [/^ghost ping logger$/i, "power"], [/color|appearance/, "paint"], [/notify|alert|toast/, "bell"], [/test/, "test"],
  [/button|position|composer/, "plus"], [/clear|remove/, "trash"],
  [/clock|time|history|retention|keep .* for/, "time"], [/quick|favorite|saved/, "star"],
  [/cache|storage|persist|remember|restart|across/, "store"],
  [/deleted|delete/, "trash"], [/edit/, "edit"], [/ignore/, "shield"], [/mention|everyone|ping/, "at"],
  [/reply|replies/, "reply"], [/filter|search/, "search"], [/jump/, "link"],
  [/translate|translation|google|deepl|language/, "lang"], [/word|term/, "text"], [/server|guild/, "server"],
  [/capture|message|channel|dm/, "chat"], [/enabled|logger/, "power"]
];
const kitAssetCache = new Map();
function kitAsset(name) {
  const hit = kitAssetCache.get(name);
  if (hit && (hit.id || Date.now() - hit.at < 5000)) return hit.id;
  let id = null;
  try { const r = globalThis.rain; id = (r && r.api && r.api.assets && r.api.assets.findAssetId && r.api.assets.findAssetId(name)) || null; } catch (_) { id = null; }
  kitAssetCache.set(name, { id, at: Date.now() });
  return id;
}
function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  const n = Math.round(a * 255).toString(16);
  return "#" + m[1] + (n.length < 2 ? "0" + n : n);
}
function settingIconForTitle(title) {
  const text = String(title || "").toLowerCase();
  const match = KIT_RULES.find(([pattern]) => pattern.test(text));
  return match ? match[1] : null;
}
function kitIconKey(p) {
  if (!p || p.noIcon) return null;
  if (p.icon && KIT_TILES[p.icon]) return p.icon;
  return settingIconForTitle(p.title);
}
function KitChevron(p) {
  const h = React.createElement, s = p.size || 8, deg = p.dir === "up" ? "225deg" : p.dir === "right" ? "-45deg" : "45deg";
  return h(RN.View, { style: { width: s, height: s, borderRightWidth: 2, borderBottomWidth: 2, borderColor: p.color, borderRadius: 1, transform: [{ rotate: deg }], marginTop: p.dir === "up" ? 3 : p.dir === "down" ? -3 : 0, marginHorizontal: 3 } });
}
function KitTile(p) {
  const h = React.createElement, t = KIT_TILES[p.k] || KIT_TILES.gear, size = p.size || 32, asset = kitAsset(t[0]);
  const inner = Math.round(size * 0.56);
  return h(RN.View, { style: { width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: t[2], alignItems: "center", justifyContent: "center", marginRight: p.noMargin ? 0 : 13 } },
    asset ? h(RN.Image, { source: asset, resizeMode: "contain", style: { width: inner, height: inner, tintColor: "#FFFFFF" } })
      : h(RN.Text, { style: { color: "#FFFFFF", fontSize: Math.round(size * 0.5), fontWeight: "700" } }, t[1]));
}
function CustomSection(p) {
  const C = palette(), h = React.createElement;
  const kids = React.Children.toArray(p.children);
  const any = kids.some((k) => k && k.type === CustomRow && kitIconKey(k.props));
  const isAction = (k) => !!k && k.type === CustomAction;
  if (kids.length && kids.every(isAction)) {
    return h(RN.View, { style: { marginBottom: p.title ? 24 : 12 } },
      p.title ? h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 6, marginBottom: 10 } },
        h(RN.View, { style: { width: 3, height: 14, borderRadius: 2, backgroundColor: C.blurple, marginRight: 8 } }),
        h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700", flexShrink: 1 } }, p.title)) : null,
      ...kids.map((k, i) => React.cloneElement(k, { top: i === 0 ? 0 : 10 })));
  }
  const out = kids.map((k, i) => isAction(k)
    ? h(RN.View, { key: "act-" + i, style: { paddingHorizontal: 12, paddingTop: i === 0 ? 12 : 0, paddingBottom: 12 } }, React.cloneElement(k, { top: 0 }))
    : (k && k.type === CustomRow && any && !k.props.noIcon && !kitIconKey(k.props)) ? React.cloneElement(k, { __fallbackIcon: true }) : k);
  return h(RN.View, { style: { marginBottom: p.compact ? 14 : 24 } },
    p.title ? h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 6, marginBottom: 10 } },
      h(RN.View, { style: { width: 3, height: 14, borderRadius: 2, backgroundColor: C.blurple, marginRight: 8 } }),
      h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700", letterSpacing: 0.1, flexShrink: 1 } }, p.title)) : null,
    h(RN.View, { style: { backgroundColor: C.card, borderRadius: 20, overflow: "hidden", borderWidth: 1, borderColor: C.card2 } }, ...out),
    p.footer ? h(RN.Text, { style: { color: C.sub, fontSize: 12, lineHeight: 17, marginHorizontal: 8, marginTop: 8 } }, p.footer) : null);
}
function CustomRow(p) {
  const C = palette(), h = React.createElement;
  const key = p.__fallbackIcon ? (kitIconKey(p) || "gear") : kitIconKey(p);
  const tile = key ? KitTile({ k: key, size: 34 }) : null;
  return h(RN.Pressable, {
    accessibilityRole: p.onPress ? "button" : undefined, onPress: p.onPress, disabled: !p.onPress,
    style: ({ pressed }) => ({ minHeight: 66, paddingHorizontal: 16, paddingVertical: 13, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? C.press : "transparent" })
  },
    tile,
    h(RN.View, { style: { flex: 1, minWidth: 0, paddingRight: 10 } },
      h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21 } }, p.title),
      p.subtitle ? h(RN.Text, { numberOfLines: 3, style: { color: C.sub, fontSize: 13, marginTop: 3, lineHeight: 18 } }, p.subtitle) : null),
    p.trailing || null,
    !p.last ? h(RN.View, { style: { position: "absolute", bottom: 0, left: key ? 63 : 16, right: 0, height: 1, backgroundColor: C.card2 } }) : null);
}
function CustomSwitch(p) {
  const C = palette(), h = React.createElement, on = !!p.value;
  const pos = React.useRef(new RN.Animated.Value(on ? 1 : 0)).current;
  React.useEffect(() => {
    RN.Animated.spring(pos, { toValue: on ? 1 : 0, speed: 24, bounciness: 5, useNativeDriver: true }).start();
  }, [on]);
  return h(RN.Pressable, { accessibilityRole: "switch", accessibilityState: { checked: on }, onPress: () => p.onChange(!on), hitSlop: 10,
    style: { width: 52, height: 32, borderRadius: 16, padding: 3, justifyContent: "center", backgroundColor: on ? (p.color || C.blurple) : C.off } },
    h(RN.Animated.View, { style: { width: 26, height: 26, borderRadius: 13, backgroundColor: "#FFFFFF", shadowColor: "#000000", shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2, transform: [{ translateX: pos.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] } }));
}
function CustomAction(p) {
  const C = palette(), h = React.createElement, RED_ = "#ED4245";
  const sc = React.useRef(new RN.Animated.Value(1)).current;
  const to = (v) => RN.Animated.spring(sc, { toValue: v, speed: 40, bounciness: 0, useNativeDriver: true }).start();
  const bg = p.danger ? (p.secondary ? hexA(RED_, 0.14) : RED_) : (p.secondary ? C.chip : C.blurple);
  const fg = p.danger && p.secondary ? RED_ : (p.secondary ? C.text : "#FFFFFF");
  return h(RN.Pressable, { onPress: p.onPress, disabled: p.disabled, onPressIn: () => to(0.97), onPressOut: () => to(1), accessibilityRole: "button" },
    h(RN.Animated.View, { style: { minHeight: p.compact ? 42 : 50, borderRadius: 15, alignItems: "center", justifyContent: "center", paddingHorizontal: p.compact ? 12 : 18, marginTop: p.top != null ? p.top : 10, backgroundColor: bg, opacity: p.disabled ? 0.45 : 1, transform: [{ scale: sc }] } },
      h(RN.Text, { numberOfLines: 1, style: { color: fg, fontWeight: "700", fontSize: p.compact ? 15 : 16 } }, p.title)));
}
function CustomInput(p) {
  const C = palette(), h = React.createElement;
  const [focused, setFocused] = React.useState(false);
  return h(RN.TextInput, {
    ...p, placeholderTextColor: C.sub, underlineColorAndroid: "transparent", textAlignVertical: p.multiline ? "top" : "center",
    onFocus: (e) => { setFocused(true); if (p.onFocus) p.onFocus(e); },
    onBlur: (e) => { setFocused(false); if (p.onBlur) p.onBlur(e); },
    style: [{ minHeight: 50, borderRadius: 14, borderWidth: 1.5, borderColor: focused ? C.blurple : C.card2, backgroundColor: C.bg, color: C.text, paddingHorizontal: 15, fontSize: 16 }, p.style]
  });
}
let kitHeroPlayed = false;
function KitHero(p) {
  const C = palette(), h = React.createElement, accent = p.accent || C.blurple;
  const stats = (p.stats || []).filter(Boolean);
  const enter = React.useRef(new RN.Animated.Value(kitHeroPlayed ? 1 : 0)).current;
  React.useEffect(() => { if (kitHeroPlayed) return; kitHeroPlayed = true; RN.Animated.spring(enter, { toValue: 1, speed: 14, bounciness: 6, useNativeDriver: true }).start(); }, []);
  return h(RN.Animated.View, { style: { borderRadius: 26, backgroundColor: C.card, borderWidth: 1, borderColor: hexA(accent, 0.4), padding: 18, marginBottom: 24, overflow: "hidden", opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] } },
    h(RN.View, { pointerEvents: "none", style: { position: "absolute", top: -60, right: -50, width: 190, height: 190, borderRadius: 95, backgroundColor: hexA(accent, 0.16) } }),
    h(RN.View, { pointerEvents: "none", style: { position: "absolute", bottom: -70, left: -40, width: 140, height: 140, borderRadius: 70, backgroundColor: hexA(accent, 0.08) } }),
    h(RN.View, { style: { flexDirection: "row", alignItems: "center" } },
      KitTile({ k: p.icon, size: 54, noMargin: true }),
      h(RN.View, { style: { flex: 1, marginLeft: 14 } },
        h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: 21, fontWeight: "800", letterSpacing: -0.2 } }, p.title),
        p.subtitle ? h(RN.Text, { numberOfLines: 2, style: { color: C.sub, fontSize: 14, marginTop: 3, lineHeight: 19 } }, p.subtitle) : null)),
    stats.length ? h(RN.View, { style: { flexDirection: "row", marginTop: 16 } }, ...stats.map((s, i) =>
      h(RN.View, { key: "stat-" + i, style: { flex: 1, borderRadius: 15, backgroundColor: C.chip, paddingVertical: 11, paddingHorizontal: 12, marginRight: i === stats.length - 1 ? 0 : 8 } },
        h(RN.Text, { numberOfLines: 1, adjustsFontSizeToFit: true, style: { color: C.text, fontSize: 19, fontWeight: "800" } }, String(s[1])),
        h(RN.Text, { numberOfLines: 1, style: { color: C.sub, fontSize: 12, marginTop: 2, fontWeight: "600" } }, s[0])))) : null);
}
function KitGuide(p) {
  const C = palette(), h = React.createElement;
  const [open, setOpen] = React.useState(true);
  const steps = p.steps || [];
  return h(RN.View, { style: { marginTop: 4, marginBottom: 16, borderRadius: 20, backgroundColor: C.card, borderWidth: 1, borderColor: C.card2, overflow: "hidden" } },
    h(RN.Pressable, { onPress: () => setOpen(!open), accessibilityRole: "button", accessibilityState: { expanded: open }, style: ({ pressed }) => ({ flexDirection: "row", alignItems: "center", padding: 16, backgroundColor: pressed ? C.press : "transparent" }) },
      KitTile({ k: "guide", size: 34 }),
      h(RN.View, { style: { flex: 1 } },
        h(RN.Text, { style: { color: C.text, fontSize: 17, fontWeight: "800" } }, p.title || "Quick guide"),
        h(RN.Text, { style: { color: C.sub, fontSize: 13, marginTop: 2 } }, steps.length + " short steps")),
      h(RN.View, { style: { width: 24, alignItems: "center", justifyContent: "center" } }, KitChevron({ dir: open ? "up" : "down", color: C.sub, size: 9 }))),
    open ? h(RN.View, { style: { paddingHorizontal: 16, paddingBottom: 6 } }, ...steps.map((s, i) =>
      h(RN.View, { key: "guide-" + i, style: { flexDirection: "row", paddingTop: 12, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.card2 } },
        h(RN.View, { style: { width: 26, height: 26, borderRadius: 13, backgroundColor: hexA(C.blurple, 0.2), alignItems: "center", justifyContent: "center", marginRight: 13, marginTop: 1 } },
          h(RN.Text, { style: { color: C.blurple, fontSize: 13, fontWeight: "800" } }, String(i + 1))),
        h(RN.View, { style: { flex: 1 } },
          h(RN.Text, { style: { color: C.text, fontSize: 15, fontWeight: "700", marginBottom: 3 } }, s[0]),
          h(RN.Text, { style: { color: C.sub, fontSize: 14, lineHeight: 20 } }, s[1]))))) : null);
}
/* ---- end shared kit ---- */
function copyText(text) {
    try {
        clipboard.setString(text);
        toast("Copied");
    }
    catch (_) {
        toast("Could not copy");
    }
}
/* ------------------------------------------------------------------ */
/* translation engine                                                  */
/* ------------------------------------------------------------------ */
function fetchT(url, opts) {
    let timer;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const clear = () => clearTimeout(timer);
    return Promise.race([
        fetch(url, controller ? Object.assign({}, opts, { signal: controller.signal }) : opts),
        new Promise((_, reject) => { timer = setTimeout(() => { try { if (controller) controller.abort(); } catch (_) { /* ignore */ } reject(new Error("Timed out")); }, TIMEOUT); }),
    ]).then(res => { clear(); return res; }, err => { clear(); throw err; });
}
function responseError(message, response, json) {
    const error = new Error((json?.message || message) + " (HTTP " + response.status + ")");
    error.status = response.status;
    const retryAfter = safe(() => response.headers?.get("Retry-After"), null);
    const seconds = Number(retryAfter);
    const dateMs = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : 0;
    error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : dateMs > 0 ? dateMs : DEFAULT_429_COOLDOWN;
    return error;
}
function callApi(provider, text, tl, sl) {
    if (provider === "deepl") {
        const key = String(qt.deeplApiKey || "").trim();
        if (!key)
            return Promise.reject(new Error("Add your DeepL API key in Quick Translate settings"));
        const endpoint = key.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
        const deeplCode = (code) => code === "zh-CN" || code === "zh-TW" ? "ZH" : code === "no" ? "NB" : code.toUpperCase();
        const target = tl === "en" ? "EN-US" : tl === "pt" ? "PT-BR" : tl === "zh-CN" ? "ZH-HANS" : tl === "zh-TW" ? "ZH-HANT" : deeplCode(tl);
        const source = sl && sl !== "auto" ? deeplCode(sl) : undefined;
        const body = { text: [text], target_lang: target };
        if (source)
            body.source_lang = source;
        return fetchT(endpoint, {
            method: "POST",
            headers: { "Authorization": "DeepL-Auth-Key " + key, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }).then(async (res) => {
            const json = await res.json().catch(() => null);
            if (!res.ok)
                throw responseError("DeepL request failed", res, json);
            return json;
        }).then((json) => {
            const result = json?.translations?.[0];
            if (!result?.text)
                throw new Error(json?.message || "DeepL returned an empty translation");
            return { text: String(result.text), src: String(result.detected_source_language || source || "auto").toLowerCase() };
        });
    }
    const params = "client=gtx&dt=t&sl=" + encodeURIComponent(sl || "auto") + "&tl=" + encodeURIComponent(tl);
    const base = "https://translate.googleapis.com/translate_a/single?" + params;
    const req = text.length < 1200
        ? fetchT(base + "&q=" + encodeURIComponent(text))
        : fetchT(base, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: "q=" + encodeURIComponent(text),
        });
    return req.then((res) => {
        if (!res.ok)
            throw responseError("Google Translate request failed", res, null);
        return res.json();
    }).then((json) => {
        const segments = Array.isArray(json) && Array.isArray(json[0]) ? json[0] : [];
        const out = segments.map((s) => (s && s[0]) || "").join("");
        if (!out && text.trim())
            throw new Error("Empty response");
        return { text: out, src: (Array.isArray(json) && typeof json[2] === "string" && json[2]) || sl };
    });
}
function providerLabel(provider) {
    return provider === "deepl" ? "DeepL" : "Google Translate";
}
function prettyToken(t) {
    if (/^<a?:[\w~]+:\d+>$/.test(t))
        return t;
    let m;
    if ((m = /^<@!?(\d+)>$/.exec(t)))
        return "@" + nameOf(safe(() => UserStore.getUser(m[1]), null));
    if ((m = /^<#(\d+)>$/.exec(t)))
        return "#" + ((getChannel(m[1]) || {}).name || "channel");
    if (/^<@&\d+>$/.test(t))
        return "@role";
    if (/^<t:/.test(t))
        return "";
    return t;
}
function isWordChar(ch) {
    return !!ch && (/[0-9_]/.test(ch) || ch.toLowerCase() !== ch.toUpperCase());
}
function protect(text) {
    const tokens = [];
    const hold = (m) => { tokens.push(m); return "§" + (tokens.length - 1) + "§"; };
    // Text that already looks like one of our placeholders is kept verbatim.
    let out = text.replace(/§\s*\d+\s*§/g, hold).replace(PROTECT, hold);
    const words = Array.isArray(qt.protectedWords) ? qt.protectedWords : [];
    for (const raw of words) {
        const word = String(raw || "").trim();
        if (!word)
            continue;
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const first = word[0], last = word[word.length - 1];
        out = out.replace(new RegExp(escaped, "gi"), (m, offset, whole) => {
            // Word boundaries only where the word edge is a letter/digit; works for Cyrillic, symbols and CJK.
            if (isWordChar(first) && isWordChar(whole[offset - 1]))
                return m;
            if (isWordChar(last) && isWordChar(whole[offset + m.length]))
                return m;
            return hold(m);
        });
    }
    return { out, tokens };
}
function restore(text, tokens, pretty) {
    const used = new Set();
    let out = text.replace(/§\s*(\d+)\s*§/g, (m, i) => {
        const t = tokens[Number(i)];
        if (t === undefined)
            return m;
        used.add(Number(i));
        return pretty ? prettyToken(t) : t;
    });
    if (!pretty) {
        const missing = tokens.filter((_, i) => !used.has(i));
        if (missing.length)
            out += " " + missing.join(" ");
    }
    return out;
}
function translate(text, tl, sl, pretty, channelId = currentChannelId(), messageId = null, automatic = false) {
    const source = sl || "auto";
    const protectedWordsKey = (Array.isArray(qt.protectedWords) ? qt.protectedWords : []).map((word) => String(word).toLowerCase().trim()).filter(Boolean).sort().join(",");
    const cacheKey = (qt.provider || "google") + "|" + (pretty ? "p|" : "r|") + source + "|" + tl + "|w:" + protectedWordsKey + "|" + text;
    const generation = cacheGeneration;
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        addHistory(text, cached.text, cached, tl, channelId, messageId);
        return Promise.resolve(cached);
    }
    if (inFlight.has(cacheKey))
        return inFlight.get(cacheKey).then(result => {
            if (generation === cacheGeneration)
                addHistory(text, result.text, result, tl, channelId, messageId);
            return result;
        });
    const { out, tokens } = protect(text);
    if (!out.replace(/§\d+§/g, "").trim())
        return Promise.resolve({ same: true, text, src: source });
    const selectedProvider = qt.provider || "google";
    const requestProvider = (provider) => {
        const cooldownUntil = providerCooldownUntil.get(provider) || 0;
        if (cooldownUntil > Date.now())
            return Promise.reject(new Error(provider + " is paused after HTTP 429; retry in " + Math.ceil((cooldownUntil - Date.now()) / 1000) + "s"));
        return enqueueRequest(async () => {
            const queuedCooldown = providerCooldownUntil.get(provider) || 0;
            if (queuedCooldown > Date.now())
                throw new Error(provider + " is paused after HTTP 429; retry in " + Math.ceil((queuedCooldown - Date.now()) / 1000) + "s");
            try {
                return await callApi(provider, out, tl, source);
            }
            catch (error) {
                if (Number(error?.status) === 429) {
                    const pause = Math.max(DEFAULT_429_COOLDOWN, Number(error.retryAfterMs) || 0);
                    providerCooldownUntil.set(provider, Date.now() + pause);
                }
                throw error;
            }
        }, automatic);
    };
    const request = (selectedProvider !== "deepl"
        ? requestProvider("google").then(res => Object.assign(res, { provider: "google" }))
        : requestProvider("deepl")
            .then(res => Object.assign(res, { provider: "deepl" }))
            .catch((deeplError) => {
            if (Number(deeplError?.status) === 429)
                throw deeplError;
            return requestProvider("google")
            .then(res => Object.assign(res, { provider: "google" }))
            .catch((googleError) => { throw new Error("DeepL and Google failed: " + (googleError?.message || deeplError?.message || "request failed")); });
        })).then(res => {
        const base = String(tl).toLowerCase().split("-")[0];
        const detected = String(res.src || "").toLowerCase().split("-")[0];
        const result = source === "auto" && (!detected || detected === "auto" || detected === base)
            ? { same: true, text, src: res.src, provider: res.provider }
            : { same: false, text: restore(res.text, tokens, pretty), src: res.src, provider: res.provider };
        if (generation === cacheGeneration) {
            cache.set(cacheKey, result);
            trimMap(cache, MAX_CACHE);
            addHistory(text, result.text, result, tl, channelId, messageId);
        }
        return result;
    });
    inFlight.set(cacheKey, request);
    request.then(() => { if (inFlight.get(cacheKey) === request)
        inFlight.delete(cacheKey); }, () => { if (inFlight.get(cacheKey) === request)
        inFlight.delete(cacheKey); });
    return request;
}
/* ------------------------------------------------------------------ */
/* chat input bridge (reads / writes the text box)                     */
/* ------------------------------------------------------------------ */
function isChatInput(props) {
    const ph = typeof props.placeholder === "string" ? props.placeholder : "";
    if (ph && /^(message|mesaj|mensaje|nachricht|messag|написать|сообщение)/i.test(ph))
        return true;
    const ch = getChannel(currentChannelId());
    if (!ch)
        return false;
    let name = ch.name;
    if (isDM(ch) && !name) {
        const rid = ch.recipients && ch.recipients[0];
        name = rid ? nameOf(safe(() => UserStore.getUser(rid), null)) : null;
    }
    if (name && name !== "Unknown" && ph.toLowerCase().includes(String(name).toLowerCase()))
        return true;
    // Discord's composer is a multiline, send-enabled input, including in DMs where
    // the placeholder may be omitted by the current Discord build.
    return !!props.multiline && typeof props.onChangeText === "function" &&
        (typeof props.onSubmitEditing === "function" || props.returnKeyType === "send" || props.maxLength === 2000);
}
function installInputCapture() {
    const TI = RN.TextInput;
    if (!TI || typeof TI.render !== "function")
        return;
    unpatches.push(before("render", TI, (args) => {
        try {
            const props = args[0];
            if (!props || !isChatInput(props))
                return;
            bridge.seen = Date.now();
            const original = props.onChangeText;
            bridge.change = typeof original === "function" ? original : null;
            if (typeof props.value === "string")
                bridge.text = props.value;
            args[0] = Object.assign({}, props, {
                onChangeText: (t) => {
                    bridge.text = t;
                    if (original)
                        original(t);
                },
            });
            const ref = args[1];
            let wrapped = ref && typeof ref === "object" ? refWrappers.get(ref) : null;
            if (!wrapped) {
                wrapped = (inst) => {
                    bridge.inst = inst;
                    if (typeof ref === "function")
                        ref(inst);
                    else if (ref && typeof ref === "object")
                        ref.current = inst;
                };
                if (ref && typeof ref === "object")
                    refWrappers.set(ref, wrapped);
            }
            args[1] = wrapped;
        }
        catch (_) { /* ignore */ }
    }));
}
function composerRef() {
    const channelId = currentChannelId();
    if (!channelId)
        return null;
    const api = safe(() => findByProps("getChatInputRef"), null);
    return safe(() => api?.getChatInputRef?.(channelId, 0), null);
}
function readInput() {
    if (Date.now() - bridge.seen < 600000 && String(bridge.text || "").trim())
        return String(bridge.text);
    const ref = composerRef();
    const value = safe(() => typeof ref?.getText === "function" ? ref.getText() :
        typeof ref?.getValue === "function" ? ref.getValue() :
            typeof ref?.text === "string" ? ref.text :
                typeof ref?.value === "string" ? ref.value :
                    typeof ref?.props?.value === "string" ? ref.props.value : "", "");
    return typeof value === "string" ? value : "";
}
function writeInput(text) {
    let ok = false;
    if (bridge.change) {
        try {
            bridge.change(text);
            ok = true;
        }
        catch (_) { /* ignore */ }
    }
    if (bridge.inst && typeof bridge.inst.setNativeProps === "function") {
        try {
            bridge.inst.setNativeProps({ text });
            ok = true;
        }
        catch (_) { /* ignore */ }
    }
    if (!ok) {
        const ref = composerRef();
        try {
            if (typeof ref?.setText === "function") {
                ref.setText(text);
                ok = true;
            }
            else if (typeof ref?.setValue === "function") {
                ref.setValue(text);
                ok = true;
            }
            else if (typeof ref?.setNativeProps === "function") {
                ref.setNativeProps({ text });
                ok = true;
            }
            else if (typeof ref?.clear === "function" && typeof ref?.insertText === "function") {
                ref.clear();
                ref.insertText(text);
                ok = true;
            }
        }
        catch (_) { /* use the captured TextInput bridge when available */ }
    }
    if (ok)
        bridge.text = text;
    return ok;
}
function translateCurrentText(tl, sl) {
    const text = readInput();
    if (!text.trim()) {
        toast("Type a message in the chat box first");
        return Promise.resolve(false);
    }
    if (!(bridge.change || bridge.inst || composerRef())) {
        toast("Discord could not access the message box; reopen the chat and try again");
        return Promise.resolve(false);
    }
    const channelId = currentChannelId();
    return translate(text, tl, sl, false, channelId).then(result => {
        if (result.same) {
            armed = null;
            notifyButton();
            toast("Already in " + langName(tl));
            return false;
        }
        if (writeInput(result.text)) {
            lastOriginal = text;
            lastOriginalChannelId = currentChannelId();
            toast("Translated with " + providerLabel(result.provider));
            return true;
        }
        else
            toast("Could not update the chat box; the original text is unchanged");
        return false;
    }).catch((error) => { toast("Translation failed: " + (error?.message || error)); return false; });
}
function restoreOriginal() {
    if (lastOriginal == null) {
        toast("Nothing to restore");
        return;
    }
    if (writeInput(lastOriginal)) {
        lastOriginal = null;
        lastOriginalChannelId = null;
    }
    else
        toast("Could not write to the chat box");
}
function patchSend() {
    const Messages = findByProps("sendMessage", "receiveMessage");
    if (!Messages)
        return;
    unpatches.push(instead("sendMessage", Messages, (args, orig) => {
        let pending = null;
        let oneShotJob = null;
        let oneShotTranslated = false;
        try {
            const msg = args[1];
            const job = qt.draftBeforeSend === false ? armed : null;
            if (job && msg && typeof msg.content === "string" && msg.content.trim()) {
                if (job.oneShot)
                    oneShotJob = job;
                else if (!qt.keepArmed) {
                    armed = null;
                    notifyButton();
                }
                pending = translate(msg.content, job.tl, job.sl, false, currentChannelId()).then(r => {
                    if (!r.same) {
                        args[1] = Object.assign({}, msg, { content: r.text });
                        toast("Translated with " + providerLabel(r.provider));
                        if (job.oneShot)
                            oneShotTranslated = true;
                    }
                });
            }
        }
        catch (_) {
            toast("Translation failed, sent the original message");
        }
        const send = () => {
            const msg = args[1];
            const clearRestore = () => {
                if (lastOriginal != null && msg && (String(args[0]) === String(lastOriginalChannelId || "") || currentChannelId() === lastOriginalChannelId)) {
                    lastOriginal = null;
                    lastOriginalChannelId = null;
                }
                bridge.text = "";
                if (oneShotJob && oneShotTranslated) {
                    armed = oneShotJob.resume || null;
                    notifyButton();
                }
            };
            const result = orig(...args);
            if (result && typeof result.then === "function")
                return result.then((value) => { clearRestore(); return value; });
            clearRestore();
            return result;
        };
        if (!pending)
            return send();
        return pending.catch(() => { toast("Translation failed, sent the original message"); }).then(send);
    }));
}
/* ------------------------------------------------------------------ */
/* translated messages in the chat                                     */
/* ------------------------------------------------------------------ */
function refreshRow(channelId, id) {
    const msg = getMessage(channelId, id);
    if (!msg)
        return;
    const guildId = safe(() => getChannel(channelId).guild_id, null);
    setTimeout(() => {
        try {
            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                guildId,
                message: { id, channel_id: channelId, guild_id: guildId, flags: (msg.flags | 0) ^ FLAG_TOGGLE },
            });
        }
        catch (_) { /* ignore */ }
    }, 0);
}
function translateMessage(message, tl, silent = false, immersiveOverride, autoIncoming = false, sourceOverride = "auto") {
    const text = message && message.content;
    if (typeof text !== "string" || !text.trim()) {
        if (!silent)
            toast("This message has no text");
        return Promise.resolve(false);
    }
    const channelId = message.channel_id || message.channelId || currentChannelId();
    if (!silent)
        toast("Translating...");
    return translate(text, tl, sourceOverride || "auto", true, channelId, message.id != null ? String(message.id) : null, autoIncoming).then(r => {
        if (r.same) {
            if (!silent)
                toast("Already in " + langName(tl));
            return true;
        }
        translations.set(String(message.id), { text: r.text, src: r.src, tl, at: Date.now(), ch: channelId, provider: r.provider || qt.provider || "google", immersive: immersiveOverride, autoIncoming });
        trimMap(translations, MAX_TRANSLATIONS);
        saveMessageTranslation(message, r, tl, String(channelId), autoIncoming, immersiveOverride);
        setTimeout(() => refreshRow(channelId, message.id), silent ? 220 : 0);
        if (!silent)
            toast("Translated with " + providerLabel(r.provider));
        return true;
    }).catch((e) => {
        if (!silent)
            toast("Translation failed: " + (e && e.message ? e.message : e));
        return false;
    });
}
function onIncomingMessage(event) {
    try {
        const state = useQuickTranslate.getState();
        const message = event?.message;
        const channelId = String(event?.channelId || message?.channel_id || "");
        if (!message?.id || !channelId || !message.content?.trim())
            return;
        if (message.type != null && message.type !== 0)
            return;
        const me = safe(() => UserStore.getCurrentUser?.()?.id || UserStore.getCurrentUserId?.(), null);
        if (me && String(message.author?.id) === String(me)) {
            const draftEntry = historyEntries.find(entry => !entry.messageId && entry.channelId === channelId && entry.translated === message.content && Date.now() - entry.at < 10 * 60 * 1000);
            if (draftEntry) {
                draftEntry.messageId = String(message.id);
                persistLocalData();
            }
            return;
        }
        if (!(state.autoChannelIds || []).map(String).includes(channelId))
            return;
        const target = state.targetIn || "en";
        if (autoSeen.has(String(message.id)))
            return;
        autoSeen.add(String(message.id));
        if (autoSeen.size > 500)
            autoSeen.delete(autoSeen.values().next().value);
        translateMessage(message, target, true, undefined, true);
    }
    catch (_) { /* incoming translation must never affect message delivery */ }
}
function messageArray(channelId) {
    const result = safe(() => MessageStore.getMessages(channelId), null);
    if (!result)
        return [];
    const value = safe(() => result.toArray(), null) || result._array || result.messages || result;
    return Array.isArray(value) ? value : [];
}
const BULK_PAGE_SIZE = 25;
function bulkMessageCandidates(request) {
    const seed = request?.seedMessage;
    const all = [...messageArray(request?.channelId), seed].filter((message) =>
        message?.id && typeof message.content === "string" && message.content.trim() &&
        (message.type == null || message.type === 0));
    const unique = new Map();
    for (const message of all)
        unique.set(String(message.id), message);
    return Array.from(unique.values()).sort((a, b) => String(b.id).localeCompare(String(a.id)));
}
function fetchBulkMessagePage(channelId, before) {
    const actions = safe(() => findByProps("fetchMessages"), null);
    if (typeof actions?.fetchMessages !== "function")
        return Promise.resolve(null);
    const options = { channelId: String(channelId), limit: BULK_PAGE_SIZE };
    if (before)
        options.before = String(before);
    return Promise.resolve().then(() => actions.fetchMessages(options)).then((result) => ({ ok: true, result }), () => null);
}
function openBulkSelection(message) {
    const channelId = String(message?.channel_id || message?.channelId || currentChannelId() || "");
    if (!channelId) {
        toast("Could not find this message’s channel");
        return;
    }
    bulkSelectionRequest = { channelId, seedMessage: message, nonce: ++bulkSelectionNonce };
    notifyButton();
}
function BulkMessageSelector(props) {
    const h = React.createElement;
    const C = palette();
    const [selected, setSelected] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const seed = props.request.seedMessage;
    const seedId = String(seed?.id || "");
    const visiblePageSize = seedId ? BULK_PAGE_SIZE - 1 : BULK_PAGE_SIZE;
    const initialMessages = bulkMessageCandidates(props.request);
    const initialPage = initialMessages.filter((m) => String(m.id) !== seedId).slice(0, visiblePageSize);
    const [messages, setMessages] = React.useState(seed ? [seed, ...initialPage] : initialPage);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(true);
    const loadLock = React.useRef(false);
    const cursor = React.useRef(initialPage[initialPage.length - 1]?.id || null);
    React.useEffect(() => {
        let active = true;
        setSelected(seedId ? [seedId] : []);
        setQuery("");
        setBusy(false);
        setLoadingMore(false);
        loadLock.current = false;
        const loaded = bulkMessageCandidates(props.request);
        const firstPage = loaded.filter((m) => String(m.id) !== seedId).slice(0, visiblePageSize);
        setMessages(seed ? [seed, ...firstPage] : firstPage);
        cursor.current = firstPage[firstPage.length - 1]?.id || null;
        setHasMore(true);
        if (firstPage.length >= visiblePageSize)
            return () => { active = false; };
        fetchBulkMessagePage(props.request.channelId, null).then((result) => {
            if (!active)
                return;
            const refreshed = bulkMessageCandidates(props.request);
            const page = refreshed.filter((m) => String(m.id) !== seedId).slice(0, visiblePageSize);
            setMessages(seed ? [seed, ...page] : page);
            cursor.current = page[page.length - 1]?.id || null;
            setHasMore(!!result && page.length >= visiblePageSize);
            if (!result)
                toast("Could not load the latest 25 messages; showing messages already loaded");
        });
        return () => { active = false; };
    }, [props.request.nonce]);
    const loadMore = async () => {
        if (loadLock.current || !hasMore)
            return;
        loadLock.current = true;
        setLoadingMore(true);
        const currentCursor = cursor.current;
        const currentIds = new Set(messages.map((m) => String(m.id)));
        const fetchResult = await fetchBulkMessagePage(props.request.channelId, currentCursor);
        const all = bulkMessageCandidates(props.request);
        const older = all.filter((m) => currentCursor && String(m.id) < String(currentCursor) && !currentIds.has(String(m.id)))
            .slice(0, BULK_PAGE_SIZE);
        if (older.length) {
            setMessages((current) => {
                const ids = new Set(current.map((m) => String(m.id)));
                return current.concat(older.filter((m) => !ids.has(String(m.id))));
            });
            cursor.current = older[older.length - 1].id;
            setHasMore(older.length >= BULK_PAGE_SIZE || !!fetchResult);
        } else {
            setHasMore(false);
            if (!fetchResult)
                toast("Could not load older messages");
        }
        setLoadingMore(false);
        loadLock.current = false;
    };
    const onListScroll = (event) => {
        const native = event?.nativeEvent || {};
        const layout = native.layoutMeasurement || {};
        const offset = native.contentOffset || {};
        const size = native.contentSize || {};
        if (Number(offset.y || 0) + Number(layout.height || 0) >= Number(size.height || 0) - 96)
            loadMore();
    };
    const q = query.trim().toLowerCase();
    const visible = messages.filter((m) => !q || String(m.content).toLowerCase().includes(q));
    const isAll = visible.length > 0 && visible.every((m) => selected.includes(String(m.id)));
    const toggle = (message) => {
        const id = String(message.id);
        setSelected((current) => current.includes(id) ? current.filter(x => x !== id) : current.concat(id));
    };
    const run = () => {
        const byId = new Map(messages.map((m) => [String(m.id), m]));
        const chosen = selected.map(id => byId.get(id)).filter(Boolean);
        if (!chosen.length) {
            toast("Select at least one message");
            return;
        }
        setBusy(true);
        props.onTranslate(chosen);
    };
    return h(RN.Modal, { visible: true, transparent: false, animationType: "none", onRequestClose: props.onClose, statusBarTranslucent: true },
        h(RN.View, { style: { flex: 1, backgroundColor: C.bg, paddingTop: 48, paddingHorizontal: 16, paddingBottom: 18 } },
            h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 14 } },
                h(RN.Pressable, { onPress: props.onClose, hitSlop: 10, style: { padding: 8, marginLeft: -8, marginRight: 8 } }, h(RN.Text, { style: { color: C.text, fontSize: 27 } }, "‹")),
                h(RN.View, { style: { flex: 1 } },
                    h(RN.Text, { style: { color: C.text, fontSize: 22, fontWeight: "800" } }, "Bulk translate"),
                    h(RN.Text, { style: { color: C.sub, fontSize: 13, marginTop: 2 } }, selected.length + " selected · " + messages.length + " loaded · newest first"))),
            h(CustomInput, { value: query, placeholder: "Search messages", onChangeText: setQuery, autoCorrect: false, style: { marginBottom: 10 } }),
            h(RN.View, { style: { flexDirection: "row", marginBottom: 10 } },
                h(RN.View, { style: { flex: 1, marginRight: 6 } }, h(CustomAction, { title: isAll ? "Deselect all" : "Select all", secondary: true, onPress: () => setSelected((current) => isAll ? current.filter(id => !visible.some((m) => String(m.id) === id)) : Array.from(new Set(current.concat(visible.map((m) => String(m.id)))))) })),
                h(RN.View, { style: { flex: 1, marginLeft: 6 } }, h(CustomAction, { title: "Clear selection", secondary: true, onPress: () => setSelected([]) }))),
            visible.length ? h(RN.ScrollView, { style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { paddingBottom: 12 }, onScroll: onListScroll, scrollEventThrottle: 180 },
                h(CustomSection, { title: "Messages" }, ...visible.map((message, index) => {
                    const id = String(message.id);
                    const marked = selected.includes(id);
                    const label = String(message.content).replace(/\s+/g, " ").trim();
                    const author = nameOf(message.author);
                    const translated = translations.get(id);
                    return h(CustomRow, { key: id, title: (id === seedId ? "Selected message · " : "") + author, subtitle: translated?.text ? label + "\n→ " + translated.text : label, last: index === visible.length - 1,
                        trailing: h(RN.View, { style: { width: 23, height: 23, borderRadius: 6, borderWidth: 1.5, borderColor: marked ? C.blurple : C.off, backgroundColor: marked ? C.blurple : "transparent", alignItems: "center", justifyContent: "center" } }, marked ? h(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" } }, "✓") : null),
                        onPress: () => toggle(message) });
                })),
                loadingMore ? h(RN.View, { style: { padding: 16, alignItems: "center" } }, h(RN.ActivityIndicator, { color: C.blurple }), h(RN.Text, { style: { color: C.sub, fontSize: 12, marginTop: 8 } }, "Loading 25 older messages…"))
                    : hasMore ? h(RN.Text, { style: { textAlign: "center", color: C.sub, fontSize: 12, padding: 16 } }, "Scroll down to load 25 older messages")
                    : h(RN.Text, { style: { textAlign: "center", color: C.sub, fontSize: 12, padding: 16 } }, "End of available messages"))
                : h(RN.View, { style: { flex: 1, alignItems: "center", justifyContent: "center" } }, h(RN.Text, { style: { color: C.sub } }, "No loaded messages match this search.")),
            h(CustomAction, { title: busy ? "Opening translation…" : "Continue to translation · " + selected.length, disabled: busy || !selected.length, onPress: run })));
}
function refreshTranslated() {
    translations.forEach((t, id) => { if (t.ch)
        refreshRow(t.ch, id); });
}
function showOriginal(message) {
    const channelId = message.channel_id || message.channelId || currentChannelId();
    translations.delete(String(message.id));
    refreshRow(channelId, message.id);
}
function paint(nodes, color) {
    if (!color)
        return nodes;
    return [{
            type: "link",
            target: "usernameOnClick",
            context: { username: "", usernameOnClick: { action: "0", userId: "0", linkColor: color, messageChannelId: "0" } },
            content: nodes.filter(n => n && INLINE.has(n.type)),
        }];
}
function stripOurs(nodes) {
    const out = [];
    for (const n of nodes) {
        if (n && n.__tr)
            continue;
        if (n && Array.isArray(n.content)) {
            const inner = stripOurs(n.content);
            if (!inner.length && n.content.length)
                continue;
            out.push(inner.length === n.content.length ? n : Object.assign({}, n, { content: inner }));
        }
        else
            out.push(n);
    }
    return out;
}
function translatedNodes(value) {
    const nodes = [];
    const emoji = /<(a?):([\w~]+):(\d+)>/g;
    let last = 0;
    let match;
    while ((match = emoji.exec(value))) {
        if (match.index > last)
            nodes.push({ type: "text", content: value.slice(last, match.index), __tr: true });
        const id = match[3];
        const webp = `https://cdn.discordapp.com/emojis/${id}.webp?size=128`;
        nodes.push({ type: "customEmoji", id, alt: match[2], src: match[1] ? webp.replace(".webp", ".gif") : webp, frozenSrc: webp });
        last = match.index + match[0].length;
    }
    if (last < value.length || !nodes.length)
        nodes.push({ type: "text", content: value.slice(last), __tr: true });
    return nodes;
}
let markdownParserLookupDone = false;
let markdownParserModule = null;
function parseLanguageSubtext(label) {
    try {
        if (!markdownParserLookupDone) {
            markdownParserLookupDone = true;
            markdownParserModule = findByProps("parse", "unparse") || findByProps("parse");
        }
        const parse = markdownParserModule && markdownParserModule.parse;
        if (typeof parse === "function") {
            const nodes = parse.call(markdownParserModule, "-# " + String(label || ""));
            const hasLiteralMarker = (node) => {
                if (typeof node === "string") return node.includes("-#");
                if (!node || typeof node !== "object") return false;
                return (typeof node.content === "string" && node.content.includes("-#")) ||
                    (Array.isArray(node.content) && node.content.some(hasLiteralMarker)) ||
                    (node.value && typeof node.value === "object" && hasLiteralMarker(node.value));
            };
            // Only trust a real block-level subtext result. A generic parser can
            // return ordinary text here, which silently loses the -# styling.
            if (Array.isArray(nodes) && nodes.length && !nodes.some(hasLiteralMarker) &&
                nodes.some(node => node && typeof node === "object" &&
                    (node.type === "subtext" || node.type === "small")))
                return nodes.map(node => node && typeof node === "object" ? { ...node, __tr: true } : { type: "text", content: String(node || ""), __tr: true });
        }
    } catch (_) {}
    // Discord's message AST uses a block-level subtext node for the -# format.
    // This keeps the label small even when the internal parser module is hidden.
    return [{ type: "subtext", content: [{ type: "text", content: String(label || ""), __tr: true }], __tr: true }];
}
function decorate(row, input) {
    const m = row && row.message;
    if (!m)
        return;
    const rowType = input && input.rowType !== undefined ? input.rowType : row.rowType;
    if (rowType !== 1)
        return;
    const tr = translations.get(String(m.id));
    const ours = m.__trOut && m.content === m.__trOut;
    if (!tr) {
        if (ours) {
            m.content = m.__trBaseRaw !== undefined ? m.__trBaseRaw : m.__trBase;
            delete m.__trBaseRaw;
            delete m.__trBase;
            delete m.__trOut;
        }
        else if (Array.isArray(m.content)) {
            const clean = stripOurs(m.content);
            if (clean.length !== m.content.length)
                m.content = clean;
        }
        return;
    }
    const originalContent = ours
        ? (m.__trBaseRaw !== undefined ? m.__trBaseRaw : m.__trBase)
        : m.content;
    const base = ours
        ? m.__trBase
        : Array.isArray(m.content)
            ? stripOurs(m.content)
            : (m.content == null || (typeof m.content === "string" && !m.content.trim()))
                ? []
                : typeof m.content === "string"
                    ? [{ type: "text", content: m.content }]
                    : null;
    if (!Array.isArray(base))
        return;
    const pc = RN.processColor;
    const color = pc ? pc(translationColor()) : null;
    const text = translatedNodes(tr.text);
    let out;
    const rawSource = String(tr.src || "").toLowerCase();
    const sourceCode = rawSource === "zh-cn" ? "zh-CN" : rawSource === "zh-tw" ? "zh-TW" : rawSource.split("-")[0];
    const sourceHint = qt.showSourceLanguage && sourceCode && sourceCode !== "auto"
        ? parseLanguageSubtext(langName(sourceCode) + " → " + langName(String(tr.tl || "")))
        : [];
    const immersive = tr.autoIncoming ? qt.autoIncomingImmersive : (tr.immersive ?? qt.immersive);
    const lineBreak = () => ({ type: "text", content: "\n", __tr: true });
    if (immersive)
        out = base.concat([lineBreak(), lineBreak()], sourceHint, paint(text, color));
    else
        out = sourceHint.concat(paint(text, color));
    if (!out.length)
        return;
    m.__trBaseRaw = originalContent;
    m.__trBase = base;
    m.__trOut = out;
    m.content = out;
}
function onRenderError() {
    renderErrors++;
    if (renderErrors >= 3 && renderUnpatch) {
        try {
            renderUnpatch();
        }
        catch (_) { /* ignore */ }
        renderUnpatch = null;
        toast("Quick Translate: message styling disabled after repeated errors");
    }
}
function patchRender() {
    const RowManager = safe(() => findByName("RowManager"), null);
    if (!RowManager || !RowManager.prototype || typeof RowManager.prototype.generate !== "function") {
        toast("Quick Translate: could not find the message renderer");
        return;
    }
    renderUnpatch = after("generate", RowManager.prototype, (args, ret) => {
        try {
            decorate(ret, args[0]);
        }
        catch (_) {
            onRenderError();
        }
    });
}
/* ------------------------------------------------------------------ */
/* message long-press menu                                             */
/* ------------------------------------------------------------------ */
function messageContentText(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    const parts = [];
    const visit = (node) => {
        if (typeof node === "string") { parts.push(node); return; }
        if (!node || typeof node !== "object") return;
        if (typeof node.content === "string") parts.push(node.content);
        else if (Array.isArray(node.content)) node.content.forEach(visit);
        if (node.type === "customEmoji" && node.name) parts.push(":" + node.name + ":");
    };
    value.forEach(visit);
    return parts.join("");
}
function messagePlan(message) {
    if (!message || !message.id) return null;
    const text = messageContentText(message.__trBase || message.content);
    if (!text.trim()) return null;
    const actionMessage = typeof message.content === "string" ? message : { ...message, content: text };
    const plan = [];
    if (translations.has(String(message.id))) {
        plan.push({ key: "qt-original", label: "Show original message", press: () => showOriginal(actionMessage) });
    }
    else {
        plan.push({ key: "qt-translate", label: "Translate to " + langName(qt.targetIn), press: () => translateMessage(actionMessage, qt.targetIn, false, undefined, false, "auto") });
    }
    const channelId = String(message.channel_id || message.channelId || currentChannelId() || "");
    if (channelId)
        plan.push({ key: "qt-select-messages", label: "Bulk translate…", press: () => openBulkSelection(actionMessage) });
    plan.push({
        key: "qt-translate-to",
        label: "Translate to...",
        press: () => openMessageTranslationPanel(actionMessage, qt.targetIn),
    });
    const translated = translations.get(String(message.id));
    if (translated?.text)
        plan.push({ key: "qt-copy-translation", label: "Copy translation", press: () => copyText(translated.text) });
    return plan;
}
function openMessageTranslationPanel(message, target) {
    const text = typeof message?.content === "string" ? message.content : messageContentText(message?.content);
    if (!text.trim()) {
        toast("This message has no text to translate");
        return false;
    }
    pendingMessageRequest = {
        nonce: ++messageRequestNonce,
        message: { ...message, content: text },
        target: target || qt.targetIn || "en",
        source: "auto",
    };
    notifyButton();
    return true;
}
function openBulkTranslationPanel(messages, target) {
    const cleanMessages = (Array.isArray(messages) ? messages : []).map((message) => {
        const text = typeof message?.content === "string" ? message.content : messageContentText(message?.content);
        return text.trim() ? { ...message, content: text } : null;
    }).filter(Boolean);
    if (!cleanMessages.length) {
        toast("No selected messages contain translatable text");
        return false;
    }
    pendingMessageRequest = {
        nonce: ++messageRequestNonce,
        messages: cleanMessages,
        target: target || qt.targetIn || "en",
        source: "auto",
    };
    notifyButton();
    return true;
}
function installTextBridge() {
    const root = globalThis;
    const api = {
        isActive: () => pluginStarted,
        getMessageActions: (message) => {
            if (!pluginStarted)
                return [];
            const plan = messagePlan(message);
            return plan ? plan.filter(item => item.key !== "qt-select-messages") : [];
        },
        getMessageTranslation: (messageId) => {
            const result = translations.get(String(messageId));
            if (!result || !result.text)
                return null;
            const sourceCode = String(result.src || "").toLowerCase();
            const source = sourceCode === "zh-cn" ? "zh-CN" : sourceCode === "zh-tw" ? "zh-TW" : sourceCode.split("-")[0];
            const target = String(result.tl || "").toLowerCase();
            const sourceLabel = qt.showSourceLanguage && source && source !== "auto"
                ? langName(source) + " → " + langName(target)
                : "";
            return {
                text: result.text,
                color: translationColor(),
                immersive: result.autoIncoming ? qt.autoIncomingImmersive : (result.immersive ?? qt.immersive),
                sourceLabel,
            };
        },
    };
    pluginStarted = true;
    root[QT_TEXT_BRIDGE_KEY] = api;
    unpatches.push(() => {
        pluginStarted = false;
        if (root[QT_TEXT_BRIDGE_KEY] === api)
            delete root[QT_TEXT_BRIDGE_KEY];
    });
}
function hideLanguageSheet() {
    try {
        findByProps("openLazy", "hideActionSheet").hideActionSheet();
    }
    catch (_) { /* ignore */ }
}
function showLanguagePicker(title, onSelect) {
    const sheets = safe(() => findByProps("showSimpleActionSheet"), null);
    if (!sheets || typeof sheets.showSimpleActionSheet !== "function") {
        toast("Could not open the language list");
        return;
    }
    const favorites = (qt.favLangs || []).filter((code) => LANG_NAME.has(code));
    const showSheet = (languages, key, includeMore) => {
        const options = languages.map(([code, name]) => ({
            label: name,
            onPress: () => {
                hideLanguageSheet();
                onSelect(code);
            },
        }));
        if (includeMore)
            options.push({
                label: "Show more",
                onPress: () => {
                    hideLanguageSheet();
                    setTimeout(() => showSheet(LANGS, key + "All", false), 300);
                },
            });
        sheets.showSimpleActionSheet({ key, header: { title }, options });
    };
    const favoriteLanguages = favorites.map((code) => [code, langName(code)]);
    setTimeout(() => showSheet(favorites.length ? favoriteLanguages : LANGS, "QTTranslateTo", favorites.length > 0), 300);
}
function addRows(tree, plan, lazySheet) {
    const container = findInReactTree(tree, (x) => Array.isArray(x) && x[0]?.type?.name === "ActionSheetRowGroup");
    if (!container || !container[1]) {
        console.log("[QuickTranslate] could not find the action sheet group");
        return;
    }
    const group = container[1];
    const children = group.props?.children;
    if (!Array.isArray(children) || !children[0])
        return;
    if (children.some((c) => typeof c?.key === "string" && c.key.startsWith("qt-")))
        return;
    const tpl = children[0];
    const Row = tpl.type;
    const iconId = findAssetId("LanguageIcon");
    const tplIcon = tpl.props?.icon;
    const icon = tplIcon
        ? {
            $$typeof: tplIcon.$$typeof,
            type: tplIcon.type,
            key: null,
            ref: null,
            props: {
                IconComponent: () => React.createElement(RN.Image, {
                    resizeMode: "cover",
                    style: { width: 24, height: 24, tintColor: palette().text },
                    source: iconId,
                }),
            },
        }
        : undefined;
    const rows = plan.map(item => React.createElement(Row, {
        key: item.key,
        label: item.label,
        icon,
        onPress: () => {
            try {
                lazySheet.hideActionSheet();
            }
            catch (_) { /* ignore */ }
            item.press();
        },
    }));
    const copyIndex = children.findIndex((c) => c?.props?.label?.toUpperCase?.()?.includes("COPY") || c?.props?.message?.toUpperCase?.()?.includes("COPY"));
    if (copyIndex !== -1)
        children.splice(copyIndex, 0, ...rows);
    else
        children.push(...rows);
}
function patchActionSheet() {
    const lazySheet = findByProps("openLazy", "hideActionSheet");
    if (!lazySheet)
        return;
    unpatches.push(before("openLazy", lazySheet, ([component, key, ctx]) => {
        try {
            if (key !== "MessageLongPressActionSheet" || !component || typeof component.then !== "function")
                return;
            const plan = messagePlan(ctx && ctx.message);
            if (!plan)
                return;
            component.then((instance) => {
                const un = after("default", instance, (_, tree) => {
                    React.useEffect(() => () => { un(); }, []);
                    try {
                        addRows(tree, plan, lazySheet);
                    }
                    catch (e) {
                        console.error(e);
                    }
                });
            });
        }
        catch (_) { /* ignore */ }
    }));
}
/* ------------------------------------------------------------------ */
/* chat bar button                                                     */
/* ------------------------------------------------------------------ */
function TranslateButton(props) {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const [busy, setBusy] = React.useState(false);
    const [panelOpen, setPanelOpen] = React.useState(false);
    const [panelPage, setPanelPage] = React.useState("main");
    const [source, setSource] = React.useState(getChatLanguages().sourceOut || "auto");
    const [target, setTarget] = React.useState(getChatLanguages().targetOut || "en");
    const [query, setQuery] = React.useState("");
    const [messageRequest, setMessageRequest] = React.useState(null);
    const seenMessageRequest = React.useRef(0);
    const didLongPress = React.useRef(false);
    const pressTimer = React.useRef(null);
    const sheetProgress = React.useRef(new RN.Animated.Value(0)).current;
    const backdropProgress = React.useRef(new RN.Animated.Value(0)).current;
    const closingPanel = React.useRef(false);
    const buttonScale = React.useRef(new RN.Animated.Value(1)).current;
    const [, tick] = React.useState(0);
    React.useEffect(() => {
        const f = () => {
            tick((x) => x + 1);
            const request = pendingMessageRequest;
            const anchor = useQuickTranslate.getState()?.anchor;
            const panelHostPosition = anchor === "send" ? "send" : "actions";
            if (props.position !== panelHostPosition || !request || request.nonce === seenMessageRequest.current)
                return;
            seenMessageRequest.current = request.nonce;
            setMessageRequest(request);
            setSource(request.source || "auto");
            setTarget(request.target || qt.targetIn || "en");
            setQuery("");
            setPanelPage("main");
            closingPanel.current = false;
            setPanelOpen(true);
        };
        buttonListeners.add(f);
        return () => { buttonListeners.delete(f); if (pressTimer.current)
            clearTimeout(pressTimer.current); };
    }, []);
    React.useEffect(() => {
        if (!panelOpen)
            return;
        closingPanel.current = false;
        sheetProgress.setValue(0);
        backdropProgress.setValue(0);
        RN.Animated.parallel([
            RN.Animated.timing(sheetProgress, { toValue: 1, duration: 260, easing: RN.Easing.out(RN.Easing.cubic), useNativeDriver: true }),
            RN.Animated.timing(backdropProgress, { toValue: 1, duration: 220, useNativeDriver: true }),
        ]).start();
    }, [panelOpen]);
    if (settings.showButton === false && !messageRequest)
        return null;
    if (props.position === "actions" && settings.anchor !== "actions")
        return null;
    if (props.position === "send" && settings.anchor !== "send" && !(armed && settings.draftBeforeSend !== false))
        return null;
    const run = (tl, sl) => {
        if (busy)
            return Promise.resolve(false);
        setBusy(true);
        let p;
        try {
            p = translateCurrentText(tl, sl);
        }
        catch (_) {
            p = Promise.resolve(false);
        }
        return p.then((ok) => { setBusy(false); return ok; }, () => { setBusy(false); return false; });
    };
    const iconId = findAssetId("LanguageIcon");
    const C = palette();
    const translateSendMode = props.position === "send" && !!armed && settings.draftBeforeSend !== false;
    const highlightedTranslate = translateSendMode && settings.highlightDraftButton !== false;
    const icon = iconId
        ? h(RN.Image, { source: iconId, style: { width: translateSendMode ? 20 : 22, height: translateSendMode ? 20 : 22, tintColor: highlightedTranslate ? "#FFFFFF" : armed ? ACCENT : C.sub } })
        : h(RN.Text, { style: { fontSize: 20, textAlign: "center", color: highlightedTranslate ? "#FFFFFF" : armed ? ACCENT : C.sub } }, "\uD83C\uDF10");
    const onPress = () => {
        if (didLongPress.current) {
            didLongPress.current = false;
            return;
        }
        if (armed && props.position === "send" && settings.draftBeforeSend !== false) {
            const job = armed;
            run(job.tl, job.sl).then(ok => {
                if (ok) {
                    armed = job.oneShot ? (job.resume || null) : null;
                    notifyButton();
                }
            });
            return;
        }
        if (armed) {
            armed = null;
            notifyButton();
            toast("Translation turned off");
            return;
        }
        const preferences = getChatLanguages();
        armed = { tl: preferences.targetOut || "en", sl: preferences.sourceOut || "auto" };
        notifyButton();
        toast(settings.keepArmed
            ? "Translation is active until you turn it off"
            : "Translation will apply to your next message");
    };
    const openPanel = () => {
        didLongPress.current = true;
        const preferences = getChatLanguages();
        setSource(preferences.sourceOut || "auto");
        setTarget(preferences.targetOut || "en");
        setQuery("");
        setPanelPage("main");
        closingPanel.current = false;
        setPanelOpen(true);
    };
    const startPress = () => {
        didLongPress.current = false;
        RN.Animated.timing(buttonScale, { toValue: 0.92, duration: 75, useNativeDriver: true }).start();
        if (pressTimer.current)
            clearTimeout(pressTimer.current);
        pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            openPanel();
        }, 450);
    };
    const finishPress = () => {
        RN.Animated.spring(buttonScale, { toValue: 1, speed: 24, bounciness: 4, useNativeDriver: true }).start();
        if (pressTimer.current) {
            clearTimeout(pressTimer.current);
            pressTimer.current = null;
        }
        if (!didLongPress.current)
            onPress();
        didLongPress.current = false;
    };
    const cancelPress = () => {
        RN.Animated.spring(buttonScale, { toValue: 1, speed: 24, bounciness: 4, useNativeDriver: true }).start();
        if (pressTimer.current)
            clearTimeout(pressTimer.current);
        pressTimer.current = null;
        didLongPress.current = false;
    };
    const closePanel = () => {
        if (closingPanel.current)
            return;
        closingPanel.current = true;
        RN.Animated.parallel([
            RN.Animated.timing(sheetProgress, { toValue: 0, duration: 220, easing: RN.Easing.in(RN.Easing.cubic), useNativeDriver: true }),
            RN.Animated.timing(backdropProgress, { toValue: 0, duration: 180, useNativeDriver: true }),
        ]).start(({ finished }) => {
            if (finished) {
                setPanelOpen(false);
                setPanelPage("main");
                setQuery("");
                if (messageRequest && pendingMessageRequest?.nonce === messageRequest.nonce)
                    pendingMessageRequest = null;
                setMessageRequest(null);
            }
            closingPanel.current = false;
        });
    };
    const sheetTravel = Math.max(600, safe(() => RN.Dimensions.get("window").height, 800));
    const sheetPanResponder = React.useRef(null);
    if (!sheetPanResponder.current) {
        sheetPanResponder.current = RN.PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.15,
            onMoveShouldSetPanResponderCapture: (_, gesture) => gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.15,
            onShouldBlockNativeResponder: () => true,
            onPanResponderMove: (_, gesture) => {
                const progress = Math.max(0, Math.min(1, 1 - Math.max(0, gesture.dy) / sheetTravel));
                sheetProgress.setValue(progress);
                backdropProgress.setValue(progress);
            },
            onPanResponderRelease: (_, gesture) => {
                if (gesture.dy > Math.max(72, sheetTravel * 0.10) || gesture.vy > 0.5) {
                    closePanel();
                    return;
                }
                RN.Animated.parallel([
                    RN.Animated.spring(sheetProgress, { toValue: 1, speed: 20, bounciness: 0, useNativeDriver: true }),
                    RN.Animated.timing(backdropProgress, { toValue: 1, duration: 140, useNativeDriver: true }),
                ]).start();
            },
            onPanResponderTerminate: () => {
                RN.Animated.parallel([
                    RN.Animated.spring(sheetProgress, { toValue: 1, speed: 20, bounciness: 0, useNativeDriver: true }),
                    RN.Animated.timing(backdropProgress, { toValue: 1, duration: 140, useNativeDriver: true }),
                ]).start();
            },
            onPanResponderTerminationRequest: () => false,
        });
    }
    const favorites = (settings.favLangs || []).filter((code) => LANG_NAME.has(code));
    const paletteNow = palette();
    const sourceLanguages = [["auto", "Auto-detect"], ...LANGS];
    const selectTargetLanguage = (code) => {
        setTarget(code);
    };
    const confirmTargetLanguage = () => {
        setPanelPage("main");
        setQuery("");
    };
    const activateOnce = () => {
        if (messageRequest) {
            setBusy(true);
            const selectedMessages = Array.isArray(messageRequest.messages) ? messageRequest.messages : [messageRequest.message].filter(Boolean);
            if (selectedMessages.length > 1) {
                (async () => {
                    let translatedCount = 0;
                    let alreadyCount = 0;
                    let failedCount = 0;
                    const serviceCounts = { deepl: 0, google: 0 };
                    for (const item of selectedMessages) {
                        const id = String(item?.id || "");
                        const previous = translations.get(id);
                        const ok = await translateMessage(item, target, true, undefined, false, source);
                        const current = translations.get(id);
                        if (!ok)
                            failedCount++;
                        else if (current && current !== previous) {
                            translatedCount++;
                            serviceCounts[current.provider === "deepl" ? "deepl" : "google"]++;
                        }
                        else
                            alreadyCount++;
                    }
                    setBusy(false);
                    const services = [];
                    if (serviceCounts.google) services.push(serviceCounts.google + " Google Translate");
                    if (serviceCounts.deepl) services.push(serviceCounts.deepl + " DeepL");
                    toast(translatedCount + " translated" + (services.length ? " · " + services.join(" · ") : "") + " · " + alreadyCount + " already in " + langName(target) + " · " + failedCount + " failed");
                    closePanel();
                })();
                return;
            }
            const item = selectedMessages[0];
            const messageId = String(item?.id || "");
            const previousTranslationAt = translations.get(messageId)?.at;
            translateMessage(item, target, false, undefined, false, source).then((ok) => {
                setBusy(false);
                const result = translations.get(messageId);
                const translatedText = String(result?.text || "").trim();
                const originalText = String(item?.content || "").trim();
                if (ok && result && result.at !== previousTranslationAt && translatedText && translatedText !== originalText)
                    closePanel();
            });
            return;
        }
        const resume = armed?.oneShot ? armed.resume || null : armed;
        armed = { tl: target, sl: source, oneShot: true, resume };
        notifyButton();
        closePanel();
        toast("Translate once is ready. Translate the draft to " + langName(target) + "; your usual language will return after.");
    };
    const setPermanentLanguage = () => {
        const channelId = currentChannelId();
        saveChatLanguages(channelId, { targetOut: target });
        if (armed?.oneShot)
            armed = { ...armed, resume: { tl: target, sl: source } };
        else if (armed)
            armed = { tl: target, sl: source };
        notifyButton();
        closePanel();
        toast(langName(target) + " is now the usual language for this chat");
    };
    const languageOptions = (panelPage === "source" ? sourceLanguages : LANGS)
        .filter(([code, name]) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase()) || code.toLowerCase().includes(query.trim().toLowerCase()));
    const panelBody = panelPage === "main"
        ? [
            h(RN.Text, { key: "title", style: { color: paletteNow.text, fontSize: 22, fontWeight: "700", marginBottom: 4 } }, messageRequest ? (messageRequest.messages?.length > 1 ? "Translate messages" : "Translate message") : "Translate draft"),
            h(RN.Text, { key: "hint", style: { color: paletteNow.sub, fontSize: 14, marginBottom: 16 } }, messageRequest ? (messageRequest.messages?.length > 1 ? "Choose languages, then translate " + messageRequest.messages.length + " selected messages once." : "Choose languages, then translate this message once.") : "Translate this draft once. Your chat’s default language stays unchanged."),
            h(CustomSection, { key: "languages", title: "Languages", compact: true }, h(CustomRow, { title: "Translate from", subtitle: languageLabel(source), icon: "↗", onPress: () => { setQuery(""); setPanelPage("source"); }, trailing: h(RN.Text, { style: { color: paletteNow.sub, fontSize: 20 } }, "›") }), h(CustomRow, { title: "Translate to", subtitle: languageLabel(target), icon: "↙", last: true, onPress: () => { setQuery(""); setPanelPage("target"); }, trailing: h(RN.Text, { style: { color: paletteNow.sub, fontSize: 20 } }, "›") })),
            favorites.length ? h(RN.View, { key: "favorites", style: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: 8, marginBottom: 4 } }, ...favorites.map((code) => h(RN.Pressable, {
                key: code,
                onPress: () => selectTargetLanguage(code),
                accessibilityRole: "button",
                accessibilityLabel: "Translate to " + langName(code),
                accessibilityState: { selected: code === target },
                style: { minHeight: 40, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 20, marginRight: 7, marginBottom: 7, alignItems: "center", justifyContent: "center", backgroundColor: code === target ? paletteNow.blurple : paletteNow.chip },
            }, h(RN.Text, { numberOfLines: 1, adjustsFontSizeToFit: true, style: { color: paletteNow.text, fontSize: 13, fontWeight: "600" } }, languageLabel(code))))) : null,
            h(CustomSection, { key: "once-section", title: "Translate once", compact: true }, h(RN.Text, { style: { color: paletteNow.sub, fontSize: 12, lineHeight: 16, paddingHorizontal: 14, paddingTop: 4 } }, messageRequest ? (messageRequest.messages?.length > 1 ? "Translate the selected messages with your chosen service and language." : "Translate this message with your selected service and language.") : "Arms the Translate button for one draft. After it translates, your usual language is restored."), h(RN.View, { style: { paddingHorizontal: 12, paddingBottom: 8 } }, h(CustomAction, { title: busy ? "Translating…" : (messageRequest ? "Translate once · " : "Activate once · ") + langName(target), disabled: busy, onPress: activateOnce }))),
            !messageRequest ? h(CustomSection, { key: "permanent-section", title: "Permanent language", compact: true }, h(RN.Text, { style: { color: paletteNow.sub, fontSize: 12, lineHeight: 16, paddingHorizontal: 14, paddingTop: 4 } }, "Changes the usual target for this chat until you choose another language."), h(RN.View, { style: { paddingHorizontal: 12, paddingBottom: 8 } }, h(CustomAction, { title: "Set " + langName(target) + " as usual", secondary: true, onPress: setPermanentLanguage }))) : null,
            !messageRequest && lastOriginal != null ? h(CustomAction, { key: "restore", title: "Restore original text", secondary: true, onPress: () => { closePanel(); restoreOriginal(); } }) : null,
            !messageRequest && armed ? h(CustomAction, { key: "disable", title: "Turn off Translate", secondary: true, onPress: () => { armed = null; notifyButton(); closePanel(); } }) : null,
            
        ]
        : [
            h(CustomAction, { key: "back", title: "‹  Back", secondary: true, onPress: () => { setPanelPage("main"); setQuery(""); } }),
            h(CustomInput, { key: "search", style: { marginVertical: 12 }, value: query, placeholder: "Search language", onChangeText: setQuery, autoCorrect: false }),
            h(RN.ScrollView, { key: "list", style: { maxHeight: 360 }, keyboardShouldPersistTaps: "handled" }, h(CustomSection, { title: panelPage === "source" ? "Translate from" : "Translate to" }, ...languageOptions.map(([code, label], index) => h(CustomRow, { key: code, title: languageLabel(code, label), subtitle: code,
                trailing: (panelPage === "source" ? source : target) === code ? h(RN.Text, { style: { color: paletteNow.blurple, fontWeight: "700" } }, "✓") : null,
                last: index === languageOptions.length - 1,
                onPress: () => {
                    if (panelPage === "source") {
                        setSource(code);
                        saveChatLanguages(currentChannelId(), { sourceOut: code });
                    }
                    else {
                        selectTargetLanguage(code);
                        return;
                    }
                    setPanelPage("main");
                    setQuery("");
                } })))),
            panelPage === "target" ? h(CustomAction, { key: "confirm-target", title: "Confirm " + langName(target), onPress: confirmTargetLanguage }) : null,
        ];
    const look = sendButtonLook || {};
    const dim = translateSendMode
        ? { w: Number(look.width) || 36, h: Number(look.height) || 36, r: look.borderRadius != null ? look.borderRadius : 10, bg: look.backgroundColor || paletteNow.blurple, mr: 0, mv: 0 }
        : { w: 32, h: 32, r: 10, bg: paletteNow.blurple, mr: 0, ml: 5, mv: 0 };
    return h(RN.View, { pointerEvents: "box-none", collapsable: false, style: { width: dim.w, height: dim.h, marginRight: dim.mr, marginLeft: dim.ml || 0, marginVertical: dim.mv, alignSelf: "flex-end", flexShrink: 0 } }, h(RN.Animated.View, {
        onStartShouldSetResponder: () => !busy,
        onResponderTerminationRequest: () => false,
        onResponderGrant: startPress,
        onResponderRelease: finishPress,
        onResponderTerminate: cancelPress,
        hitSlop: 2,
        pressRetentionOffset: { top: 4, bottom: 4, left: 4, right: 4 },
        pointerEvents: "auto",
        collapsable: false,
        accessibilityRole: "button",
        accessibilityLabel: translateSendMode ? "Translate draft" : "Translate message",
        accessibilityHint: "Tap to activate or translate the draft; hold for language and draft options",
        accessibilityActions: [{ name: "activate", label: "Translate" }],
        onAccessibilityTap: onPress,
        style: { width: dim.w, height: dim.h, borderRadius: dim.r, backgroundColor: highlightedTranslate ? dim.bg : "transparent", alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1, transform: [{ scale: buttonScale }] },
    }, icon), panelOpen ? h(RN.Modal, { visible: true, transparent: true, animationType: "none", onRequestClose: closePanel }, h(RN.View, { style: { flex: 1, justifyContent: "flex-end" } }, h(RN.Animated.View, { pointerEvents: "box-none", style: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.52)", opacity: backdropProgress } }, h(RN.Pressable, { style: { flex: 1 }, onPress: closePanel })), h(RN.Animated.View, {
        style: { maxHeight: "88%", backgroundColor: paletteNow.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28,
            transform: [{ translateY: sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [sheetTravel, 0] }) }] },
    }, h(RN.View, { ...sheetPanResponder.panHandlers, accessibilityLabel: "Drag down to close translate menu", accessibilityHint: "Swipe down to dismiss", style: { height: 44, marginBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "center" } }, h(RN.View, { style: { width: 72, height: 44, alignItems: "center", justifyContent: "center" } }, h(RN.View, { style: { width: 38, height: 5, borderRadius: 3, backgroundColor: paletteNow.off } })), h(RN.Pressable, { onPress: closePanel, accessibilityRole: "button", accessibilityLabel: "Close translate menu", hitSlop: 10, style: { position: "absolute", top: 0, right: 0, width: 38, height: 38, borderRadius: 19, backgroundColor: paletteNow.chip, alignItems: "center", justifyContent: "center" } }, h(RN.Text, { style: { color: paletteNow.text, fontSize: 24, lineHeight: 28, fontWeight: "500" } }, String.fromCharCode(215)))), panelPage === "main" ? h(RN.ScrollView, { keyboardShouldPersistTaps: "handled", showsVerticalScrollIndicator: false, style: { flexShrink: 1 }, contentContainerStyle: { paddingBottom: 8 } }, ...panelBody) : h(RN.ScrollView, { keyboardShouldPersistTaps: "handled" }, ...panelBody)))) : null, bulkSelectionRequest ? h(BulkMessageSelector, { key: bulkSelectionRequest.nonce, request: bulkSelectionRequest, onClose: () => { bulkSelectionRequest = null; notifyButton(); }, onTranslate: (messages) => { bulkSelectionRequest = null; openBulkTranslationPanel(messages, qt.targetIn || "en"); } }) : null);
}
let sendButtonLook = null;
function readButtonLook(node, depth) {
    if (!node || typeof node !== "object" || depth > 4)
        return null;
    try {
        const props = node.props;
        if (props && props.style && typeof props.style !== "function") {
            const flat = RN.StyleSheet.flatten(props.style);
            if (flat && flat.backgroundColor && (flat.width || flat.height) && flat.borderRadius != null)
                return flat;
        }
        const kids = props && props.children;
        for (const kid of Array.isArray(kids) ? kids : kids ? [kids] : []) {
            const found = readButtonLook(kid, depth + 1);
            if (found)
                return found;
        }
    }
    catch (_) { /* ignore */ }
    return null;
}
function patchChatButton() {
    const h = React.createElement;
    const actions = findByTypeDisplayName("ChatInputActions");
    const rightActions = findByTypeDisplayName("ChatInputRightActions");
    const sendButton = findByTypeDisplayName("ChatInputSendButton");
    for (const component of [actions, rightActions]) {
        if (!component?.type)
            continue;
        unpatches.push(before("render", component.type, ([props]) => {
            if (!props || !qt.hideGiftButton)
                return;
            props.shouldShowGiftButton = false;
        }));
    }
    if (actions?.type)
        unpatches.push(after("render", actions.type, (_, ret) => {
            if (!ret)
                return ret;
            return h(RN.View, { pointerEvents: "box-none", collapsable: false, style: { flexDirection: "row", alignItems: "center", overflow: "visible" } }, ret, h(TranslateButton, { key: "qt-button-actions", position: "actions" }));
        }));
    if (sendButton?.type)
        unpatches.push(after("render", sendButton.type, (_, ret) => {
            if (!ret)
                return ret;
            try {
                const look = readButtonLook(ret, 0);
                if (look)
                    sendButtonLook = look;
            }
            catch (_) { /* ignore */ }
            return h(ComposerSendSlot, { button: h(TranslateButton, { key: "qt-button-send", position: "send" }), children: ret });
        }));
}
function ComposerSendSlot(props) {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const [active, setActive] = React.useState(!!armed);
    React.useEffect(() => {
        const refresh = () => setActive(!!armed);
        buttonListeners.add(refresh);
        return () => { buttonListeners.delete(refresh); };
    }, []);
    const replaceSend = active && settings.showButton !== false && settings.draftBeforeSend !== false;
    const showTranslate = settings.anchor === "send" || replaceSend;
    if (!showTranslate)
        return props.children;
    if (replaceSend)
        return h(RN.View, { pointerEvents: "box-none", collapsable: false, style: { position: "relative", alignItems: "flex-end", justifyContent: "flex-end", alignSelf: "flex-end" } }, h(RN.View, { pointerEvents: "none", accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants", style: { opacity: 0 } }, props.children), h(RN.View, { pointerEvents: "box-none", style: { position: "absolute", bottom: 0, right: 0, alignItems: "flex-end", justifyContent: "flex-end" } }, props.button));
    return h(RN.View, { pointerEvents: "box-none", style: { flexDirection: "row", alignItems: "flex-end", alignSelf: "flex-end" } }, props.button, props.children);
}
function LangPicker(props) {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const navigation = NavigationNative.useNavigation();
    const [query, setQuery] = React.useState("");
    const q = query.trim().toLowerCase();
    const base = props.field === "sourceOut" ? [["auto", "Auto-detect"], ...LANGS] : LANGS;
    const list = base.filter(([code, name]) => !q || name.toLowerCase().includes(q) || code.toLowerCase().includes(q));
    const choose = (code) => {
        updateQuickTranslateSettings({ [props.field]: code });
        navigation.goBack();
    };
    return h(RN.ScrollView, { style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 40 } }, h(CustomInput, { value: query, placeholder: "Search language", onChangeText: setQuery, autoCorrect: false, style: { marginBottom: 18 } }), h(CustomSection, { title: "Languages" }, ...list.map(([code, label], index) => h(CustomRow, { key: code, title: languageLabel(code, label), subtitle: code, last: index === list.length - 1,
        trailing: settings[props.field] === code ? h(RN.Text, { style: { color: palette().blurple, fontWeight: "700", fontSize: 18 } }, "✓") : null,
        onPress: () => choose(code) }))));
}
function FavPicker() {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const [query, setQuery] = React.useState("");
    const q = query.trim().toLowerCase();
    const favs = settings.favLangs || [];
    const list = LANGS.filter(([c, n]) => !q || n.toLowerCase().includes(q) || c.toLowerCase().includes(q));
    return h(RN.ScrollView, { style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 40 } }, h(CustomInput, { value: query, placeholder: "Search language", onChangeText: setQuery, autoCorrect: false, style: { marginBottom: 18 } }), h(RN.Text, { style: { color: palette().sub, marginBottom: 12, fontSize: 14 } }, favs.length + " of " + MAX_FAVS + " quick languages selected"), h(CustomSection, { title: "Choose quick languages" }, ...list.map(([code, label], index) => {
        const on = favs.includes(code);
        return h(CustomRow, { key: code, title: languageLabel(code, label), subtitle: code, last: index === list.length - 1,
            trailing: h(RN.View, { style: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, borderColor: on ? palette().blurple : palette().off, backgroundColor: on ? palette().blurple : "transparent", alignItems: "center", justifyContent: "center" } }, on ? h(RN.Text, { style: { color: "#FFFFFF", fontWeight: "800" } }, "✓") : null),
            onPress: () => {
                if (on)
                    updateQuickTranslateSettings({ favLangs: favs.filter(x => x !== code) });
                else if (favs.length < MAX_FAVS)
                    updateQuickTranslateSettings({ favLangs: favs.concat([code]) });
                else
                    toast("You can pick up to " + MAX_FAVS);
            } });
    })));
}
function ColorPicker() {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const navigation = NavigationNative.useNavigation();
    const colors = palette();
    const current = translationColor();
    const select = (hex) => { updateQuickTranslateSettings({ translationColor: hex }); refreshTranslated(); navigation.goBack(); };
    return h(RN.ScrollView,{style:{flex:1},contentContainerStyle:{padding:16,paddingBottom:40}},
      h(RN.Text,{style:{color:colors.text,fontSize:20,fontWeight:"700",marginBottom:6}},"Translation color"),
      h(RN.Text,{style:{color:colors.sub,fontSize:14,marginBottom:8}},"Choose a color preset. Your choice saves automatically."),
      h(RN.Text,{style:{color:colors.sub,fontSize:13,marginBottom:16}},"Current color: "+current),
      h(CustomSection,{title:"Color presets"},...COLOR_PRESETS.map(([label,hex],index)=>h(CustomRow,{key:hex,title:label,subtitle:hex,last:index===COLOR_PRESETS.length-1,trailing:h(RN.View,{style:{flexDirection:"row",alignItems:"center",gap:10,marginRight:6}},h(RN.View,{style:{width:20,height:20,borderRadius:10,backgroundColor:hex}}),current===hex?h(RN.Text,{style:{color:colors.blurple,fontWeight:"800",width:18,textAlign:"center"}},"✓"):h(RN.View,{style:{width:18}})),onPress:()=>select(hex)}))),
      h(CustomAction,{title:"Use default",secondary:true,onPress:()=>select(ACCENT)}));
}
function historyChannelLabel(entry) {
    if (entry.channelName)
        return entry.channelName;
    const channel = getChannel(entry.channelId || null);
    if (!channel)
        return entry.channelId ? "Unavailable channel" : "Draft (not sent)";
    if (isDM(channel)) {
        const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
        const names = recipients.map((id) => nameOf(safe(() => UserStore.getUser(String(id)), null)));
        return channel.name || names.join(", ") || "Direct message";
    }
    const guildId = channel.guild_id || channel.guildId;
    const guildStore = safe(() => findByStoreName("GuildStore"), null);
    const guild = guildId ? safe(() => guildStore?.getGuild?.(String(guildId)), null) : null;
    return (channel.name ? "# " + channel.name : "Channel") + (guild?.name ? " · " + guild.name : "");
}
function deleteHistoryEntry(id) {
    const deleted = historyEntries.find(entry => entry.id === id);
    if (deleted?.messageId) {
        translations.delete(String(deleted.messageId));
        if (deleted.channelId)
            refreshRow(deleted.channelId, String(deleted.messageId));
    }
    historyEntries = historyEntries.filter(entry => entry.id !== id);
    const state = useQuickTranslate.getState();
    const messageTranslations = deleted?.messageId
        ? (state.messageTranslations || []).filter(entry => !(entry.messageId === String(deleted.messageId) && entry.channelId === String(deleted.channelId)))
        : (state.messageTranslations || []);
    state.updateSettings({ historyEntries, messageTranslations });
    persistLocalData();
}
function dismissHistoryNavigation(navigation) {
    let current = navigation;
    let depth = 0;
    while (current && depth++ < 8) {
        try {
            if (current.canGoBack?.()) {
                if (typeof current.popToTop === "function")
                    current.popToTop();
                else
                    current.goBack?.();
            }
            current = current.getParent?.();
        }
        catch (_) {
            break;
        }
    }
}
function jumpToHistoryEntry(entry, navigation) {
    if (!entry.channelId || !entry.messageId) {
        toast("This translation is not linked to a Discord message");
        return;
    }
    const jump = safe(() => findByProps("jumpToMessage"), null);
    const navigate = safe(() => findByProps("transitionToChannel"), null);
    const performJump = () => {
        try {
            if (typeof jump?.jumpToMessage !== "function")
                throw new Error("message navigation is unavailable");
            jump.jumpToMessage({ channelId: entry.channelId, messageId: entry.messageId, flash: true, jumpType: "ANIMATED" });
        }
        catch (_) {
            toast("Could not jump to this message");
        }
    };
    try {
        if (typeof navigate?.transitionToChannel !== "function")
            throw new Error("channel navigation is unavailable");
        dismissHistoryNavigation(navigation);
        navigate.transitionToChannel(entry.channelId, {});
        setTimeout(performJump, 650);
    }
    catch (_) {
        toast("Could not open this channel");
    }
}
function HistoryPage() {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const navigation = NavigationNative.useNavigation();
    const [query, setQuery] = React.useState("");
    const [retryingId, setRetryingId] = React.useState(null);
    const allRows = Array.isArray(settings.historyEntries) ? settings.historyEntries : [];
    const needle = query.trim().toLowerCase();
    const rows = allRows.filter(entry => !needle || [entry.original, entry.translated, historyChannelLabel(entry), languageLabel(entry.source), languageLabel(entry.target)].join(" ").toLowerCase().includes(needle));
    const retryWithAlternate = async (entry) => {
        if (retryingId)
            return;
        const provider = entry.provider === "deepl" ? "google" : "deepl";
        setRetryingId(entry.id);
        try {
            const { out, tokens } = protect(String(entry.original || ""));
            const result = await enqueueRequest(() => callApi(provider, out, entry.target, entry.source || "auto"));
            const translated = restore(result.text, tokens, false);
            const updated = { ...entry, alternativeTranslated: translated, alternativeProvider: provider, alternativeAt: Date.now() };
            historyEntries = historyEntries.map(item => item.id === entry.id ? updated : item);
            updateQuickTranslateSettings({ historyEntries: historyEntries.slice(0, MAX_HISTORY) });
            persistLocalData();
        } catch (error) {
            toast(error?.message || "Could not retranslate with " + (provider === "deepl" ? "DeepL" : "Google"));
        } finally {
            setRetryingId(null);
        }
    };
    const cards = rows.map((entry, index) => {
        const alternateProvider = entry.provider === "deepl" ? "Google" : "DeepL";
        return h(CustomSection, { key: entry.id + index, title: languageLabel(entry.source) + " → " + languageLabel(entry.target) }, h(RN.View, { style: { padding: 14 } }, h(RN.Text, { numberOfLines: 1, style: { color: palette().sub, fontSize: 12, marginBottom: 7 } }, historyChannelLabel(entry) + (entry.messageId ? "" : " · Draft")), h(RN.Text, { numberOfLines: 3, style: { color: palette().sub, fontSize: 13, marginBottom: 7 } }, entry.original), h(RN.Text, { style: { color: palette().text, fontSize: 15, fontWeight: "600", lineHeight: 21 } }, entry.translated), h(RN.Text, { style: { color: palette().sub, fontSize: 11, marginTop: 6 } }, (entry.provider === "deepl" ? "DeepL" : "Google") + " · " + new Date(entry.at).toLocaleString()), entry.alternativeTranslated ? h(RN.View, { style: { marginTop: 12, padding: 11, borderRadius: 11, backgroundColor: palette().bg, borderWidth: 1, borderColor: palette().card2 } }, h(RN.Text, { style: { color: palette().blurple, fontSize: 12, fontWeight: "700", marginBottom: 5 } }, "Alternative · " + (entry.alternativeProvider === "deepl" ? "DeepL" : "Google")), h(RN.Text, { style: { color: palette().text, fontSize: 15, lineHeight: 21 } }, entry.alternativeTranslated)) : null, h(CustomAction, { title: retryingId === entry.id ? "Translating…" : "Try " + alternateProvider, secondary: true, disabled: !!retryingId, onPress: () => retryWithAlternate(entry) }), h(RN.View, { style: { flexDirection: "row", marginTop: 2 } }, h(RN.View, { style: { flex: 1, marginRight: 5 } }, h(CustomAction, { title: "Delete", secondary: true, onPress: () => deleteHistoryEntry(entry.id) })), h(RN.View, { style: { flex: 1, marginLeft: 5 } }, h(CustomAction, { title: "Jump to message", secondary: true, disabled: !entry.channelId || !entry.messageId, onPress: () => jumpToHistoryEntry(entry, navigation) }))), h(CustomAction, { title: "Copy translation", secondary: true, onPress: () => copyText(entry.translated) })));
    });
    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 16, paddingBottom: 42 } }, h(RN.View, { style: { flexDirection: "row", marginBottom: 12 } }, h(RN.View, { style: { flex: 1 } }, h(RN.Text, { style: { color: palette().text, fontSize: 22, fontWeight: "800" } }, "Translation history"), h(RN.Text, { style: { color: palette().sub, fontSize: 13, marginTop: 3 } }, rows.length + " shown · " + allRows.length + " saved locally")), h(RN.Text, { style: { color: palette().sub, fontSize: 19, marginTop: 2 } }, "◷")), h(CustomInput, { value: query, placeholder: "Search translations, channels, or languages", onChangeText: setQuery, autoCorrect: false, style: { marginBottom: 14 } }), rows.length ? null : h(RN.Text, { style: { color: palette().sub, fontSize: 14, paddingVertical: 20, textAlign: "center" } }, allRows.length ? "No history entries match this search." : "No translations saved yet."), ...cards);
}
function listChannelsForGuild(guild) {
    const channels = [];
    const seen = new Set();
    const channelStore = ChannelStore;
    const add = (item) => {
        if (!item || typeof item !== "object" || item.id == null || item.name == null)
            return;
        const canonical = safe(() => channelStore.getChannel(String(item.id)), null) || item;
        const kind = canonical.type;
        if (kind != null && ![0, 5, 10, 11, 12, 15, 16].includes(kind))
            return;
        if (!canonical.guild_id && !canonical.guildId && !guild?.id)
            return;
        const id = String(canonical.id);
        if (seen.has(id))
            return;
        seen.add(id);
        channels.push({ ...canonical, id, guildId: String(guild.id), guildName: guild.name || "Server" });
    };
    const visit = (value, depth) => {
        if (!value || depth > 6)
            return;
        if (Array.isArray(value)) {
            value.forEach((item) => visit(item, depth + 1));
            return;
        }
        if (typeof value !== "object")
            return;
        add(value);
        for (const child of Object.values(value)) {
            if (child && typeof child === "object")
                visit(child, depth + 1);
        }
    };
    for (const method of ["getMutableGuildChannelsForGuild", "getGuildChannels", "getChannels", "getSortedChannels"]) {
        if (typeof channelStore?.[method] !== "function")
            continue;
        visit(safe(() => channelStore[method](String(guild.id)), null), 0);
    }
    visit(guild.channels, 0);
    return channels;
}
function AutoChannelsPage() {
    const h = React.createElement;
    const settings = useQuickTranslate();
    const [query, setQuery] = React.useState("");
    const guildStore = safe(() => findByStoreName("GuildStore"), null);
    const guilds = Object.values(safe(() => guildStore?.getGuilds?.(), {}) || {});
    const selected = (settings.autoChannelIds || []).map(String);
    const q = query.trim().toLowerCase();
    const sections = guilds.map(guild => ({
        guild,
        channels: listChannelsForGuild(guild).filter(channel => !q || String(channel.name).toLowerCase().includes(q) || String(guild.name).toLowerCase().includes(q)),
    })).filter(section => section.channels.length);
    const toggleChannel = (id) => {
        const next = selected.includes(id) ? selected.filter(x => x !== id) : selected.concat(id);
        updateQuickTranslateSettings({ autoChannelIds: next });
    };
    const dmIds = safe(() => PrivateChannelSortStore.getPrivateChannelIds?.(), []) || [];
    const dms = dmIds.map(id => safe(() => ChannelStore.getChannel(String(id)), null)).filter((channel) => channel && isDM(channel)).map((channel) => {
        const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
        const label = channel.name || recipients.map((id) => nameOf(safe(() => UserStore.getUser(String(id)), null))).join(", ") || "Direct message";
        return Object.assign({}, channel, { displayName: label });
    }).filter((channel) => !q || String(channel.displayName).toLowerCase().includes(q));
    const row = (channel, label, index, total) => {
        const id = String(channel.id);
        const marked = selected.includes(id);
        return h(CustomRow, { key: id, title: label, subtitle: channel.topic || undefined, last: index === total - 1,
            trailing: h(RN.View, { style: { width: 23, height: 23, borderRadius: 6, borderWidth: 1.5, borderColor: marked ? palette().blurple : palette().off, backgroundColor: marked ? palette().blurple : "transparent", alignItems: "center", justifyContent: "center" } }, marked ? h(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" } }, "✓") : null),
            onPress: () => toggleChannel(id) });
    };
    return h(RN.ScrollView, { style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 40 } }, h(RN.Text, { style: { color: palette().sub, fontSize: 13, marginBottom: 12 } }, "Select only the channels and DMs where new incoming messages should be translated. " + selected.length + " selected."), h(CustomInput, { value: query, placeholder: "Search channels, servers, or DMs", onChangeText: setQuery, autoCorrect: false, style: { marginBottom: 16 } }), dms.length ? h(CustomSection, { title: "Direct messages" }, ...dms.map((channel, index) => row(channel, channel.displayName, index, dms.length))) : null, ...sections.map(section => h(CustomSection, { key: section.guild.id, title: section.guild.name || "Server" }, ...section.channels.map((channel, index) => row(channel, "# " + channel.name, index, section.channels.length)))), !dms.length && !sections.length ? h(RN.Text, { style: { color: palette().sub, fontSize: 14, paddingVertical: 22, textAlign: "center" } }, "No channels or DMs found. Open them once so the channel list can load.") : null);
}
const TargetOutPage = () => React.createElement(LangPicker, { field: "targetOut" });
const SourceOutPage = () => React.createElement(LangPicker, { field: "sourceOut" });
const TargetInPage = () => React.createElement(LangPicker, { field: "targetIn" });
function Settings() {
    const h = React.createElement;
    const navigation = NavigationNative.useNavigation();
    const settings = useQuickTranslate();
    const go = (title, render) => navigation.push("RAIN_CUSTOM_PAGE", { title, render });
    const C = palette();
    const toggle = (title, subtitle, value, change) => h(CustomRow, {
        title, subtitle, trailing: h(CustomSwitch, { value, onChange: change }),
    });
    if (!settings._hasHydrated)
        return h(RN.View, { style: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 } }, h(RN.Text, { style: { color: C.sub, fontSize: 15 } }, "Loading saved Quick Translate settings…"));
    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 16, paddingBottom: 42 } }, h(KitHero, { icon: "lang", title: "Quick Translate", subtitle: "Translation preferences for your chats", stats: [["Saved", Array.isArray(settings.historyEntries) ? settings.historyEntries.length : 0], ["Service", settings.provider === "deepl" ? "DeepL" : "Google"], ["Output", langName(settings.targetOut)]] }), h(CustomSection, { title: "Translation service" }, h(CustomRow, { title: "Google Translate", subtitle: "No key required · selected by default", icon: "🌐", last: settings.provider !== "deepl",
        trailing: settings.provider !== "deepl" ? h(RN.Text, { style: { color: C.blurple, fontWeight: "800", fontSize: 18 } }, "✓") : null,
        onPress: () => updateQuickTranslateSettings({ provider: "google" }) }), h(CustomRow, { title: "DeepL", subtitle: "Uses your personal API key · Google fallback", icon: "✦", last: settings.provider === "deepl",
        trailing: settings.provider === "deepl" ? h(RN.Text, { style: { color: C.blurple, fontWeight: "800", fontSize: 18 } }, "✓") : null,
        onPress: () => updateQuickTranslateSettings({ provider: "deepl" }) }), settings.provider === "deepl" ? h(RN.View, { style: { padding: 14, borderTopWidth: 1, borderTopColor: C.card2 } }, h(RN.Text, { style: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 8 } }, "DeepL API key"), h(CustomInput, { value: settings.deeplApiKey || "", placeholder: "Paste your API key", autoCapitalize: "none", autoCorrect: false, secureTextEntry: true, onChangeText: (deeplApiKey) => updateQuickTranslateSettings({ deeplApiKey }) }), h(RN.Text, { style: { color: C.sub, fontSize: 12, marginTop: 7, lineHeight: 17 } }, "Your key is stored in this plugin’s local settings. Free API keys ending in :fx are supported.")) : null), h(CustomSection, { title: "Translation rules" }, h(RN.View, { style: { padding: 14 } }, h(RN.Text, { style: { color: C.text, fontSize: 15, fontWeight: "600", marginBottom: 5 } }, "Keep words unchanged"), h(RN.Text, { style: { color: C.sub, fontSize: 12, lineHeight: 16, marginBottom: 9 } }, "Separate words with commas or new lines. Matching whole words keep their original form."), h(CustomInput, { value: (settings.protectedWords || []).join(", "), placeholder: "e.g. names, terms", multiline: true, textAlignVertical: "top", onChangeText: (value) => {
            const protectedWords = Array.from(new Set(String(value || "").split(/[,\n]+/).map((word) => word.trim()).filter(Boolean))).slice(0, 100);
            updateQuickTranslateSettings({ protectedWords });
        }, style: { minHeight: 88, paddingVertical: 11 } }))), h(CustomSection, { title: "Languages" }, h(CustomRow, { title: "Translate my messages to", subtitle: languageLabel(settings.targetOut), icon: "↗", trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), onPress: () => go("Translate my messages to", TargetOutPage) }), h(CustomRow, { title: "My messages are written in", subtitle: languageLabel(settings.sourceOut), icon: "↙", trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), onPress: () => go("My messages are written in", SourceOutPage) }), h(CustomRow, { title: "Translate messages to", subtitle: languageLabel(settings.targetIn), icon: "文", trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), onPress: () => go("Translate messages to", TargetInPage) }), h(CustomRow, { title: "Quick languages", subtitle: (settings.favLangs || []).length + " of " + MAX_FAVS + " selected", icon: "★", last: true, trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), onPress: () => go("Quick languages", FavPicker) })), h(CustomSection, { title: "Appearance" }, toggle("Immersive translation", "Show the translation below the original message. Turn off to replace its text.", !!settings.immersive, (v) => { updateQuickTranslateSettings({ immersive: v }); refreshTranslated(); }), toggle("Show detected source language", "Show a compact source → target code below the translation.", !!settings.showSourceLanguage, (v) => { updateQuickTranslateSettings({ showSourceLanguage: v }); refreshTranslated(); if (v)
        toast("Translate a message to see its source and target codes"); }), h(CustomRow, { title: "Translation color", subtitle: translationColor(), trailing: h(RN.View, { style: { flexDirection: "row", alignItems: "center" } }, h(RN.View, { style: { width: 15, height: 15, borderRadius: 5, backgroundColor: translationColor(), marginRight: 9 } }), h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›")), last: true, onPress: () => go("Translation color", ColorPicker) })), h(CustomSection, { title: "Incoming messages" }, toggle("Immersive auto-translate", "Show auto-translations below original.", !!settings.autoIncomingImmersive, (v) => { updateQuickTranslateSettings({ autoIncomingImmersive: v }); refreshTranslated(); }), h(CustomRow, { title: "Automatic channels and DMs", subtitle: (settings.autoChannelIds || []).length + " selected", icon: "☷", trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), last: true, onPress: () => go("Automatic channels and DMs", AutoChannelsPage) })), h(CustomSection, { title: "Translation history & cache" }, toggle("Keep translations after restart", "Restore saved translations when Discord restarts.", settings.keepMessageTranslations !== false, (v) => { updateQuickTranslateSettings({ keepMessageTranslations: v, messageTranslations: v ? (settings.messageTranslations || []) : [] }); }), h(CustomRow, { title: "Translation history", subtitle: (settings.historyEntries || []).length + " saved locally", icon: "◷", trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), onPress: () => go("Translation history", HistoryPage) }), h(RN.View, { style: { paddingHorizontal: 13, paddingBottom: 11 } }, h(RN.Text, { style: { color: C.sub, fontSize: 12, marginTop: 10 } }, "Removes saved history, message translations and cached results."), h(CustomAction, { title: "Clear translation history & cache", secondary: true, onPress: () => {
            clearTranslationData();
        } }))), h(CustomSection, { title: "Chat composer" }, toggle("Show translate button", "Show the translate control in the chat composer.", settings.showButton !== false, (v) => { if (!v)
        armed = null; updateQuickTranslateSettings({ showButton: v }); notifyButton(); }), toggle("Translate before sending", "Send becomes Translate; tap again to send.", settings.draftBeforeSend !== false, (v) => { updateQuickTranslateSettings({ draftBeforeSend: v }); notifyButton(); }), toggle("Highlight Translate Draft button", "Use a blue background to distinguish Translate from Send.", settings.highlightDraftButton !== false, (v) => updateQuickTranslateSettings({ highlightDraftButton: v })), toggle("Remember language per chat", "Store each chat’s default language separately.", settings.rememberLanguagesPerChat !== false, (v) => updateQuickTranslateSettings({ rememberLanguagesPerChat: v })), toggle("Keep translate active", "In normal mode, keep translating sent messages until you turn it off.", !!settings.keepArmed, (v) => { updateQuickTranslateSettings({ keepArmed: v }); notifyButton(); }), h(CustomRow, { title: "Button position", subtitle: settings.anchor === "send" ? "Next to the Send button" : "Next to the + button", trailing: h(RN.Text, { style: { color: C.sub, fontSize: 21 } }, "›"), onPress: () => {
            const sheets = safe(() => findByProps("showSimpleActionSheet"), null);
            if (!sheets?.showSimpleActionSheet) {
                toast("Could not open position options");
                return;
            }
            const hide = safe(() => findByProps("openLazy", "hideActionSheet"), null);
            const savePosition = (anchor) => {
                useQuickTranslate.getState().updateSettings({ anchor });
                notifyButton();
                safe(() => hide?.hideActionSheet?.(), null);
            };
            sheets.showSimpleActionSheet({ key: "QTButtonPosition", header: { title: "Button position" }, options: [
                    { label: "Next to the + button", isMarked: settings.anchor !== "send", onPress: () => savePosition("actions") },
                    { label: "Next to the Send button", isMarked: settings.anchor === "send", onPress: () => savePosition("send") },
                ] });
        } }), toggle("Save translation history", "Store translated messages and drafts locally in Translation history.", settings.saveHistory !== false, (v) => updateQuickTranslateSettings({ saveHistory: v })), toggle("Hide Gift button", "Hide the Gift button in the chat composer.", !!settings.hideGiftButton, (v) => { updateQuickTranslateSettings({ hideGiftButton: v }); toast("Restart Discord to apply this setting"); })), h(KitGuide, { title: "Quick guide", steps: [["Translate a message","Long-press a message to translate it, view the original, or open more translation actions."],["Translate a draft","Use the Translate button in the composer to translate what you are typing before it is sent. With Translate before sending on, Send turns into Translate and a second tap sends."],["Pick a service and languages","Choose Google Translate (no key needed) or DeepL (your own API key), then set separate languages for your outgoing and incoming messages."],["Automatic translation","Select the channels and DMs where new incoming messages should be translated automatically. Immersive mode shows the translation below the original."],["History and comparing","Translation history keeps your saved translations. Use Try DeepL or Try Google to compare the other service without changing your default, copy a translation, or jump to its message."],["Protect words","Add protected words, such as names or terms, that should never be translated."]] }), h(RN.Text, { style: { color: C.sub, fontSize: 12, textAlign: "center", marginTop: 1, opacity: 0.7 } }, "Quick Translate " + BUILD));
}
/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */
const step = (name, fn) => {
    try {
        fn();
    }
    catch (e) {
        console.error(`[QuickTranslate] ${name} failed:`, e);
    }
};
function migrateSettings() {
    let stored = useQuickTranslate.getState();
    if (stored.settingsVersion < 2) {
        stored.updateSettings({ keepArmed: true, hideGiftButton: true, settingsVersion: 2 });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 3) {
        stored.updateSettings({
            showSourceLanguage: false, autoIncoming: false, includeDMs: false,
            excludedChannelIds: [], translateDraft: false, historyEntries: [], cacheEntries: [], settingsVersion: 3,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 4) {
        stored.updateSettings({
            liveTranslateInput: undefined,
            translateDraft: undefined,
            settingsVersion: 4,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 5) {
        stored.updateSettings({
            autoChannelIds: Array.isArray(stored.autoChannelIds) ? stored.autoChannelIds : [],
            autoIncomingImmersive: stored.autoIncomingImmersive !== false,
            includeDMs: undefined,
            excludedChannelIds: undefined,
            settingsVersion: 5,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 6) {
        stored.updateSettings({
            immersive: true,
            translateOnSend: undefined,
            liveTranslateInput: undefined,
            settingsVersion: 6,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 7) {
        stored.updateSettings({
            draftBeforeSend: true,
            saveHistory: stored.saveHistory !== false,
            rememberDrafts: stored.rememberDrafts !== false,
            rememberedDrafts: stored.rememberedDrafts && typeof stored.rememberedDrafts === "object" ? stored.rememberedDrafts : {},
            settingsVersion: 7,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 8) {
        stored.updateSettings({
            rememberLanguagesPerChat: stored.rememberLanguagesPerChat !== false,
            chatLanguages: stored.chatLanguages && typeof stored.chatLanguages === "object" ? stored.chatLanguages : {},
            highlightDraftButton: stored.highlightDraftButton !== false,
            settingsVersion: 8,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 9) {
        stored.updateSettings({
            autoIncoming: undefined,
            protectedWords: Array.isArray(stored.protectedWords) ? stored.protectedWords : [],
            settingsVersion: 9,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 10) {
        stored.updateSettings({ quickTargets: undefined, settingsVersion: 10 });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 11) {
        stored.updateSettings({ rememberedDrafts: {}, rememberDrafts: undefined, settingsVersion: 11 });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 12) {
        const oldMessageTranslations = (Array.isArray(stored.messageTranslations) ? stored.messageTranslations : []).slice();
        if (!oldMessageTranslations.length) {
            for (const entry of (Array.isArray(stored.historyEntries) ? stored.historyEntries : [])) {
                if (!entry?.messageId || !entry.channelId || typeof entry.translated !== "string")
                    continue;
                oldMessageTranslations.push({
                    id: String(entry.channelId) + "|" + String(entry.messageId),
                    messageId: String(entry.messageId), channelId: String(entry.channelId),
                    original: entry.original, translated: entry.translated, source: entry.source || "auto",
                    target: entry.target || "en", at: Number(entry.at) || Date.now(),
                    autoIncoming: (stored.autoChannelIds || []).map(String).includes(String(entry.channelId)),
                });
            }
        }
        stored.updateSettings({
            keepMessageTranslations: stored.keepMessageTranslations !== false,
            messageTranslations: oldMessageTranslations.slice(0, MAX_TRANSLATIONS),
            settingsVersion: 12,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.settingsVersion < 13) {
        stored.updateSettings({
            immersive: true, autoIncomingImmersive: true, showButton: true, draftBeforeSend: true, highlightDraftButton: true,
            rememberLanguagesPerChat: true, keepArmed: true, saveHistory: true, hideGiftButton: true,
            settingsVersion: 13,
        });
        stored = useQuickTranslate.getState();
    }
    if (stored.anchor !== "actions" && stored.anchor !== "send")
        stored.updateSettings({ anchor: "actions" });
}
function waitForSettingsHydration() {
    const current = useQuickTranslate.getState();
    if (current._hasHydrated) {
        migrateSettings();
        return;
    }
    let unsubscribe = null;
    unsubscribe = useQuickTranslate.subscribe((next) => {
        if (!next._hasHydrated)
            return;
        if (unsubscribe)
            unsubscribe();
        migrateSettings();
        notifyButton();
    });
    unpatches.push(() => { if (unsubscribe)
        unsubscribe(); });
}
function onChannelSelect(e) {
    const id = e && e.channelId != null ? String(e.channelId) : null;
    if (id === lastChannelId)
        return;
    lastChannelId = id;
    bridge.text = "";
    bridge.change = null;
    bridge.inst = null;
    bridge.seen = 0;
    if (lastOriginalChannelId && lastOriginalChannelId !== id) {
        lastOriginal = null;
        lastOriginalChannelId = null;
    }
    if (bulkSelectionRequest && id !== bulkSelectionRequest.channelId) {
        bulkSelectionRequest = null;
        notifyButton();
    }
    if (armed) {
        armed = null;
        notifyButton();
    }
}
exports.default = {
    name: "Quick Translate",
    description: "Translate incoming and outgoing messages with Google Translate or DeepL.",
    id: "quicktranslate",
    version: "1.0.8",
    start() {
        renderErrors = 0;
        step("textBridge", installTextBridge);
        step("settingsHydration", waitForSettingsHydration);
        step("localData", hydrateLocalData);
        step("channel", () => {
            lastChannelId = currentChannelId();
            FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
            unpatches.push(() => FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect));
        });
        step("incomingMessages", () => {
            FluxDispatcher.subscribe("MESSAGE_CREATE", onIncomingMessage);
            unpatches.push(() => FluxDispatcher.unsubscribe("MESSAGE_CREATE", onIncomingMessage));
        });
        step("render", patchRender);
        step("actionSheet", patchActionSheet);
        step("inputCapture", installInputCapture);
        step("send", patchSend);
        step("chatButton", patchChatButton);
    },
    stop() {
        pluginStarted = false;
        for (const u of unpatches.splice(0)) {
            try {
                u();
            }
            catch (_) { /* ignore */ }
        }
        if (renderUnpatch) {
            try {
                renderUnpatch();
            }
            catch (_) { /* ignore */ }
            renderUnpatch = null;
        }
        translations.clear();
        cacheGeneration++;
        cache.clear();
        inFlight.clear();
        autoSeen.clear();
        bulkSelectionRequest = null;
        persistentReady = false;
        historyEntries = [];
        bridge.text = "";
        bridge.change = null;
        bridge.inst = null;
        armed = null;
        lastOriginal = null;
        lastOriginalChannelId = null;
    },
    settings: Settings,
};
