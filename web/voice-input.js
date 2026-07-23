import { toast } from "./dom.js";

const SpeechRecognitionCtor = globalThis.webkitSpeechRecognition || globalThis.SpeechRecognition;

const isWebKit = !globalThis.chrome && /webkit/i.test(navigator.userAgent);

export const voiceInputSupported = !!SpeechRecognitionCtor;

export const usesNativeDictation = voiceInputSupported && isWebKit;

let activeRecognition = null;
let activeTextareaId = null;
let activeCallback = null;
let stoppingIntentionally = false;

export function startVoiceInput(textareaId, onStateChange) {
  if (!voiceInputSupported) return;

  if (usesNativeDictation) {
    const textarea = document.getElementById(textareaId);
    if (textarea) textarea.focus();
    toast("このブラウザでは macOS の音声入力をお使いください。有効にするには: システム設定 → キーボード → 音声入力 → ON。有効化後、fn を2回押すと起動します");
    return;
  }

  if (activeRecognition) {
    stopVoiceInput();
    return;
  }

  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  const recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "ja-JP";

  activeRecognition = recognition;
  activeTextareaId = textareaId;
  activeCallback = onStateChange;
  stoppingIntentionally = false;

  const baseText = textarea.value;
  let finalTranscript = "";

  recognition.onresult = (event) => {
    const el = document.getElementById(activeTextareaId);
    if (!el) return;

    finalTranscript = "";
    let interim = "";
    for (let i = 0; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interim += transcript;
      }
    }

    const separator = baseText && !baseText.endsWith("\n") && !baseText.endsWith(" ") ? " " : "";
    el.value = baseText + separator + finalTranscript + interim;
  };

  recognition.onerror = (event) => {
    if (event.error === "aborted") return;
    if (event.error === "no-speech") return;
    if (event.error === "not-allowed") {
      toast("マイクへのアクセスが拒否されました");
    } else if (event.error === "network") {
      toast("音声認識サーバーに接続できません。ネットワーク接続を確認してください");
    } else {
      toast(`音声認識エラー: ${event.error}`);
    }
    stopVoiceInput();
  };

  recognition.onend = () => {
    if (!stoppingIntentionally && activeRecognition === recognition) {
      try { recognition.start(); } catch { stopVoiceInput(); }
      return;
    }
    stopVoiceInput();
  };

  recognition.start();
  onStateChange?.(true);
}

export function stopVoiceInput() {
  if (!activeRecognition) return;
  stoppingIntentionally = true;
  try { activeRecognition.stop(); } catch { /* already stopped */ }
  const callback = activeCallback;
  activeRecognition = null;
  activeTextareaId = null;
  activeCallback = null;
  callback?.(false);
}

export function isVoiceInputActive() {
  return activeRecognition !== null;
}
