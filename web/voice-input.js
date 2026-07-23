const SpeechRecognition = globalThis.webkitSpeechRecognition || globalThis.SpeechRecognition;

export const voiceInputSupported = !!SpeechRecognition;

let activeRecognition = null;
let activeTextareaId = null;
let activeCallback = null;

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

  const baseText = textarea.value;
  let finalTranscript = "";

  recognition.onresult = (event) => {
    const el = document.getElementById(activeTextareaId);
    if (!el) return;

    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
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
    stopVoiceInput();
  };

  recognition.onend = () => {
    stopVoiceInput();
  };

  recognition.start();
  onStateChange?.(true);
}

export function stopVoiceInput() {
  if (!activeRecognition) return;
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
