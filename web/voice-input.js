import { toast } from "./dom.js";

const SpeechRecognition = globalThis.webkitSpeechRecognition || globalThis.SpeechRecognition;

export const voiceInputSupported = !!SpeechRecognition;

let activeRecognition = null;
let activeTextareaId = null;
let activeCallback = null;
let stoppingIntentionally = false;

export function startVoiceInput(textareaId, onStateChange) {
  if (!voiceInputSupported) return;
  if (activeRecognition) {
    stopVoiceInput();
    return;
  }

  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  const recognition = new SpeechRecognition();
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
      toast("音声認識サーバーに接続できません（localhost 以外では HTTPS が必要です）");
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
