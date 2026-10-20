"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const rainRuntime = globalThis.rain;
if (!rainRuntime || !rainRuntime.api || !rainRuntime.api.storage) throw new Error("Discord plugin API unavailable");
const rainStore = rainRuntime.api.storage.createPluginStore("showreactionpfp", {});
const implementation = (() => {
  "use strict";
  const { metro } = rainRuntime;
  const patcher = rainRuntime.api.patcher;
  const ui = rainRuntime.api.ui;
  const { findByProps, findByStoreName } = metro;
  const { React, ReactNative: RN, FluxDispatcher } = metro.common;

  const BUILD = "v1.0.3";
  const TTL = 90000;
  const FETCH_LIMIT = 6;
  const NAME_HINT = /^(Reaction|MessageReaction|MessageReactionPill|ReactionPill|EmojiReactionRowButton|MessageReactions)$/;
  const SIZES = { small: 14, medium: 18, large: 22 };

  const unpatches = [];
  const subs = new Map();
  const cache = new Map();
  const debugSeen = new Map();
  const debugSubs = new Set();
  const DEBUG_MAX = 100;
  let debugNotifyTimer = null;
  let UserStore = null;
  let SelectedChannelStore = null;
  let RestAPI = null;
  let loadRequested = false;
  let initialized = false;
  let hydrationUnsubscribe = null;

  const cfg = () => rainStore.useStore.getState();
  const setSetting = (key, value) => rainStore.useStore.getState().updateSettings({ [key]: value });
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (_) {} };
  function recordDebug(line) {
    const value = String(line || "");
    if (!debugSeen.has(value)) {
      if (debugSeen.size >= DEBUG_MAX) {
        const evict = Array.from(debugSeen.keys()).find((key) => !key.startsWith("BUILD "));
        if (evict !== undefined) debugSeen.delete(evict);
      }
      debugSeen.set(value, Date.now());
      if (debugNotifyTimer == null) debugNotifyTimer = setTimeout(() => {
        debugNotifyTimer = null;
        for (const fn of Array.from(debugSubs)) { try { fn(); } catch (_) {} }
      }, 180);
    }
  }
  function shapeOf(value) {
    if (!value || typeof value !== "object") return typeof value;
    if (Array.isArray(value)) {
      const first = value[0];
      return "Array(" + value.length + ")" + (first && typeof first === "object" ? "{" + Object.keys(first).slice(0, 8).join(",") + "}" : "");
    }
    return "{" + Object.keys(value).slice(0, 10).join(",") + (Object.keys(value).length > 10 ? ",…" : "") + "}";
  }
  function captureComponent(type, props) {
    if (!props || (typeof type !== "function" && typeof type !== "object")) return;
    const name = typeName(type) || "(anonymous component)";
    const keys = Object.keys(props);
    const nested = ["reaction", "emoji", "message", "item", "data", "reactionData"].filter((k) => props[k] != null).map((k) => k + "=" + shapeOf(props[k]));
    const relevant = /reaction|emoji/i.test(name) || keys.some((k) => /reaction|emoji|message|channel|count/i.test(k)) || nested.length > 0;
    if (relevant) recordDebug(name + " | props: " + keys.slice(0, 16).join(", ") + (nested.length ? " | nested: " + nested.join("; ") : ""));
  }
  const myId = () => { try { return UserStore && UserStore.getCurrentUser() && UserStore.getCurrentUser().id || null; } catch (_) { return null; } };

/* ---- shared settings design kit (same as the other plugins) ---- */
  function palette() {
    let light = false;
    try { ThemeStore = ThemeStore || findByStoreName("ThemeStore"); light = !!ThemeStore && ThemeStore.theme === "light"; } catch (_) {}
    return light
      ? { text: "#060607", sub: "#5C5E66", bg: "#FFFFFF", card: "#F2F3F5", acc: "#5865F2", accPressed: "#4752C4", blurple: "#5865F2", card2: "rgba(0,0,0,0.045)", chip: "rgba(0,0,0,0.07)", press: "rgba(0,0,0,0.06)", divider: "rgba(0,0,0,0.09)", off: "#B5BAC1" }
      : { text: "#FFFFFF", sub: "#B5BAC1", bg: "#1E1F22", card: "#2B2D31", acc: "#5865F2", accPressed: "#4752C4", blurple: "#5865F2", card2: "rgba(255,255,255,0.06)", chip: "rgba(255,255,255,0.10)", press: "rgba(255,255,255,0.07)", divider: "rgba(255,255,255,0.09)", off: "#4E5058" };
}

  /* ---- shared settings design kit (identical in AML / GPL / QT) ---- */
  const KIT_TILES = {
    lang: ["LanguageIcon", "\u6587", "#5865F2"], paint: ["PaintPaletteIcon", "\u25C9", "#EB459E"], time: ["ClockIcon", "\u25F7", "#E58A00"],
    store: ["ClipboardListIcon", "\u25A3", "#3BA55D"], trash: ["TrashIcon", "\u232B", "#ED4245"], edit: ["PencilIcon", "\u270E", "#F07B3E"],
    shield: ["ShieldIcon", "\u2298", "#80848E"], bell: ["BellIcon", "!", "#E58A00"], at: ["BellIcon", "@", "#ED4245"],
    reply: ["ChatMarkUnreadIcon", "\u21A9", "#5865F2"], search: ["CompassIcon", "\u2315", "#1ABC9C"], chat: ["ChatMarkUnreadIcon", "\u25A4", "#5865F2"],
    plus: ["PlusSmallIcon", "+", "#5865F2"], link: ["LinkIcon", "\u2197", "#3498DB"], test: ["WrenchIcon", "\u25B7", "#9B59B6"],
    star: ["StarIcon", "\u2605", "#D99700"], server: ["PinIcon", "\u25C7", "#3498DB"], power: ["SettingsIcon", "\u25CF", "#43B581"],
    text: ["PencilIcon", "Aa", "#F07B3E"], guide: ["ClipboardCheckIcon", "?", "#5865F2"], gear: ["SettingsIcon", "\u2022", "#80848E"],
    lock: ["LockIcon", "\u25C8", "#80848E"]
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
    const tile = key ? KitTile({ k: key, size: p.dense ? 30 : 34 }) : null;
    return h(RN.Pressable, {
      accessibilityRole: p.onPress ? "button" : undefined, onPress: p.onPress, disabled: !p.onPress,
      style: ({ pressed }) => ({ minHeight: p.dense ? 48 : 66, paddingHorizontal: 16, paddingVertical: p.dense ? 7 : 13, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? C.press : "transparent" })
    },
      tile,
      h(RN.View, { style: { flex: 1, minWidth: 0, paddingRight: 10 } },
        h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: p.dense ? 14 : 16, fontWeight: "600", lineHeight: p.dense ? 18 : 21 } }, p.title),
        p.subtitle ? h(RN.Text, { numberOfLines: p.dense ? 2 : 3, style: { color: C.sub, fontSize: 13, marginTop: p.dense ? 1 : 3, lineHeight: p.dense ? 17 : 18 } }, p.subtitle) : null),
      p.trailing || null,
      !p.last ? h(RN.View, { style: { position: "absolute", bottom: 0, left: key ? (p.dense ? 59 : 63) : 16, right: 0, height: 1, backgroundColor: C.card2 } }) : null);
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
  function KitChip(p) {
    const C = palette(), h = React.createElement;
    return h(RN.Pressable, { onPress: p.onPress, accessibilityRole: "button", accessibilityState: { selected: !!p.active }, hitSlop: 4,
      style: ({ pressed }) => ({ height: 34, borderRadius: 17, paddingHorizontal: 14, marginRight: p.flush ? 0 : 8, marginBottom: p.flush ? 0 : 8, flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: p.active ? C.blurple : C.chip, opacity: pressed ? 0.8 : 1 }) },
      h(RN.Text, { numberOfLines: 1, style: { color: p.active ? "#FFFFFF" : C.text, fontSize: 14, fontWeight: "600" } }, p.label),
      p.badge ? h(RN.View, { style: { marginLeft: 7, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: p.active ? "rgba(255,255,255,0.28)" : hexA(C.blurple, 0.22), alignItems: "center", justifyContent: "center" } },
        h(RN.Text, { style: { color: p.active ? "#FFFFFF" : C.blurple, fontSize: 12, fontWeight: "800" } }, String(p.badge))) : null);
  }


  
  /* ---- reactors: fetch + cache ---- */
  function emojiParam(emoji) {
    if (!emoji) return null;
    if (emoji.id) return (emoji.name || "_") + ":" + emoji.id;
    return emoji.name || null;
  }
  const keyOf = (c, m, e) => c + ":" + m + ":" + (emojiParam(e) || "");
  function notify(key) {
    const listeners = [];
    if (key == null) {
      for (const group of subs.values()) for (const fn of group) listeners.push(fn);
    } else {
      const group = subs.get(key);
      if (group) for (const fn of group) listeners.push(fn);
    }
    for (const fn of listeners) { try { fn(); } catch (_) {} }
  }
  function subscribe(key, fn) {
    let group = subs.get(key);
    if (!group) { group = new Set(); subs.set(key, group); }
    group.add(fn);
    return () => {
      group.delete(fn);
      if (!group.size && subs.get(key) === group) subs.delete(key);
    };
  }
  function avatarUrl(u, size) {
    if (u.avatar) return "https://cdn.discordapp.com/avatars/" + u.id + "/" + u.avatar + ".png?size=" + size;
    let idx = 0;
    try { idx = Number(BigInt(u.id) >> BigInt(22)) % 6; } catch (_) {}
    return "https://cdn.discordapp.com/embed/avatars/" + idx + ".png";
  }
  function ensure(channelId, messageId, emoji, count) {
    const key = keyOf(channelId, messageId, emoji);
    const hit = cache.get(key);
    const fresh = hit && (hit.loading || (Date.now() - hit.at < TTL && hit.count === count));
    if (fresh) return;
    const param = emojiParam(emoji);
    if (!param || !RestAPI) {
      if (cfg().debug) recordDebug("FETCH skipped: " + (!param ? "emoji could not be encoded" : "Discord REST module missing"));
      return;
    }
    const entry = { users: hit ? hit.users : [], at: Date.now(), count, loading: true };
    cache.set(key, entry);
    if (cfg().debug) recordDebug("FETCH started for reaction " + param);
    Promise.resolve(RestAPI.get({
      url: "/channels/" + channelId + "/messages/" + messageId + "/reactions/" + encodeURIComponent(param),
      query: { limit: FETCH_LIMIT, type: 0 },
      oldFormErrors: true
    })).then((res) => {
      const body = Array.isArray(res) ? res : res && res.body;
      entry.users = Array.isArray(body) ? body.map((u) => ({ id: String(u.id), avatar: u.avatar || null, name: u.global_name || u.username || "" })) : [];
      if (cfg().debug) recordDebug("FETCH succeeded: " + entry.users.length + " users returned" + (!Array.isArray(body) ? " (unexpected response shape)" : ""));
    }).catch((err) => {
      if (cfg().debug) recordDebug("FETCH failed: " + String(err && (err.message || err.status || err) || "unknown error").slice(0, 180));
    }).then(() => {
      entry.loading = false;
      entry.at = Date.now();
      notify(key);
    });
  }
  function invalidate(channelId, messageId, emoji) {
    const key = keyOf(channelId, messageId, emoji);
    if (cache.has(key)) { cache.delete(key); notify(key); }
  }
  function hookDispatch(args) {
    try {
      const ev = args && args[0];
      if (!ev || (ev.type !== "MESSAGE_REACTION_ADD" && ev.type !== "MESSAGE_REACTION_REMOVE")) return;
      if (ev.channelId && ev.messageId && ev.emoji) invalidate(ev.channelId, ev.messageId, ev.emoji);
    } catch (_) {}
  }

  /* ---- reaction avatars ---- */
  function ringColor() {
    let light = false;
    try { const t = findByStoreName("ThemeStore"); light = !!t && t.theme === "light"; } catch (_) {}
    return light ? "#FFFFFF" : "#313338";
  }
  function Reactors(p) {
    const h = React.createElement;
    const key = keyOf(p.channelId, p.messageId, p.emoji);
    const [ver, bump] = React.useState(0);
    React.useEffect(() => {
      const fn = () => bump((x) => x + 1);
      return subscribe(key, fn);
    }, [key]);
    React.useEffect(() => { ensure(p.channelId, p.messageId, p.emoji, p.count); }, [key, p.count, ver]);
    const s = cfg();
    const entry = cache.get(key);
    const me = myId();
    const max = Math.max(1, Math.min(3, Number(s.maxAvatars) || 3));
    const users = ((entry && entry.users) || []).filter((u) => !(s.hideSelf && me && u.id === me)).slice(0, max);
    if (!users.length) return p.original;
    const size = SIZES[s.size] || SIZES.medium;
    const ring = ringColor();
    const step = s.overlap ? -Math.round(size * 0.32) : 3;
    return h(React.Fragment, null,
      p.original,
      h(RN.View, { pointerEvents: "none", style: { flexDirection: "row", alignItems: "center", marginLeft: 5 } },
        ...users.map((u, i) => h(RN.Image, { key: "rp-" + u.id, source: { uri: avatarUrl(u, 64) }, accessibilityLabel: u.name,
          style: { width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, borderWidth: 2, borderColor: ring, backgroundColor: ring, marginLeft: i === 0 ? 0 : step } }))));
  }
  function typeName(t) {
    if (!t) return "";
    if (typeof t === "string") return t;
    return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && (t.render.displayName || t.render.name)) || "";
  }
  function resolve(type, props) {
    if (!props) return null;
    const name = typeName(type);
    const candidate = /reaction|emoji/i.test(name) || !!(props.reaction || props.emoji || props.reactions);
    if (/^MessageReactionsContent$/i.test(name) || /reactionemoji|reactioncount/i.test(name)) {
      if (cfg().debug && candidate) recordDebug("SKIP " + name + ": container/child component");
      return null;
    }
    const msg = props.message || null;
    const reaction = props.reaction || (props.item && (props.item.reaction || props.item)) || null;
    const emoji = props.emoji || (reaction && reaction.emoji) || null;
    const messageId = props.messageId || (msg && msg.id) || props.message_id || null;
    if (!emoji || !messageId) {
      if (cfg().debug && candidate) recordDebug("UNRESOLVED " + (name || "component") + ": emoji=" + !!emoji + ", messageId=" + !!messageId + ", keys=" + Object.keys(props).slice(0, 16).join(","));
      return null;
    }
    if (!NAME_HINT.test(name) && !reaction) {
      if (cfg().debug && candidate) recordDebug("UNRESOLVED " + name + ": component name/props did not match per-reaction row");
      return null;
    }
    let channelId = props.channelId || (msg && (msg.channel_id || msg.channelId)) || props.channel_id || null;
    if (!channelId) { try { channelId = SelectedChannelStore && SelectedChannelStore.getChannelId(); } catch (_) {} }
    if (!channelId) {
      if (cfg().debug && candidate) recordDebug("UNRESOLVED " + name + ": channelId missing");
      return null;
    }
    const count = props.count != null ? props.count : (reaction && reaction.count != null ? reaction.count : 0);
    if (cfg().debug) recordDebug("MATCHED " + name + ": message, channel and emoji found");
    return { channelId: String(channelId), messageId: String(messageId), emoji, count };
  }
  function scheduleReactionPrefetch(props) {
    if (!props || !Array.isArray(props.reactions) || !props.reactions.length || !props.messageId) return;
    let channelId = props.channelId || props.channel_id || null;
    if (!channelId) { try { channelId = SelectedChannelStore && SelectedChannelStore.getChannelId(); } catch (_) {} }
    if (!channelId) return;
    const messageId = String(props.messageId);
    const pending = props.reactions.map((reaction) => ({
      emoji: reaction && (reaction.emoji || (reaction.reaction && reaction.reaction.emoji)),
      count: reaction && reaction.count != null ? reaction.count : 0
    })).filter((reaction) => reaction.emoji && reaction.count > 0);
    if (!pending.length) return;
    if (cfg().debug) recordDebug("PREFETCH MessageReactionsContent: " + pending.length + " reactions");
    Promise.resolve().then(() => {
      if (!loadRequested || !cfg().enabled) return;
      for (const reaction of pending) ensure(String(channelId), messageId, reaction.emoji, reaction.count);
    });
  }
  function patchReactions() {
    let runtime = null;
    try { const r = findByProps("jsx", "jsxs"); if (r && typeof r.jsx === "function") runtime = r; } catch (_) {}
    if (!runtime) return false;
    const wrap = (args, ret) => {
      try {
        if (!ret || ret.type === Reactors) return ret;
        const st = cfg();
        if (!st.enabled) return ret;
        const type = args && args[0];
        const props = ret.props || (args && args[1]) || null;
        if (st.debug) {
          if (!debugSeen.has("JSX hook active")) recordDebug("JSX hook active; rendering intercepted elements");
          captureComponent(type, props);
        }
        if (/^MessageReactionsContent$/i.test(typeName(type))) { scheduleReactionPrefetch(props); return ret; }
        const r = resolve(type, props);
        if (!r) return ret;
        const next = { original: ret, channelId: r.channelId, messageId: r.messageId, emoji: r.emoji, count: r.count };
        if (ret.key != null) next.key = ret.key;
        return React.createElement(Reactors, next);
      } catch (_) {}
      return ret;
    };
    unpatches.push(patcher.after("jsx", runtime, wrap));
    if (typeof runtime.jsxs === "function") unpatches.push(patcher.after("jsxs", runtime, wrap));
    recordDebug("JSX hook installed" + (typeof runtime.jsxs === "function" ? " (jsx + jsxs)" : " (jsx only)") + "; open a chat with reactions to capture components");
    return true;
  }

  /* ---- settings ---- */
  function Settings() {
    rainStore.useStore();
    const [, bump] = React.useState(0);
    React.useEffect(() => {
      const fn = () => bump((x) => x + 1);
      debugSubs.add(fn);
      return () => { debugSubs.delete(fn); };
    }, []);
    const C = palette(), h = React.createElement;
    const s = cfg();
    const refresh = () => { cache.clear(); notify(); bump((x) => x + 1); };
    const toggle = (key, title, subtitle, icon, last) => h(CustomRow, { key, title, subtitle, icon, last: !!last,
      trailing: h(CustomSwitch, { value: !!s[key], onChange: (v) => { setSetting(key, v); refresh(); } }) });
    const chips = (key, title, subtitle, icon, options, last) => h(React.Fragment, { key },
      h(CustomRow, { title, subtitle, icon, last: true }),
      h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, paddingBottom: 6, paddingTop: 2 } },
        ...options.map((o) => h(KitChip, { key: key + "-" + o[0], label: o[1], active: String(s[key]) === String(o[0]), onPress: () => { setSetting(key, o[0]); refresh(); } }))),
      !last ? h(RN.View, { style: { height: 1, backgroundColor: C.card2, marginLeft: 63 } }) : null);
    const guide = h(KitGuide, { key: "guide", title: "Quick guide", steps: [
      ["What it does", "Next to every reaction on a message you see up to three profile pictures of the people who reacted with it."],
      ["How many pictures", "Choose 1, 2 or 3 under Appearance. Messages with many reactions load one small request per reaction, so big channels can take a second to fill in."],
      ["Live updates", "When someone adds or removes a reaction, the pictures for that reaction reload by themselves."],
      ["Your own picture", "Turn on Hide my own avatar if you only want to see other people. Your avatar is skipped and the next person takes its place."],
      ["Nothing shows up?", "Turn on Debug capture, open a chat with reactions, then check the diagnostic log below."],
    ] });
    return h(RN.ScrollView, { style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 42 } },
      h(KitHero, { key: "hero", icon: "chat", title: "Show Reaction PFP", subtitle: "See who reacted, right next to the reaction", stats: [["Max avatars", String(s.maxAvatars || 3)], ["Cached", String(cache.size)]] }),
      h(CustomSection, { key: "options", title: "Options" },
        toggle("enabled", "Show reaction avatars", "Show profile pictures next to each reaction.", "power"),
        toggle("hideSelf", "Hide my own avatar", "Skip your own picture and show the next person instead.", "shield"),
        toggle("overlap", "Overlap avatars", "Stack the pictures slightly over each other to save space.", "star", true)),
      h(CustomSection, { key: "look", title: "Appearance" },
        chips("maxAvatars", "Max avatars", "How many pictures to show per reaction.", "chat", [[1, "1"], [2, "2"], [3, "3"]]),
        chips("size", "Avatar size", "Size of each picture.", "paint", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], true)),
      h(CustomSection, { key: "tools", title: "Troubleshooting" },
        toggle("debug", "Debug capture", "Record reaction component props and request results.", "test", true)),
      h(CustomSection, { key: "dbg", title: "Diagnostic log", footer: "Enable Debug capture, open a chat with reactions, then return here. The log is kept until cleared or the plugin reloads." },
        h(RN.View, { style: { padding: 16 } },
          h(RN.Text, { selectable: true, style: { color: C.text, fontSize: 12, lineHeight: 18 } }, debugSeen.size ? Array.from(debugSeen.keys()).join("\n") : "Waiting for plugin startup or a matching component…"),
          h(CustomAction, { title: "Clear log", compact: true, secondary: true, top: 12, onPress: () => { debugSeen.clear(); bump((x) => x + 1); } }))),
      guide,
      h(RN.Text, { style: { color: C.sub, fontSize: 12, textAlign: "center", marginTop: 1, opacity: 0.7 } }, "Show Reaction PFP " + BUILD));
  }

  /* ---- lifecycle ---- */
  function initializeAfterHydration() {
    if (!loadRequested || initialized) return;
    initialized = true;
    const s = cfg();
    recordDebug("BUILD v1.0.3 active; static avatars and keyed reaction updates enabled" );
    const defaults = { enabled: true, hideSelf: false, overlap: true, maxAvatars: 3, size: "medium", debug: false };
    const missing = {};
    for (const k of Object.keys(defaults)) if (s[k] === undefined) missing[k] = defaults[k];
    if (Object.keys(missing).length) rainStore.useStore.getState().updateSettings(missing);
    try { UserStore = findByStoreName("UserStore"); } catch (_) {}
    try { SelectedChannelStore = findByStoreName("SelectedChannelStore"); } catch (_) {}
    try { RestAPI = findByProps("getAPIBaseURL", "get"); } catch (_) {}
    if (!RestAPI) { recordDebug("STARTUP failed: Discord REST module not found"); toast("Show Reaction PFP: Discord request module not found"); return; }
    recordDebug("STARTUP: Discord REST module found");
    if (!patchReactions()) { recordDebug("STARTUP failed: JSX runtime not found"); toast("Show Reaction PFP: could not hook reactions"); return; }
    if (FluxDispatcher) { try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); recordDebug("STARTUP: reaction event listener attached"); } catch (_) { recordDebug("STARTUP: reaction event listener failed"); } }
  }

  function onLoad() {
    loadRequested = true;
    const store = rainStore.useStore;
    if (store.getState()._hasHydrated) { initializeAfterHydration(); return; }
    const checkHydration = (state) => {
      if (!loadRequested || !state._hasHydrated) return;
      if (hydrationUnsubscribe) hydrationUnsubscribe();
      hydrationUnsubscribe = null;
      initializeAfterHydration();
    };
    hydrationUnsubscribe = store.subscribe(checkHydration);
    checkHydration(store.getState());
  }

  function onUnload() {
    loadRequested = false;
    if (hydrationUnsubscribe) { hydrationUnsubscribe(); hydrationUnsubscribe = null; }
    initialized = false;
    for (const u of unpatches.splice(0)) { try { u(); } catch (_) {} }
    subs.clear();
    cache.clear();
    debugSeen.clear();
    debugSubs.clear();
    if (debugNotifyTimer != null) { clearTimeout(debugNotifyTimer); debugNotifyTimer = null; }
    UserStore = null; SelectedChannelStore = null; RestAPI = null;
  }

  return { onLoad, onUnload, settings: Settings };
})();

// Discord evaluates this file as a CommonJS plugin entry.
module.exports = {
  start() { implementation.onLoad(); },
  stop() { implementation.onUnload(); },
  settings: implementation.settings,
};
