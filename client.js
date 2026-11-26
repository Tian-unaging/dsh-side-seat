window.__ModuleLoader__.load({ id: "dsh-side-seat", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/**
 * 旁座 SideSeat —— Client 半边（浏览器）。
 *
 * 手写的 ModuleLoader 包：运行时只依赖浏览器模块表提供的 react，不 import 任何
 * Harness 客户端包的值（类型也不需要），因此不需要构建步骤。
 *
 * 只占 list 槽位（零冲突契约 #2）：
 *   sidebar.footer.action        侧边栏底部「旁座」入口 + 观察中指示点
 *   settings.section             设置 → 旁座（五个控件 + 听写引擎（高级）+ 状态）
 *   shell.overlay                控制面板 / 「旁座此刻在想」兜底卡片
 *   conversation.composer.dock   「正在看你的屏幕 · 也在听 · 已 12 分钟 · 说 3 句 · 暂停」
 *
 * 浏览器半边还负责：系统声音采集（getDisplayMedia 的 audio track）与 L0 音频事件、
 * 朗读（Web Speech speechSynthesis，可打断）。不挂任何键盘 / 鼠标钩子。
 */
"use strict";
var React = require("react");
var h = React.createElement;

var PKG = "dsh-side-seat";
var NS = "side-seat";
var API = "/api/side-seat/";
var CRED_REF = "SIDE_SEAT_ASR_API_KEY";

/* ------------------------------------------------------------------ 文案 */

var ZH = {
  "nav": "旁座",
  "slogan": "看着你的屏幕陪你一起看；你叫它看什么，它就去看一眼。",
  "entry": "旁座",
  "panel.title": "旁座",
  "panel.close": "关闭面板",
  "panel.start": "开始看屏幕",
  "panel.pause": "暂停",
  "panel.resume": "继续",
  "panel.stop": "停止",
  "panel.openSession": "打开旁座会话",
  "panel.overlay": "桌面弹窗",
  "panel.overlayOn": "弹窗已打开；没看到就看屏幕右下角",
  "panel.sessionReady": "旁座会话已就绪；如果没有自动跳转，在左侧会话列表里找「旁座」。",
  "panel.quietOn": "安静看",
  "panel.quietOff": "可以说话",
  "panel.annoying": "有点烦",
  "panel.good": "说得好",
  "panel.settings": "设置 → 旁座",
  "panel.offline": "连不上旁座的宿主半边：",
  "panel.idle": "还没开始看。点「开始看屏幕」后，它才会看你的主屏。",
  "panel.starting": "正在准备截屏……",
  "panel.lastLine": "它刚才说：",
  "panel.budget": "说话预算：每小时 {n} 句；下一句额度约 {m} 分钟后",
  "panel.budgetReady": "说话预算：每小时 {n} 句；现在有 {r} 句额度",
  "status.watching": "正在看你的屏幕",
  "status.paused": "已暂停看屏幕",
  "status.minutes": "已 {n} 分钟",
  "status.spoken": "说 {n} 句",
  "status.quiet": "安静看中",
  "thought.title": "旁座此刻在想",
  "thought.enter": "进入对话",
  "thought.dismiss": "收起",
  "audio.noApi": "当前环境不支持 getDisplayMedia，拿不到系统声音",
  "audio.denied": "拿不到系统声音（宿主拒绝了桌面音频共享），画面不受影响",
  "audio.noTrack": "共享里没有系统声音（选择器里要勾选「共享系统音频」）",
  "audio.ended": "系统声音共享已结束",
  "voice.none": "当前系统没有中文语音，只出文字",
  "settings.title": "旁座",
  "settings.who": "它是谁",
  "settings.whoHint": "用一句人话描述它的性格。写一句话，旁座就换一个人。",
  "settings.voice": "朗读",
  "settings.voice.female": "女",
  "settings.voice.male": "男",
  "settings.voice.off": "关",
  "settings.listen": "听声音",
  "settings.listenHint": "它能不能听见你播放的声音。关掉则只用画面。",
  "settings.freq": "说话频率",
  "settings.mode": "说话模式",
  "settings.modeHint": "先决定这种场合多久说一句，再用下面的频率微调。auto 会按画面自动判断。",
  "settings.mode.auto": "自动",
  "settings.mode.game": "游戏",
  "settings.mode.movie": "观影",
  "settings.mode.browse": "刷视频",
  "settings.mode.daily": "日常",
  "settings.ffmpeg.title": "视频能力（需要 ffmpeg）",
  "settings.ffmpeg.why": "解读本地视频、做 caption、写观后感都要 ffmpeg 解码；看屏幕和实时陪看不需要它。安装会下载约 70–100MB 的 LGPL 构建到插件数据目录，不写进插件包。",
  "settings.ffmpeg.install": "安装 ffmpeg",
  "settings.ffmpeg.ok": "已安装，视频能力可用",
  "settings.ffmpeg.missing": "未安装：视频文件相关功能不可用",
  "settings.ffmpeg.unknown": "状态未知",
  "settings.ffmpeg.downloading": "正在下载",
  "settings.ffmpeg.extracting": "正在解压",
  "settings.ffmpeg.done": "安装完成",
  "settings.ffmpeg.error": "安装失败",
  "settings.gender": "性格性别",
  "settings.genderHint": "只影响它怎么说话，和朗读音色无关。",
  "settings.gender.male": "男生",
  "settings.gender.female": "女生",
  "settings.gender.none": "不设定",
  "settings.voice": "朗读音色",
  "settings.voiceHint": "只影响它念出来的声音；选「关」则只出文字。",
  "settings.freq.quiet": "安静",
  "settings.freq.normal": "正常",
  "settings.freq.chatty": "话多",
  "settings.scope": "观察范围",
  "settings.scope.screen": "整个主屏",
  "settings.scope.window": "当前窗口（P1，暂按主屏）",
  "settings.save": "保存",
  "settings.saving": "保存中……",
  "settings.saved": "已保存",
  "settings.saveFailed": "保存失败：",
  "settings.reset": "放弃修改",
  "settings.fallback": "宿主没有把 side-seat 设置命名空间暴露给浏览器，设置改存到 $DSH_HOME/plugins-data/side-seat/settings.json。",
  "settings.advanced": "听写引擎（高级）",
  "settings.engine": "引擎",
  "settings.engine.none": "无（只听声音事件，听不见台词）",
  "settings.engine.builtin": "DSH 内置",
  "settings.engine.openai": "OpenAI 兼容（云端）",
  "settings.engine.command": "自定义命令",
  "settings.baseUrl": "接口地址",
  "settings.baseUrlHint": "形如 https://api.example.com/v1，自动补 /audio/transcriptions",
  "settings.model": "模型名",
  "settings.key": "密钥",
  "settings.keyHint": "不写进设置文件，写入 DSH 凭据服务；这里只显示是否已配置。",
  "settings.keySave": "保存密钥",
  "settings.keyConfigured": "已配置",
  "settings.keyMissing": "未配置",
  "settings.language": "语言",
  "settings.language.auto": "自动",
  "settings.language.zh": "中文",
  "settings.language.en": "英文",
  "settings.command": "命令",
  "settings.commandHint": "一行命令模板，含 {wav} 与 {out}，例如：whisper-cli -m ggml-small.bin -l zh -osrt -of {out} {wav}",
  "settings.test": "试一下",
  "settings.testing": "识别中……",
  "settings.testSaveFirst": "先保存再试",
  "settings.testOk": "识别出：",
  "settings.testFail": "失败：",
  "settings.cloudConfirm": "选择云端引擎后，之后你播放的声音片段会上传到该地址做转写（只在检测到人声时上传那 3–5 秒）。确定吗？",
  "settings.status": "状态",
  "settings.recheck": "重新检测",
  "settings.clear": "清除全部记忆",
  "settings.clearConfirm": "确定清除旁座的全部记忆（口味、观点、关系、共同经历、沉默记录）？此操作不可撤销。",
  "settings.cleared": "已删除 {n} 条记忆",
  "diag.capture": "截屏后端",
  "diag.model": "视觉模型",
  "diag.audio": "系统声音",
  "diag.asr": "听写",
  "diag.speak": "主动发言路径",
  "diag.version": "Harness 版本",
  "diag.bridge": "宿主通路",
  "diag.memory": "记忆存储",
  "diag.voice": "中文语音",
  "diag.ffmpeg": "ffmpeg（只有解读视频文件需要）",
  "diag.unknown": "未检测",
  "diag.yes": "有",
  "diag.no": "没有"
};

var EN = {
  "nav": "SideSeat",
  "slogan": "Watches your screen with you, and looks at whatever you ask.",
  "entry": "SideSeat",
  "panel.title": "SideSeat",
  "panel.close": "Close panel",
  "panel.start": "Start watching screen",
  "panel.pause": "Pause",
  "panel.resume": "Resume",
  "panel.stop": "Stop",
  "panel.openSession": "Open SideSeat session",
  "panel.sessionReady": "The SideSeat session is ready; if it did not open, find “旁座” in the session list.",
  "panel.quietOn": "Quiet",
  "panel.quietOff": "Allow talking",
  "panel.annoying": "A bit annoying",
  "panel.good": "Nice one",
  "panel.settings": "Settings → SideSeat",
  "panel.offline": "Cannot reach the SideSeat host half: ",
  "panel.idle": "Not watching. It only looks at your screen after you press Start.",
  "panel.starting": "Preparing screen capture…",
  "panel.lastLine": "It just said:",
  "panel.budget": "Talk budget: {n}/hour; next line in about {m} min",
  "panel.budgetReady": "Talk budget: {n}/hour; {r} line(s) available",
  "status.watching": "Watching your screen",
  "status.paused": "Paused",
  "status.minutes": "{n} min",
  "status.spoken": "{n} said",
  "status.quiet": "quiet mode",
  "thought.title": "SideSeat is thinking",
  "thought.enter": "Open chat",
  "thought.dismiss": "Dismiss",
  "audio.noApi": "getDisplayMedia is not available here; system audio cannot be captured",
  "audio.denied": "System audio unavailable (the host refused desktop audio sharing); screen capture is unaffected",
  "audio.noTrack": "No system audio in the share (tick “Share system audio”)",
  "audio.ended": "System audio sharing ended",
  "voice.none": "No Chinese voice on this system; text only",
  "settings.title": "SideSeat",
  "settings.who": "Who it is",
  "settings.whoHint": "Describe its personality in one sentence.",
  "settings.voice": "Read aloud",
  "settings.voice.female": "Female",
  "settings.voice.male": "Male",
  "settings.voice.off": "Off",
  "settings.listen": "Listen to sound",
  "settings.listenHint": "Whether it can hear what you are playing. Off = picture only.",
  "settings.freq": "Talkativeness",
  "settings.mode": "Speaking mode",
  "settings.modeHint": "How often talking feels natural here; the frequency below fine-tunes it. auto follows what is on screen.",
  "settings.mode.auto": "Auto",
  "settings.mode.game": "Gaming",
  "settings.mode.movie": "Watching",
  "settings.mode.browse": "Short video",
  "settings.mode.daily": "Daily",
  "settings.ffmpeg.title": "Video features (require ffmpeg)",
  "settings.ffmpeg.why": "Reading local video files, captioning, and reviews need ffmpeg to decode; screen watching does not. Installing downloads a ~70-100MB LGPL build into the plugin data directory, not the plugin package.",
  "settings.ffmpeg.install": "Install ffmpeg",
  "settings.ffmpeg.ok": "Installed — video features available",
  "settings.ffmpeg.missing": "Not installed — local video features are unavailable",
  "settings.ffmpeg.unknown": "Unknown",
  "settings.ffmpeg.downloading": "Downloading",
  "settings.ffmpeg.extracting": "Extracting",
  "settings.ffmpeg.done": "Installed",
  "settings.ffmpeg.error": "Install failed",
  "settings.gender": "Persona gender",
  "settings.genderHint": "How it speaks only — unrelated to the spoken voice.",
  "settings.gender.male": "Male",
  "settings.gender.female": "Female",
  "settings.gender.none": "Unspecified",
  "settings.voice": "Spoken voice",
  "settings.voiceHint": "The voice it reads lines with; off = text only.",
  "settings.freq.quiet": "Quiet",
  "settings.freq.normal": "Normal",
  "settings.freq.chatty": "Chatty",
  "settings.scope": "Scope",
  "settings.scope.screen": "Whole primary screen",
  "settings.scope.window": "Current window (P1, uses screen)",
  "settings.save": "Save",
  "settings.saving": "Saving…",
  "settings.saved": "Saved",
  "settings.saveFailed": "Save failed: ",
  "settings.reset": "Discard",
  "settings.fallback": "The host did not expose the side-seat settings namespace; settings are stored in $DSH_HOME/plugins-data/side-seat/settings.json.",
  "settings.advanced": "Dictation engine (advanced)",
  "settings.engine": "Engine",
  "settings.engine.none": "None (sound events only, no dialogue)",
  "settings.engine.builtin": "DSH built-in",
  "settings.engine.openai": "OpenAI-compatible (cloud)",
  "settings.engine.command": "Custom command",
  "settings.baseUrl": "Base URL",
  "settings.baseUrlHint": "e.g. https://api.example.com/v1 (/audio/transcriptions is appended)",
  "settings.model": "Model",
  "settings.key": "API key",
  "settings.keyHint": "Stored in DSH credentials, never in settings. Only its status is shown.",
  "settings.keySave": "Save key",
  "settings.keyConfigured": "Configured",
  "settings.keyMissing": "Not configured",
  "settings.language": "Language",
  "settings.language.auto": "Auto",
  "settings.language.zh": "Chinese",
  "settings.language.en": "English",
  "settings.command": "Command",
  "settings.commandHint": "One-line template with {wav} and {out}",
  "settings.test": "Try it",
  "settings.testing": "Recognizing…",
  "settings.testSaveFirst": "Save first",
  "settings.testOk": "Recognized: ",
  "settings.testFail": "Failed: ",
  "settings.cloudConfirm": "With a cloud engine, clips of the sound you play will be uploaded to that address (only 3–5 s clips when speech is detected). Continue?",
  "settings.status": "Status",
  "settings.recheck": "Re-check",
  "settings.clear": "Clear all memory",
  "settings.clearConfirm": "Delete all SideSeat memory? This cannot be undone.",
  "settings.cleared": "Deleted {n} records",
  "diag.capture": "Capture backend",
  "diag.model": "Vision model",
  "diag.audio": "System audio",
  "diag.asr": "Dictation",
  "diag.speak": "Proactive speech path",
  "diag.version": "Harness version",
  "diag.bridge": "Host bridge",
  "diag.memory": "Memory storage",
  "diag.voice": "Chinese voice",
  "diag.ffmpeg": "ffmpeg (only for video files)",
  "diag.unknown": "not checked",
  "diag.yes": "yes",
  "diag.no": "no"
};

function lang() {
  try { return String(navigator.language || "zh").toLowerCase().indexOf("zh") === 0 ? "zh" : "en"; } catch (e) { return "zh"; }
}
function t(key, vars) {
  var dict = lang() === "zh" ? ZH : EN;
  var s = dict[key] != null ? dict[key] : (ZH[key] != null ? ZH[key] : key);
  if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
  return s;
}

/* ------------------------------------------------------------------ 小工具 */

function safeGet(ctx, name) {
  try { var v = ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined; return v == null ? null : v; } catch (e) { return null; }
}
function errText(e) { return String((e && (e.message || e.name)) || e || "error"); }

function createStore(initial) {
  var state = initial;
  var listeners = new Set();
  return {
    get: function () { return state; },
    set: function (patch) {
      var next = typeof patch === "function" ? patch(state) : patch;
      state = Object.assign({}, state, next);
      listeners.forEach(function (l) { try { l(); } catch (e) { /* ignore */ } });
    },
    subscribe: function (l) { listeners.add(l); return function () { listeners.delete(l); }; }
  };
}
function useStore(store) { return React.useSyncExternalStore(store.subscribe, store.get, store.get); }

var host = createStore({ state: null, connected: null, error: "", diag: null, settings: null, schemaAvailable: true, opening: null, ffmpeg: null });
var ui = createStore({ panelOpen: false, intent: "off", busy: false, message: "", sessionId: null, dismissedThought: null, voiceMissing: false, openedAt: 0 });
var runtime = { ctx: null, altFetch: null, pinnedAlt: false, disposed: false };

/* ------------------------------------------------------------------ 通路 */

async function api(path, opts) {
  var o = opts || {};
  var init = { method: o.method || "GET", headers: { "x-side-seat": "1" }, credentials: "same-origin" };
  if (o.json !== undefined) { init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(o.json); }
  if (o.binary) { init.method = "POST"; init.headers["Content-Type"] = o.type || "application/octet-stream"; init.body = o.binary; }
  var url = API + path + (o.query ? "?" + new URLSearchParams(o.query).toString() : "");
  var res;
  try {
    res = await (runtime.pinnedAlt && runtime.altFetch ? runtime.altFetch(url, init) : window.fetch(url, init));
  } catch (e) {
    // Desktop 壳若经 IPC 承载 fetch，退到 Connection 提供的 fetch（若有）
    if (runtime.altFetch && !runtime.pinnedAlt) { runtime.pinnedAlt = true; res = await runtime.altFetch(url, init); }
    else throw e;
  }
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body ? (body.error || "error") + (body.reason ? " (" + body.reason + ")" : "") : "HTTP " + res.status);
  }
  return body;
}

/* ------------------------------------------------------------------ 朗读（Web Speech） */

var tts = { lastId: null, primed: false, speaking: false, lastUserAt: 0 };

function zhVoices() {
  try { return window.speechSynthesis.getVoices().filter(function (v) { return /^zh/i.test(v.lang); }); } catch (e) { return []; }
}
function pickVoice(gender) {
  var vs = zhVoices();
  if (!vs.length) return null;
  var fem = /Huihui|Xiaoxiao|Xiaoyi|Yaoyao|Female|女/i;
  var male = /Yunxi|Yunyang|Kangkang|Yunjian|Male|男/i;
  var re = gender === "male" ? male : fem;
  return vs.find(function (v) { return re.test(v.name); }) || vs[0];
}
function cancelSpeech() {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  if (tts.speaking) { tts.speaking = false; api("speaking", { json: { active: false } }).catch(function () {}); }
}
function speakLine(line, gender) {
  if (!("speechSynthesis" in window) || gender === "off") return;
  var voice = pickVoice(gender);
  if (!voice) { ui.set({ voiceMissing: true }); return; }
  var u = new SpeechSynthesisUtterance(line);
  u.voice = voice;
  u.lang = voice.lang || "zh-CN";
  u.rate = 1.05;
  u.pitch = gender === "male" ? 0.92 : 1.0;
  u.onstart = function () { tts.speaking = true; audio.self = true; api("speaking", { json: { active: true } }).catch(function () {}); };
  u.onend = u.onerror = function () { tts.speaking = false; audio.self = false; api("speaking", { json: { active: false } }).catch(function () {}); };
  try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ 系统声音 + L0 */

var audio = { stream: null, ac: null, src: null, proc: null, gain: null, rate: 48000, acc: [], accLen: 0, events: [], flushTimer: null, self: false, paused: false, segmenter: null, ok: false, reason: "" };

function analyzePcm(samples, rate) {
  var n = samples.length;
  if (!n) return { rmsDb: -120, zcr: 0, mod: 0, onsets: 0, kind: "silence", pauseMs: 1000 };
  var sum = 0, crossings = 0, i, j;
  for (i = 0; i < n; i++) { var s = samples[i]; sum += s * s; if (i && (s >= 0) !== (samples[i - 1] >= 0)) crossings++; }
  var rms = Math.sqrt(sum / n);
  var rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;
  var zcr = crossings / n;
  var frame = Math.max(1, Math.round(rate * 0.05));
  var energies = [];
  for (i = 0; i + frame <= n; i += frame) { var e = 0; for (j = i; j < i + frame; j++) e += samples[j] * samples[j]; energies.push(e / frame); }
  var mean = energies.reduce(function (a, b) { return a + b; }, 0) / (energies.length || 1);
  var variance = energies.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (energies.length || 1);
  var mod = mean > 0 ? Math.sqrt(variance) / mean : 0;
  var onsets = 0, quiet = 0;
  for (i = 1; i < energies.length; i++) {
    if (energies[i] > energies[i - 1] * 4 && energies[i] > 1e-5) onsets++;
    var db = energies[i] > 0 ? 10 * Math.log10(energies[i]) : -120;
    if (db < -45) quiet++;
  }
  var kind = rmsDb < -50 ? "silence" : (mod > 0.7 && zcr > 0.01 && zcr < 0.2) ? "speech" : mod < 0.45 ? "music" : "mixed";
  return { rmsDb: rmsDb, zcr: zcr, mod: mod, onsets: onsets, kind: kind, pauseMs: quiet * 50 };
}

function downsample16k(f32, rate) {
  var ratio = rate / 16000;
  var outLen = Math.floor(f32.length / ratio);
  var out = new Int16Array(outLen);
  for (var i = 0; i < outLen; i++) {
    var a = Math.floor(i * ratio), b = Math.min(f32.length, Math.floor((i + 1) * ratio));
    var s = 0, c = 0;
    for (var k = a; k < b; k++) { s += f32[k]; c++; }
    var v = c ? s / c : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

function wavOf(int16) {
  var buf = new ArrayBuffer(44 + int16.length * 2);
  var dv = new DataView(buf);
  var w = function (o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + int16.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data");
  dv.setUint32(40, int16.length * 2, true);
  new Int16Array(buf, 44).set(int16);
  return new Uint8Array(buf);
}

/** 与 host 端 SpeechSegmenter 同一套规则：3–5 秒，停顿处切，不在词中间切。 */
function createSegmenter(onSegment) {
  var seg = { buf: [], len: 0, t0: 0, active: false };
  function reset() { seg.active = false; seg.buf = []; seg.len = 0; }
  function flush() {
    if (seg.len >= 16000 * 1.5) {
      var pcm = new Int16Array(seg.len), off = 0;
      seg.buf.forEach(function (c) { pcm.set(c, off); off += c.length; });
      onSegment(pcm, seg.t0);
    }
    reset();
  }
  return {
    push: function (chunk, summary, t, self) {
      if (self) { reset(); return; }
      var voiced = summary.kind === "speech" || summary.kind === "mixed";
      if (!seg.active && voiced) { seg.active = true; seg.t0 = t; seg.buf = []; seg.len = 0; }
      if (!seg.active) return;
      seg.buf.push(chunk); seg.len += chunk.length;
      var sec = seg.len / 16000;
      var paused = summary.pauseMs >= 350 || summary.kind === "silence";
      if ((sec >= 3 && paused) || sec >= 5) flush();
      else if (!voiced && sec < 1.5) reset();
    },
    reset: reset
  };
}

function onSamples(f32) {
  if (audio.paused) return;
  audio.acc.push(new Float32Array(f32));
  audio.accLen += f32.length;
  while (audio.accLen >= audio.rate) {
    var sec = new Float32Array(audio.rate), off = 0;
    while (off < audio.rate) {
      var head = audio.acc[0], need = audio.rate - off;
      if (head.length <= need) { sec.set(head, off); off += head.length; audio.acc.shift(); }
      else { sec.set(head.subarray(0, need), off); audio.acc[0] = head.subarray(need); off += need; }
    }
    audio.accLen -= audio.rate;
    var summary = analyzePcm(sec, audio.rate);
    var now = Date.now();
    var self = audio.self || tts.speaking;
    audio.events.push({ t: now, rmsDb: summary.rmsDb, zcr: summary.zcr, mod: summary.mod, onsets: summary.onsets, kind: summary.kind, pauseMs: summary.pauseMs, self: self });
    if (audio.segmenter) audio.segmenter.push(downsample16k(sec, audio.rate), summary, now, self);
  }
}

function flushEvents() {
  if (!audio.events.length) return;
  var batch = audio.events.splice(0, audio.events.length);
  api("audio-events", { json: { events: batch } }).catch(function () {});
}

async function startAudio() {
  if (audio.stream) return { ok: true };
  var md = navigator.mediaDevices;
  if (!md || typeof md.getDisplayMedia !== "function") return { ok: false, reason: t("audio.noApi") };
  var stream;
  try {
    stream = await md.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude"
    });
  } catch (e) {
    return { ok: false, reason: t("audio.denied") + "：" + errText(e) };
  }
  var tracks = stream.getAudioTracks();
  if (!tracks.length) { stream.getTracks().forEach(function (tr) { tr.stop(); }); return { ok: false, reason: t("audio.noTrack") }; }
  // 画面轨不用（截屏走 host），但保留它：浏览器自己的「正在共享」提示也是一种可见性
  stream.getVideoTracks().forEach(function (tr) { tr.enabled = false; });
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    audio.ac = new AC();
    audio.rate = audio.ac.sampleRate;
    audio.src = audio.ac.createMediaStreamSource(new MediaStream([tracks[0]]));
    audio.proc = audio.ac.createScriptProcessor(4096, 1, 1);
    audio.gain = audio.ac.createGain();
    audio.gain.gain.value = 0; // 只分析，不回放（否则就是自激回声）
    audio.src.connect(audio.proc); audio.proc.connect(audio.gain); audio.gain.connect(audio.ac.destination);
    audio.proc.onaudioprocess = function (e) { onSamples(e.inputBuffer.getChannelData(0)); };
  } catch (e) {
    stream.getTracks().forEach(function (tr) { tr.stop(); });
    return { ok: false, reason: errText(e) };
  }
  audio.stream = stream;
  audio.acc = []; audio.accLen = 0; audio.events = []; audio.paused = false;
  audio.segmenter = createSegmenter(function (pcm, t0) {
    var st = host.get().state;
    if (!st || !st.audio || !st.audio.engineReady || audio.self || tts.speaking) return; // 没有引擎 / 正在朗读：不送
    api("audio-segment", { binary: wavOf(pcm), type: "audio/wav", query: { t0: String(t0) } }).catch(function () {});
  });
  tracks[0].onended = function () { stopAudio(); api("audio-report", { json: { ok: false, reason: t("audio.ended") } }).catch(function () {}); };
  audio.flushTimer = setInterval(flushEvents, 1000);
  return { ok: true };
}

function stopAudio() {
  if (audio.flushTimer) { clearInterval(audio.flushTimer); audio.flushTimer = null; }
  try { if (audio.proc) audio.proc.onaudioprocess = null; } catch (e) { /* ignore */ }
  try { if (audio.src) audio.src.disconnect(); } catch (e) { /* ignore */ }
  try { if (audio.proc) audio.proc.disconnect(); } catch (e) { /* ignore */ }
  try { if (audio.gain) audio.gain.disconnect(); } catch (e) { /* ignore */ }
  try { if (audio.ac) audio.ac.close(); } catch (e) { /* ignore */ }
  try { if (audio.stream) audio.stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) { /* ignore */ }
  audio.stream = audio.ac = audio.src = audio.proc = audio.gain = null;
  audio.acc = []; audio.accLen = 0; audio.events = []; audio.segmenter = null;
}

/* ------------------------------------------------------------------ 轮询宿主状态 */

var poll = { timer: null, active: false };

function onState(st) {
  if (!st) return;
  // 朗读：只念新句子；页面加载时已有的旧句子不念
  var last = st.lastLine;
  if (!tts.primed) { tts.primed = true; tts.lastId = last ? last.id : null; tts.lastUserAt = st.userSpokeAt || 0; }
  else if (last && last.id !== tts.lastId) {
    tts.lastId = last.id;
    if (st.status === "on") speakLine(last.line, st.voice);
  }
  // 用户一发消息立刻停止朗读，不把上一句念完
  if ((st.userSpokeAt || 0) > tts.lastUserAt) { tts.lastUserAt = st.userSpokeAt; cancelSpeech(); }
  // 暂停 / 停止时同步声音采集
  audio.paused = st.status !== "on";
  if ((st.status === "off" || st.status === "error") && audio.stream) stopAudio();
  if (st.status === "off" || st.status === "error") { if (ui.get().intent === "on" && !ui.get().busy) ui.set({ intent: "off" }); }
}

async function loop() {
  if (!poll.active || runtime.disposed) return;
  try {
    var b = await api("state");
    host.set({ state: b.state, opening: b.opening || null, ffmpeg: b.ffmpeg || null, connected: true, error: "" });
    onState(b.state);
  } catch (e) {
    host.set({ connected: false, error: errText(e) });
  }
  var st = host.get().state;
  var delay = tts.speaking ? 400 : (ui.get().panelOpen || (st && st.observing) || ui.get().intent === "on") ? 1000 : 5000;
  poll.timer = setTimeout(loop, delay);
}
function startPolling() { if (poll.active) return; poll.active = true; loop(); }
function stopPolling() { poll.active = false; if (poll.timer) clearTimeout(poll.timer); poll.timer = null; }
function kick() { if (poll.timer) clearTimeout(poll.timer); poll.timer = null; loop(); }

async function loadSettings() {
  try { var b = await api("settings"); host.set({ settings: b.settings, schemaAvailable: b.schemaAvailable !== false }); return b.settings; }
  catch (e) { return host.get().settings; }
}
async function loadDiag() {
  try { var b = await api("diag"); host.set({ diag: b.diag }); return b.diag; } catch (e) { host.set({ error: errText(e) }); return null; }
}

/* ------------------------------------------------------------------ 动作 */

function openSessionInUi(id) {
  var ctx = runtime.ctx;
  // 真实契约（本机 client 服务目录核实）：在界面里打开会话是 ctx.uiWorkspace.openSession(target)。
  // ctx.sessions 只是 retain/headless，没有 open / select ——
  // 原先那串候选方法一个都不存在，于是会话建出来了、界面却没跳过去，用户看到的就是「点了没反应」。
  var candidates = [
    ["uiWorkspace", "openSession"],
    ["workspace", "openSession"],
    ["sessions", "open"],
    ["sessions", "select"],
    ["navigation", "openSession"],
    ["layout", "openSession"]
  ];
  for (var i = 0; i < candidates.length; i++) {
    var s = safeGet(ctx, candidates[i][0]);
    var m = candidates[i][1];
    if (s && typeof s[m] === "function") {
      try { s[m](id); return candidates[i][0] + "." + m; } catch (e) { /* next */ }
    }
  }
  return null;
}

async function ensureSession() {
  try {
    var b = await api("session-open", { json: {} });
    var id = b.session && b.session.sessionId;
    ui.set({ sessionId: id });
    var how = id ? openSessionInUi(id) : null;
    if (id) ui.set({ openedAt: Date.now() });
    if (!how) ui.set({ message: t("panel.sessionReady") });
    return id;
  } catch (e) {
    ui.set({ message: errText(e) });
    return null;
  }
}

async function openOverlay() {
  try {
    await api("overlay-open", { json: {} });
    ui.set({ message: t("panel.overlayOn") });
  } catch (e) {
    ui.set({ message: errText(e) });
  }
}

function ffmpegBusy(ff) {
  return Boolean(ff && (ff.phase === "downloading" || ff.phase === "extracting"));
}

function ffmpegLine(ff) {
  if (!ff) return t("settings.ffmpeg.unknown");
  if (ff.phase === "downloading") {
    var pct = ff.total ? Math.round((ff.got / ff.total) * 100) + "%" : Math.round((ff.got || 0) / 1048576) + "MB";
    return t("settings.ffmpeg.downloading") + " " + pct;
  }
  if (ff.phase === "extracting") return t("settings.ffmpeg.extracting");
  if (ff.phase === "error") return t("settings.ffmpeg.error") + "：" + (ff.error || "");
  if (ff.installed) return t("settings.ffmpeg.ok");
  if (ff.phase === "done") return t("settings.ffmpeg.done");
  return t("settings.ffmpeg.missing");
}

async function installFfmpegNow() {
  try { await api("ffmpeg-install", { json: {} }); kick(); } catch (e) { ui.set({ message: errText(e) }); }
}

function startObserving() {
  // getDisplayMedia 需要用户手势：在任何 await 之前先发起
  var settings = host.get().settings;
  var wantAudio = !settings || settings.listen !== false;
  var audioP = wantAudio ? startAudio() : Promise.resolve(null);
  ui.set({ intent: "on", busy: true, message: "" });
  (async function () {
    await ensureSession();
    var started = null;
    try { started = (await api("observe", { json: { action: "start" } })).state; } catch (e) { ui.set({ message: errText(e) }); }
    var a = await audioP;
    if (started && started.status === "on") {
      if (a) await api("audio-report", { json: { ok: a.ok, reason: a.reason || "" } }).catch(function () {});
    } else {
      stopAudio();
      ui.set({ intent: "off", message: (started && started.reason) || ui.get().message });
    }
    if (started) host.set({ state: started });
    ui.set({ busy: false });
    kick();
  })();
}

async function control(action) {
  if (action === "stop") {
    // 停止后指示点立刻消失：先改本地状态，再告诉宿主
    ui.set({ intent: "off" });
    var cur = host.get().state;
    if (cur) host.set({ state: Object.assign({}, cur, { status: "off", observing: false }) });
    stopAudio();
    cancelSpeech();
  }
  if (action === "pause") cancelSpeech();
  try { var b = await api("observe", { json: { action: action } }); host.set({ state: b.state }); } catch (e) { ui.set({ message: errText(e) }); }
  kick();
}

async function feedback(kind, lineId) {
  try { var b = await api("feedback", { json: { kind: kind, lineId: lineId } }); host.set({ state: b.state }); } catch (e) { ui.set({ message: errText(e) }); }
}
async function setQuiet(on) {
  try { var b = await api("quiet", { json: { on: on } }); host.set({ state: b.state }); } catch (e) { ui.set({ message: errText(e) }); }
}

/* ------------------------------------------------------------------ 样式（只用主题令牌，带系统色兜底） */

var CSS = [
  ".ss-foot{display:flex;align-items:center;gap:8px;width:100%;height:42px;padding:0 12px;border:0;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:20px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;position:relative}",
  ".ss-foot:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
  ".ss-foot-rail{width:36px;height:36px;padding:0;justify-content:center;margin:0 auto}",
  ".ss-foot svg{flex:none}",
  ".ss-dot{position:absolute;left:24px;top:8px;width:8px;height:8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-status-danger,#e5484d);box-shadow:0 0 0 2px var(--dsw-alias-bg-canvas,Canvas)}",
  ".ss-rowmark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-text-secondary,GrayText)}",
  ".ss-opening{display:flex;gap:8px;align-items:center;margin:0 0 8px;padding:8px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);font-size:13px;line-height:20px;box-shadow:var(--dsw-elevation-panel,0 2px 10px rgba(0,0,0,.10))}",
  ".ss-foot-rail .ss-dot{left:22px;top:4px}",
  ".ss-dot-paused{background:var(--dsw-alias-status-warning,#f5a623)}",
  ".ss-layer{position:fixed;inset:0;pointer-events:none;z-index:40}",
  ".ss-panel{pointer-events:auto;position:fixed;left:16px;bottom:64px;width:340px;max-width:calc(100vw - 32px);max-height:calc(100vh - 96px);overflow:auto;padding:14px 16px;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.18));font-size:13px;line-height:20px}",
  ".ss-panel h3{margin:0 0 2px;font-size:16px;line-height:24px}",
  ".ss-muted{color:var(--dsw-alias-text-secondary,GrayText);font-size:12px;line-height:18px}",
  ".ss-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}",
  ".ss-btn{border:0.5px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.35));background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;padding:4px 10px;border-radius:var(--dsw-radius-md,8px);cursor:pointer}",
  ".ss-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
  ".ss-btn:disabled{opacity:.45;cursor:default}",
  ".ss-btn-primary{background:var(--dsw-alias-interactive-bg-accent,#3b82f6);color:var(--dsw-alias-text-on-accent,#fff);border:0}",
  ".ss-close{position:absolute;right:10px;top:8px}",
  ".ss-status{margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.08))}",
  ".ss-error{color:var(--dsw-alias-status-danger,#e5484d)}",
  ".ss-line{margin-top:8px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.35))}",
  ".ss-strip{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;padding:2px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-text-secondary,GrayText)}",
  ".ss-strip b{font-weight:600;color:var(--dsw-alias-text-primary,CanvasText)}",
  ".ss-strip .ss-dot-inline{width:6px;height:6px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-status-danger,#e5484d);display:inline-block}",
  ".ss-link{border:0;background:transparent;color:var(--dsw-alias-text-link,LinkText);font:inherit;font-size:12px;line-height:18px;padding:0 2px;cursor:pointer}",
  ".ss-thought{pointer-events:auto;position:fixed;left:50%;bottom:120px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));padding:10px 14px;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.18));font-size:14px;line-height:22px}",
  ".ss-settings{max-width:720px;font-size:14px;line-height:22px}",
  ".ss-settings h2{font-size:16px;line-height:24px;margin:0 0 4px}",
  ".ss-field{display:grid;grid-template-columns:minmax(0,160px) minmax(0,1fr);gap:8px 16px;align-items:start;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.25))}",
  ".ss-field>*{min-width:0}",
  ".ss-field label{font-weight:500}",
  ".ss-field textarea,.ss-field input[type=text],.ss-field input[type=password],.ss-field select{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-input,Field);color:var(--dsw-alias-text-primary,FieldText)}",
  ".ss-radios{display:flex;flex-wrap:wrap;gap:12px}",
  ".ss-radios label{font-weight:400;display:inline-flex;gap:4px;align-items:center}",
  ".ss-details{margin-top:16px}",
  ".ss-details summary{cursor:pointer;font-weight:500}",
  ".ss-diag{display:grid;grid-template-columns:minmax(0,180px) minmax(0,1fr);gap:4px 16px;font-size:13px;line-height:20px;margin-top:8px}",
  ".ss-diag>*{min-width:0;overflow-wrap:anywhere}"
].join("\n");

function injectStyles() {
  var el = document.createElement("style");
  el.setAttribute("data-plugin", PKG);
  el.textContent = CSS;
  document.head.appendChild(el);
  return function () { try { el.remove(); } catch (e) { /* ignore */ } };
}

/* ------------------------------------------------------------------ 图标：一张并排的空椅子（侧视） */

function ChairIcon(props) {
  var size = (props && props.size) || 18;
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    h("path", { d: "M7 3v10" }),
    h("path", { d: "M7 13h10" }),
    h("path", { d: "M7 13l-1 8" }),
    h("path", { d: "M17 13l1 8" }),
    h("path", { d: "M7 6.5c1.5-.6 2.8-.6 4 0" })
  );
}

/* ------------------------------------------------------------------ 视图辅助 */

/**
 * 侧边栏会话行前的椅子图标：只挂在旁座自己的那个会话上。
 * 真实契约：sidebar.session.row.leading 的 ownerProps 是 { sessionId }，
 * 所以能精确只给自己的会话加标记，不碰别人的行。
 */
function SessionRowMark(props) {
  var u = useStore(ui);
  var sid = props && props.sessionId;
  if (!sid || !u.sessionId) return null;
  if (String(sid) !== String(u.sessionId)) return null;
  return h("span", { className: "ss-rowmark", title: t("nav"), "aria-label": t("nav") }, h(ChairIcon, { size: 14 }));
}

function isObserving(st, u) {
  if (u.intent === "on" && u.busy) return true;
  return Boolean(st && (st.status === "on" || st.status === "paused" || st.status === "starting"));
}

function statusParts(st) {
  var parts = [];
  parts.push(st.status === "paused" ? t("status.paused") : t("status.watching"));
  parts.push(st.audio && st.audio.label ? st.audio.label : "听不见台词");
  if (st.budget && st.budget.mode) parts.push(t("settings.mode." + st.budget.mode));
  parts.push(t("status.minutes", { n: st.activeMinutes || 0 }));
  parts.push(t("status.spoken", { n: st.spoken || 0 }));
  if (st.quietMode) parts.push(t("status.quiet"));
  return parts;
}

/* ------------------------------------------------------------------ 侧边栏入口 */

function SidebarAction(props) {
  var hs = useStore(host);
  var u = useStore(ui);
  var st = hs.state;
  var on = isObserving(st, u);
  var paused = st && st.status === "paused";
  var label = t("entry");
  return h("button", {
    type: "button",
    className: props.wide ? "ss-foot" : "ss-foot ss-foot-rail",
    "aria-label": on ? label + " · " + t("status.watching") : label,
    "aria-expanded": u.panelOpen,
    title: on ? statusParts(st || { status: "on" }).join(" · ") : t("slogan"),
    onClick: function () {
      var open = !ui.get().panelOpen;
      ui.set({ panelOpen: open, message: "" });
      // 打开面板本身不建会话：只想看一眼状态的人，不该在侧边栏多出一个空会话。
      // 建会话留给「打开旁座会话」按钮和「开始看屏幕」（startObserving 里也会 ensureSession）。
      if (open) { loadSettings(); kick(); }
    }
  },
    h(ChairIcon, null),
    on ? h("span", { className: paused ? "ss-dot ss-dot-paused" : "ss-dot", "aria-hidden": "true" }) : null,
    props.wide ? h("span", null, label) : null
  );
}

/* ------------------------------------------------------------------ 控制面板 + 兜底卡片 */

function Panel() {
  var hs = useStore(host);
  var u = useStore(ui);
  var st = hs.state;
  React.useEffect(function () {
    var onKey = function (e) { if (e.key === "Escape") ui.set({ panelOpen: false }); };
    document.addEventListener("keydown", onKey);
    return function () { document.removeEventListener("keydown", onKey); };
  }, []);
  var status = st ? st.status : "off";
  var observing = isObserving(st, u);
  var lines = (st && st.lines) || [];
  var last = lines.length ? lines[lines.length - 1] : null;
  var recent = last && Date.now() - last.t < 5 * 60 * 1000 && !last.feedback;
  var body = [];
  if (hs.connected === false) body.push(h("p", { key: "off", className: "ss-error" }, t("panel.offline") + hs.error));
  if (u.busy) body.push(h("p", { key: "busy", className: "ss-muted" }, t("panel.starting")));
  else if (!observing) body.push(h("p", { key: "idle", className: "ss-muted" }, t("panel.idle")));
  if (observing && st) {
    body.push(h("div", { key: "st", className: "ss-status" },
      h("div", null, statusParts(st).join(" · ")),
      st.audio && st.audio.reason ? h("div", { className: "ss-muted" }, st.audio.reason) : null,
      st.budget ? h("div", { className: "ss-muted" }, st.budget.remaining > 0
        ? t("panel.budgetReady", { n: st.budget.perHour, r: st.budget.remaining })
        : t("panel.budget", { n: st.budget.perHour, m: Math.max(1, Math.round(st.budget.nextCreditInMs / 60000)) })) : null,
      st.capture && st.capture.label ? h("div", { className: "ss-muted" }, t("diag.capture") + "：" + st.capture.label) : null
    ));
  }
  if (st && st.status === "error" && st.reason) body.push(h("p", { key: "err", className: "ss-error" }, st.reason));
  if (st && st.notes && st.notes.length) st.notes.forEach(function (n, i) { body.push(h("p", { key: "n" + i, className: "ss-muted" }, n)); });
  if (u.message) body.push(h("p", { key: "msg", className: "ss-muted" }, u.message));
  if (u.voiceMissing) body.push(h("p", { key: "voice", className: "ss-muted" }, t("voice.none")));
  if (last) body.push(h("div", { key: "last", className: "ss-line" }, h("div", { className: "ss-muted" }, t("panel.lastLine")), last.line));

  var buttons = [];
  if (!observing) buttons.push(h("button", { key: "start", type: "button", className: "ss-btn ss-btn-primary", disabled: u.busy || hs.connected === false, onClick: startObserving }, t("panel.start")));
  if (status === "on") buttons.push(h("button", { key: "pause", type: "button", className: "ss-btn", onClick: function () { control("pause"); } }, t("panel.pause")));
  if (status === "paused") buttons.push(h("button", { key: "resume", type: "button", className: "ss-btn", onClick: function () { control("resume"); } }, t("panel.resume")));
  if (observing) buttons.push(h("button", { key: "stop", type: "button", className: "ss-btn", onClick: function () { control("stop"); } }, t("panel.stop")));
  buttons.push(h("button", { key: "sess", type: "button", className: "ss-btn", onClick: ensureSession }, t("panel.openSession")));
  buttons.push(h("button", { key: "ovl", type: "button", className: "ss-btn", onClick: openOverlay }, t("panel.overlay")));
  if (st) buttons.push(h("button", { key: "quiet", type: "button", className: "ss-btn", onClick: function () { setQuiet(!st.quietMode); } }, st.quietMode ? t("panel.quietOff") : t("panel.quietOn")));
  if (recent) {
    buttons.push(h("button", { key: "ann", type: "button", className: "ss-btn", onClick: function () { feedback("annoying", last.id); } }, t("panel.annoying")));
    buttons.push(h("button", { key: "good", type: "button", className: "ss-btn", onClick: function () { feedback("good", last.id); } }, t("panel.good")));
  }

  return h("div", { className: "ss-panel", role: "dialog", "aria-label": t("panel.title"), "data-plugin": PKG, onClick: function (e) { e.stopPropagation(); } },
    h("button", { type: "button", className: "ss-btn ss-close", "aria-label": t("panel.close"), onClick: function () { ui.set({ panelOpen: false }); } }, "×"),
    h("h3", null, t("panel.title")),
    h("div", { className: "ss-muted" }, t("slogan")),
    body,
    h("div", { className: "ss-row" }, buttons)
  );
}

function Thought() {
  var hs = useStore(host);
  var u = useStore(ui);
  var p = hs.state && hs.state.pending;
  if (!p || u.dismissedThought === p.id) return null;
  var clear = function () { ui.set({ dismissedThought: p.id }); api("pending-clear", { json: { id: p.id } }).catch(function () {}); };
  return h("div", { className: "ss-thought", role: "status", "data-plugin": PKG },
    h("div", { className: "ss-muted" }, t("thought.title")),
    h("div", null, p.line),
    h("div", { className: "ss-row" },
      h("button", { type: "button", className: "ss-btn ss-btn-primary", onClick: function () { clear(); ensureSession(); } }, t("thought.enter")),
      h("button", { type: "button", className: "ss-btn", onClick: clear }, t("thought.dismiss"))
    )
  );
}

function ShellOverlay() {
  var u = useStore(ui);
  React.useEffect(function () {
    if (!u.panelOpen) return undefined;
    var onDown = function (e) {
      var panel = document.querySelector(".ss-panel");
      var foot = e.target && e.target.closest ? e.target.closest(".ss-foot") : null;
      if (panel && !panel.contains(e.target) && !foot) ui.set({ panelOpen: false });
    };
    document.addEventListener("pointerdown", onDown, true);
    return function () { document.removeEventListener("pointerdown", onDown, true); };
  }, [u.panelOpen]);
  return h("div", { className: "ss-layer", "data-plugin": PKG }, u.panelOpen ? h(Panel, null) : null, h(Thought, null));
}

/* ------------------------------------------------------------------ 会话状态条 */

/**
 * 开场白卡片。
 * 不能由宿主往会话里 append 一条 assistant 消息 —— 那会让会话日志变成 corrupt
 * （assistant/message 没有对应的 turn/step，resume 时报 SessionFormatError）。
 * 所以开场白放在这里渲染：只在「刚打开旁座会话」且「这个会话还没有任何对话」时出现。
 */
function OpeningCard(props) {
  var hs = useStore(host);
  var u = useStore(ui);
  var op = hs.opening;
  if (!op || !op.blank || !op.line) return null;
  // 只出现在旁座自己的会话里。conversation.input.dock 的 standardProps 里就有 sessionId，
  // 不用它判断的话，这条横条会窜到每一个会话（踩过一次）。
  var sid = props && props.sessionId;
  if (!sid || String(sid) !== String(op.sessionId)) return null;
  // 不设时间窗口：只要这个会话还没开始说话，旁座那句话就一直在那儿。
  return h("div", { className: "ss-opening" }, h(ChairIcon, { size: 16 }), h("span", null, op.line));
}

function ComposerDock() {
  var hs = useStore(host);
  var u = useStore(ui);
  var st = hs.state;
  if (!isObserving(st, u) || !st) return null;
  var lines = st.lines || [];
  var last = lines.length ? lines[lines.length - 1] : null;
  var recent = last && Date.now() - last.t < 2 * 60 * 1000 && !last.feedback;
  var parts = statusParts(st);
  return h("div", { className: "ss-strip", role: "status", "aria-live": "polite", "data-plugin": PKG },
    h("span", { className: "ss-dot-inline", "aria-hidden": "true" }),
    h("b", null, parts[0]),
    parts.slice(1).map(function (p, i) { return h("span", { key: i }, "· " + p); }),
    st.status === "on" ? h("button", { type: "button", className: "ss-link", onClick: function () { control("pause"); } }, "· " + t("panel.pause")) : null,
    st.status === "paused" ? h("button", { type: "button", className: "ss-link", onClick: function () { control("resume"); } }, "· " + t("panel.resume")) : null,
    h("button", { type: "button", className: "ss-link", onClick: function () { control("stop"); } }, "· " + t("panel.stop")),
    recent ? h("button", { type: "button", className: "ss-link", onClick: function () { feedback("annoying", last.id); } }, "· " + t("panel.annoying")) : null
  );
}

/* ------------------------------------------------------------------ 设置页 */

var FIELDS = ["persona", "personaGender", "voice", "listen", "mode", "chattiness", "scope", "asrEngine", "asrBaseUrl", "asrModel", "asrLanguage", "asrCommand", "asrCloudConsent"];

/** 本插件命名空间的 ConfigForm：只取一次；快照只在事实变化时换引用（渲染绑定依赖这一点）。 */
var formCache = { form: undefined, key: null, snap: null };
function configForm() {
  if (formCache.form !== undefined) return formCache.form;
  var forms = safeGet(runtime.ctx, "configForms");
  try { formCache.form = forms && typeof forms.get === "function" ? (forms.get(NS) || null) : null; } catch (e) { formCache.form = null; }
  return formCache.form;
}
function formSubscribe(l) {
  var form = configForm();
  return form && typeof form.subscribe === "function" ? form.subscribe(l) : function () {};
}
function formSnapshot() {
  var form = configForm();
  var raw = null;
  try { raw = form && typeof form.getSnapshot === "function" ? form.getSnapshot() : null; } catch (e) { raw = null; }
  var snap = raw && raw.status === "ready" ? { status: "ready", writable: raw.writable !== false, revision: raw.revision, value: raw.value || {} } : null;
  var key = JSON.stringify(snap);
  if (key !== formCache.key) { formCache.key = key; formCache.snap = snap; }
  return formCache.snap;
}

function useConfigForm() {
  var snap = React.useSyncExternalStore(formSubscribe, formSnapshot, formSnapshot);
  return { form: configForm(), snap: snap };
}

function pick(obj) { var out = {}; FIELDS.forEach(function (k) { if (obj && obj[k] !== undefined) out[k] = obj[k]; }); return out; }
function same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }

function DiagView(props) {
  var d = props.diag;
  if (!d) return h("p", { className: "ss-muted" }, t("diag.unknown"));
  var row = function (k, v, bad) { return [h("span", { key: k + "k", className: "ss-muted" }, t(k)), h("span", { key: k + "v", className: bad ? "ss-error" : "" }, v)]; };
  var cap = d.capture && d.capture.label ? d.capture.label : (d.capture && d.capture.attempts && d.capture.attempts.length
    ? d.capture.attempts.map(function (a) { return a.id + (a.ok ? " ✓" : "：" + a.reason); }).join("；") : t("diag.unknown"));
  var model = d.model ? (d.model.supported === true ? (d.model.model + " ✓ image") : d.model.supported === false ? d.model.reason : (d.model.model || "") + "（" + (d.model.reason || "") + "）") : t("diag.unknown");
  var a = d.audio || {};
  var asr = d.asr || {};
  var sp = d.speakPath || {};
  var voices = zhVoices();
  return h("div", { className: "ss-diag" },
    row("diag.capture", cap, d.capture && !d.capture.label && d.capture.attempts && d.capture.attempts.length),
    row("diag.model", model, d.model && d.model.supported === false),
    row("diag.audio", (a.label || "") + (a.reason ? "（" + a.reason + "）" : "")),
    row("diag.asr", asr.ready ? (asr.engine + " ✓" + (asr.cloud ? "（云端）" : "")) : (asr.reason || "")),
    row("diag.speak", (sp.last || "—") + " · " + Object.keys(sp.status || {}).map(function (k) { return k + "：" + sp.status[k]; }).join("；")),
    row("diag.version", d.version ? d.version.message : "", d.version && d.version.ok === false),
    row("diag.bridge", d.bridge ? d.bridge.mode + (d.bridge.reason ? "（" + d.bridge.reason + "）" : "") : ""),
    row("diag.memory", d.memory || ""),
    row("diag.voice", voices.length ? voices.map(function (v) { return v.name; }).slice(0, 3).join("、") : t("voice.none"), !voices.length),
    row("diag.ffmpeg", d.ffmpeg ? t("diag.yes") : t("diag.no"))
  );
}

function Radios(props) {
  return h("div", { className: "ss-radios", role: "radiogroup", "aria-label": props.label },
    props.options.map(function (o) {
      return h("label", { key: o },
        h("input", { type: "radio", name: props.name, value: o, checked: props.value === o, disabled: props.disabled, onChange: function () { props.onChange(o); } }),
        t(props.prefix + "." + o));
    }));
}

function SettingsPage() {
  var hs = useStore(host);
  var cf = useConfigForm();
  var accepted = cf.snap ? pick(Object.assign({}, hs.settings || {}, cf.snap.value || {})) : pick(hs.settings || {});
  var _d = React.useState(null), draft = _d[0], setDraft = _d[1];
  var _s = React.useState(""), status = _s[0], setStatus = _s[1];
  var _k = React.useState(""), keyValue = _k[0], setKeyValue = _k[1];
  var _r = React.useState(""), testResult = _r[0], setTestResult = _r[1];
  var _c = React.useState(""), clearMsg = _c[0], setClearMsg = _c[1];
  React.useEffect(function () { loadSettings(); loadDiag(); }, []);
  var value = Object.assign({}, accepted, draft || {});
  var dirty = draft && Object.keys(draft).some(function (k) { return !same(draft[k], accepted[k]); });
  var set = function (k, v) { setDraft(Object.assign({}, draft || {}, (function () { var o = {}; o[k] = v; return o; })())); setStatus(""); };

  async function save() {
    if (!dirty) return;
    setStatus(t("settings.saving"));
    var changes = {};
    Object.keys(draft).forEach(function (k) { if (!same(draft[k], accepted[k])) changes[k] = draft[k]; });
    try {
      if (cf.form && cf.snap && cf.snap.writable !== false && typeof cf.form.mutate === "function") {
        var ops = Object.keys(changes).map(function (k) { return { op: "set", path: [k], value: changes[k] }; });
        var ok = await cf.form.mutate(ops, cf.snap.revision);
        if (ok === false) throw new Error("rejected");
      } else {
        await api("settings", { json: { patch: changes } });
      }
      await loadSettings();
      setDraft(null);
      setStatus(t("settings.saved"));
      loadDiag();
    } catch (e) {
      setStatus(t("settings.saveFailed") + errText(e));
    }
  }

  function chooseEngine(next) {
    if (next === "openai" && !value.asrCloudConsent) {
      if (!window.confirm(t("settings.cloudConfirm"))) return;
      setDraft(Object.assign({}, draft || {}, { asrEngine: next, asrCloudConsent: true }));
      return;
    }
    set("asrEngine", next);
  }

  async function saveKey() {
    var creds = safeGet(runtime.ctx, "credentials");
    try {
      if (creds && typeof creds.set === "function") await creds.set(CRED_REF, keyValue);
      else await api("credentials-set", { json: { value: keyValue } });
      setKeyValue("");
      loadDiag();
      setStatus(t("settings.saved"));
    } catch (e) {
      setStatus(t("settings.saveFailed") + errText(e));
    }
  }

  async function test() {
    setTestResult(t("settings.testing"));
    try {
      var b = await api("asr-test", { json: {} });
      setTestResult(b.test.ok ? t("settings.testOk") + b.test.text : t("settings.testFail") + b.test.reason);
    } catch (e) { setTestResult(t("settings.testFail") + errText(e)); }
  }

  async function clearAll() {
    if (!window.confirm(t("settings.clearConfirm"))) return;
    try { var b = await api("memory-clear", { json: {} }); setClearMsg(t("settings.cleared", { n: b.cleared.total })); }
    catch (e) { setClearMsg(errText(e)); }
  }

  async function recheck() {
    try { await api("capture-probe", { json: {} }); } catch (e) { /* shown by diag */ }
    loadDiag();
  }

  var creds = hs.diag && hs.diag.asr && hs.diag.asr.credentials;
  var engine = value.asrEngine || "none";
  var field = function (label, control, hint) {
    return h("div", { className: "ss-field" }, h("label", null, label), h("div", null, control, hint ? h("div", { className: "ss-muted" }, hint) : null));
  };

  return h("div", { className: "ss-settings", "data-plugin": PKG },
    h("h2", null, t("settings.title")),
    h("div", { className: "ss-muted" }, t("slogan")),
    !cf.snap ? h("p", { className: "ss-muted" }, t("settings.fallback")) : null,
    field(t("settings.who"), h("textarea", { rows: 2, value: value.persona || "", maxLength: 200, onChange: function (e) { set("persona", e.currentTarget.value); } }), t("settings.whoHint")),
    field(t("settings.gender"), h(Radios, { name: "ss-gender", prefix: "settings.gender", options: ["male", "female", "none"], value: value.personaGender, label: t("settings.gender"), onChange: function (v) { set("personaGender", v); } }), t("settings.genderHint")),
    field(t("settings.voice"), h(Radios, { name: "ss-voice", prefix: "settings.voice", options: ["male", "female", "off"], value: value.voice, label: t("settings.voice"), onChange: function (v) { set("voice", v); } }), t("settings.voiceHint")),
    field(t("settings.listen"), h("input", { type: "checkbox", checked: value.listen !== false, onChange: function (e) { set("listen", e.currentTarget.checked); } }), t("settings.listenHint")),
    field(t("settings.mode"), h(Radios, { name: "ss-mode", prefix: "settings.mode", options: ["auto", "game", "movie", "browse", "daily"], value: value.mode || "auto", label: t("settings.mode"), onChange: function (v) { set("mode", v); } }), t("settings.modeHint")),
    field(t("settings.freq"), h(Radios, { name: "ss-freq", prefix: "settings.freq", options: ["quiet", "normal", "chatty"], value: value.chattiness, label: t("settings.freq"), onChange: function (v) { set("chattiness", v); } })),
    h("div", { className: "ss-ffmpeg" },
      h("div", { className: "ss-muted", style: { marginTop: "10px", fontWeight: "600" } }, t("settings.ffmpeg.title")),
      h("div", { className: "ss-muted" }, t("settings.ffmpeg.why")),
      h("div", { className: "ss-row" },
        h("button", { type: "button", className: "ss-btn ss-btn-primary", disabled: ffmpegBusy(hs.ffmpeg), onClick: installFfmpegNow }, t("settings.ffmpeg.install")),
        h("span", { className: "ss-muted", role: "status" }, ffmpegLine(hs.ffmpeg)))),
    field(t("settings.scope"), h("select", { value: value.scope || "screen", onChange: function (e) { set("scope", e.currentTarget.value); } },
      h("option", { value: "screen" }, t("settings.scope.screen")),
      h("option", { value: "window" }, t("settings.scope.window")))),
    h("div", { className: "ss-row" },
      h("button", { type: "button", className: "ss-btn ss-btn-primary", disabled: !dirty, onClick: save }, t("settings.save")),
      h("button", { type: "button", className: "ss-btn", disabled: !dirty, onClick: function () { setDraft(null); setStatus(""); } }, t("settings.reset")),
      status ? h("span", { className: "ss-muted", role: "status" }, status) : null
    ),
    h("details", { className: "ss-details" },
      h("summary", null, t("settings.status")),
      h(DiagView, { diag: hs.diag }),
      h("div", { className: "ss-row" },
        h("button", { type: "button", className: "ss-btn", onClick: recheck }, t("settings.recheck")),
        h("button", { type: "button", className: "ss-btn", onClick: clearAll }, t("settings.clear")),
        clearMsg ? h("span", { className: "ss-muted", role: "status" }, clearMsg) : null
      )
    ),
    h("details", { className: "ss-details" },
      h("summary", null, t("settings.advanced")),
      field(t("settings.engine"), h("select", { value: engine, onChange: function (e) { chooseEngine(e.currentTarget.value); } },
        ["none", "builtin", "openai", "command"].map(function (o) { return h("option", { key: o, value: o }, t("settings.engine." + o)); }))),
      engine === "openai" ? field(t("settings.baseUrl"), h("input", { type: "text", value: value.asrBaseUrl || "", placeholder: "https://api.example.com/v1", onChange: function (e) { set("asrBaseUrl", e.currentTarget.value); } }), t("settings.baseUrlHint")) : null,
      engine === "openai" ? field(t("settings.model"), h("input", { type: "text", value: value.asrModel || "", placeholder: "whisper-1", onChange: function (e) { set("asrModel", e.currentTarget.value); } })) : null,
      engine === "openai" ? field(t("settings.key"), h("div", { className: "ss-row", style: { marginTop: 0 } },
        h("input", { type: "password", value: keyValue, autoComplete: "off", placeholder: creds && creds.configured ? t("settings.keyConfigured") : t("settings.keyMissing"), onChange: function (e) { setKeyValue(e.currentTarget.value); } }),
        h("button", { type: "button", className: "ss-btn", disabled: !keyValue || (creds && creds.writable === false), onClick: saveKey }, t("settings.keySave")),
        h("span", { className: "ss-muted" }, creds ? (creds.configured ? t("settings.keyConfigured") : t("settings.keyMissing")) : "")
      ), t("settings.keyHint")) : null,
      engine !== "none" && engine !== "command" ? field(t("settings.language"), h(Radios, { name: "ss-lang", prefix: "settings.language", options: ["auto", "zh", "en"], value: value.asrLanguage || "auto", label: t("settings.language"), onChange: function (v) { set("asrLanguage", v); } })) : null,
      engine === "command" ? field(t("settings.command"), h("textarea", { rows: 2, value: value.asrCommand || "", onChange: function (e) { set("asrCommand", e.currentTarget.value); } }), t("settings.commandHint")) : null,
      h("div", { className: "ss-row" },
        h("button", { type: "button", className: "ss-btn ss-btn-primary", disabled: !dirty, onClick: save }, t("settings.save")),
        h("button", { type: "button", className: "ss-btn", disabled: dirty || engine === "none", title: dirty ? t("settings.testSaveFirst") : "", onClick: test }, t("settings.test")),
        testResult ? h("span", { className: testResult.indexOf(t("settings.testFail")) === 0 ? "ss-error" : "ss-muted", role: "status" }, testResult) : null
      )
    )
  );
}

/* ------------------------------------------------------------------ 注册 */

function register(ctx, name, entry, component) {
  ctx.slots.inject(name, function () { return ctx.slots.register(Object.assign({ name: name }, entry), component); });
}

exports.inject = ["slots"];

exports.apply = function apply(ctx) {
  runtime.ctx = ctx;
  runtime.disposed = false;
  formCache.form = undefined;
  formCache.key = null;
  formCache.snap = null;
  var conn = safeGet(ctx, "connection");
  runtime.altFetch = conn && typeof conn.fetch === "function" ? function (u, i) { return conn.fetch(u, i); } : null;

  ctx.effect(function () { return injectStyles(); });
  ctx.effect(function () {
    startPolling();
    loadSettings();
    try { if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = function () { ui.set({}); }; } catch (e) { /* ignore */ }
    return function () {
      runtime.disposed = true;
      stopPolling();
      stopAudio();
      cancelSpeech();
      ui.set({ panelOpen: false, intent: "off" });
    };
  });

  register(ctx, "sidebar.footer.action", { id: NS + ".entry", order: 40 }, SidebarAction);
  register(ctx, "settings.section", { id: NS, order: 90, label: function () { return t("nav"); } }, SettingsPage);
  register(ctx, "shell.overlay", { id: NS + ".overlay", order: 40 }, ShellOverlay);
  register(ctx, "conversation.composer.dock", { id: NS + ".status", order: 40 }, ComposerDock);
  register(ctx, "sidebar.session.row.leading", { id: NS + ".rowmark", order: 40 }, SessionRowMark);
  register(ctx, "conversation.input.dock", { id: NS + ".opening", order: 40 }, OpeningCard);
};

return module.exports; } });
