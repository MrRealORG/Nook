
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { transcribeBlob, ASR_MODELS, currentModelId, micErrorMessage, retryASR } from "@/lib/asr";
import { logEvent } from "@/lib/logger";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";

/**
 * Shared voice-input button — records from the mic, transcribes fully locally
 * (Moonshine / Whisper via transformers.js, downloaded once in Settings → Voice)
 * and hands the text to `onText`. Used by the note editor toolbar and the task quick-add.
 */
export function MicButton({ onText, onRegister, compact = false }: { onText: (text: string) => void; onRegister?: (toggle: () => void) => void; compact?: boolean }) {
  const asr = useStore((s) => s.asr);
  const dnd = useStore((s) => s.dnd);
  const [rec, setRec] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secs, setSecs] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const st = useStore.getState;

  const stopOnly = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (recRef.current?.state === "recording") {
      try {
        recRef.current.stop();
      } catch {}
    }
    try {
      recRef.current?.stream.getTracks().forEach((t) => t.stop());
    } catch {}
    recRef.current = null;
    setRec(false);
  };

  useEffect(() => () => stopOnly(), []);

  const start = async () => {
    if (rec || busy) return;
    // a failed model download: the mic click is the retry
    if (st().asr.status === "error") {
      st().toast("Retrying the voice model download…", "download");
      void retryASR().then(() => st().toast("Voice model ready — click the mic to record", "mic")).catch((e) => st().toast(String((e as Error).message ?? e).slice(0, 120), "alert"));
      return;
    }
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no mediaDevices"), { name: "NotFoundError" });
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      sfx("error");
      const msg = micErrorMessage(e);
      st().toast(msg, "mic");
      logEvent(`mic failed: ${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? ""}`, "warn", "voice");
      return;
    }
    chunks.current = [];
    try {
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void finish(new Blob(chunks.current, { type: mr.mimeType || "audio/webm" }));
      };
      mr.start(250);
      recRef.current = mr;
      setRec(true);
      setSecs(0);
      timer.current = setInterval(() => setSecs((s) => s + 1), 1000);
      sfx("click");
      if (!dnd) st().toast("Recording… click the mic again to transcribe", "mic");
    } catch {
      sfx("error");
      st().toast("Recording is not supported in this browser", "mic");
      stream.getTracks().forEach((t) => t.stop());
    }
  };

  const finish = async (blob: Blob) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setRec(false);
    if (blob.size < 2000) {
      st().toast("That was too short — hold a thought for a second or two", "mic");
      return;
    }
    setBusy(true);
    try {
      const text = await transcribeBlob(blob, (s) => !dnd && st().toast(s, "mic"));
      if (text) {
        onText(text);
        sfx("receive");
        st().toast("Voice transcribed and inserted", "sparkle");
        st().unlock("voice-pioneer", "Voice Pioneer", "Transcribed your first voice note", "mic");
        logEvent(`voice input inserted (${text.split(/\s+/).length} words)`, "info", "voice");
      } else {
        sfx("error");
        st().toast("Nothing audible came through — try again a bit louder", "mic");
      }
    } catch (e) {
      sfx("error");
      const msg = e instanceof Error ? e.message : String(e);
      st().toast(`Voice failed: ${msg.slice(0, 80)}`, "alert");
      logEvent(`voice transcription failed: ${msg}`, "error", "voice");
      // if the model simply isn't downloaded yet, point the user at Settings → Voice
      if (/fetch|network|404|download/i.test(msg)) {
        st().set({ settingsSection: "voice" });
        st().setView("settings");
        st().toast("Download a voice model first (Settings → Voice)", "download");
      }
    } finally {
      setBusy(false);
    }
  };

  const model = ASR_MODELS.find((m) => m.id === (asr.model ?? currentModelId()));
  const hint = asr.status === "ready" ? model?.name ?? "voice" : asr.status === "loading" ? `${asr.progress}%` : "voice";

  useEffect(() => {
    onRegister?.(() => {
      if (rec) recRef.current?.stop();
      else if (!busy) void start();
    });
  });

  return (
    <button
      className={`icon-btn !h-8 !w-8 mic-btn ${rec ? "recording" : ""}`}
      title={rec ? "Stop & transcribe" : busy ? "Transcribing…" : `Voice input (${hint}) — click to record`}
      aria-label={rec ? "Stop recording and transcribe" : "Start voice input"}
      data-testid="mic-btn"
      data-state={rec ? "recording" : busy ? "busy" : asr.status}
      onClick={() => (rec ? recRef.current?.stop() : busy ? undefined : void start())}
      disabled={busy}
    >
      {busy ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : asr.status === "loading" ? (
        <span className="text-[9px] font-bold tabular-nums">{asr.progress}%</span>
      ) : (
        <Icon name="mic" size={15} />
      )}
      {rec && <i className="mic-dot" />}
    </button>
  );
}
