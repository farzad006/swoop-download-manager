import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Clipboard, Download, FolderOpen, Gauge, MousePointerClick, Puzzle, RotateCcw, Sparkles, Video } from "lucide-react";
import { api, joinPath, Settings } from "../api";
import { Button, FolderInput, Kbd, Switch, useToast } from "../components/ui";
import { BrowserList } from "./Browsers";

const STEPS = ["Welcome", "Folder", "Browsers", "Ready"];

/** First-run tour: what OurIDM does, where files go, connecting browsers, tips. */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [s, setS] = useState<Settings | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [connected, setConnected] = useState(0);

  useEffect(() => {
    api.settings().then(setS);
    api.takeBrowserSelection().then(setSelection).catch(() => {});
  }, []);
  if (!s) return null;

  const finish = async () => {
    try {
      await api.saveSettings({ ...s, onboarded: true });
      onDone();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 bg-bg">
      <div className="w-full max-w-[640px]">
        <div className="flex items-center justify-between mb-4 px-1">
          <div className="flex items-center gap-2" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? "w-8 bg-accent" : i < step ? "w-4 bg-accent/50" : "w-4 bg-line-strong"}`} />
              </div>
            ))}
          </div>
          {step < STEPS.length - 1 && (
            <button className="text-muted hover:text-fg text-[12.5px] cursor-pointer" onClick={finish}>
              Skip setup
            </button>
          )}
        </div>

        <div key={step} className="anim-fade-up bg-surface border border-line rounded-2xl shadow-[var(--shadow-pop)] overflow-hidden">
          {step === 0 && (
            <div className="p-8 text-center">
              <div className="size-16 mx-auto rounded-2xl bg-accent text-on-accent grid place-items-center shadow-lg mb-5">
                <Download size={32} strokeWidth={2.2} />
              </div>
              <h1 className="text-[24px] font-semibold font-[family-name:var(--font-display)]">Welcome to OurIDM</h1>
              <p className="text-muted mt-1.5 text-[14px]">Faster, safer downloads, plus videos from websites. Setup takes about a minute.</p>
              <div className="grid grid-cols-3 gap-3 mt-7 text-left">
                <Feature icon={Gauge} title="Faster downloads" text="Uses several connections at once to speed things up." />
                <Feature icon={RotateCcw} title="Never start over" text="Pause anytime. Resumes even after a restart." />
                <Feature icon={Video} title="Save web videos" text="Pick a quality, or keep just the audio." />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="p-8">
              <StepHead icon={FolderOpen} title="Where should downloads go?" text="You can change this any time in Settings." />
              <div className="mt-6 space-y-5">
                <FolderInput value={s.downloadRoot} onChange={(v) => setS({ ...s, downloadRoot: v })} />
                <div className="flex items-start gap-4 p-4 rounded-xl bg-surface-2 border border-line">
                  <div className="flex-1">
                    <div className="font-medium">Sort into folders by type</div>
                    <div className="text-muted text-[12.5px] mt-0.5">Keeps things tidy:</div>
                    <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] text-muted font-mono">
                      {(s.useCategoryFolders ? ["Video", "Music", "Documents", "Programs"] : ["(everything in one folder)"]).map((f) => (
                        <span key={f} className="truncate">{s.useCategoryFolders ? joinPath("…", f) : f}</span>
                      ))}
                    </div>
                  </div>
                  <Switch label="Sort into folders by type" checked={s.useCategoryFolders} onChange={(v) => setS({ ...s, useCategoryFolders: v })} />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="p-8">
              <StepHead icon={Puzzle} title="Connect your browsers" text="Then clicking a download or a web video sends it straight to OurIDM. About 20 seconds per browser." />
              <div className="mt-5 max-h-[340px] overflow-auto -mx-1 px-1">
                <BrowserList selected={selection} onCount={(c) => setConnected(c)} />
              </div>
              <p className="text-[12px] text-faint mt-3">You can do this later from the sidebar or Settings.</p>
            </div>
          )}

          {step === 3 && (
            <div className="p-8">
              <StepHead icon={Sparkles} title="You're all set!" text="Here's how to download things:" />
              <div className="mt-6 space-y-2.5">
                <HowTo icon={Clipboard} title="Paste a link" text={<>Paste into the box at the top, or press <Kbd>Ctrl</Kbd> + <Kbd>V</Kbd> in the window.</>} />
                <HowTo icon={MousePointerClick} title="Click downloads in your browser" text={<>OurIDM takes them over. Hold <Kbd>Alt</Kbd> while clicking to keep one in the browser.</>} />
                <HowTo icon={Video} title="Download web videos" text="Use the blue “Download this video” button that appears on videos." />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 px-8 py-4 border-t border-line bg-surface-2">
            {step > 0 && (
              <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <div className="ml-auto">
              {step < STEPS.length - 1 ? (
                <Button variant="primary" size="lg" onClick={() => setStep(step + 1)}>
                  {step === 0 ? "Get started" : step === 2 ? (connected > 0 ? "Next" : "Skip for now") : "Continue"} <ArrowRight size={16} />
                </Button>
              ) : (
                <Button variant="primary" size="lg" onClick={finish}>
                  Start using OurIDM
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon: Icon, title, text }: { icon: typeof Download; title: string; text: string }) {
  return (
    <div className="p-4 rounded-xl bg-surface-2 border border-line">
      <Icon size={20} className="text-accent mb-2" />
      <div className="font-medium">{title}</div>
      <div className="text-muted text-[12.5px] mt-0.5">{text}</div>
    </div>
  );
}

function StepHead({ icon: Icon, title, text }: { icon: typeof Download; title: string; text: string }) {
  return (
    <div className="flex items-start gap-4">
      <span className="size-11 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
        <Icon size={22} />
      </span>
      <div>
        <h2 className="text-[19px] font-semibold font-[family-name:var(--font-display)]">{title}</h2>
        <p className="text-muted mt-0.5">{text}</p>
      </div>
    </div>
  );
}

function HowTo({ icon: Icon, title, text }: { icon: typeof Download; title: string; text: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3.5 p-3.5 rounded-xl border border-line bg-surface-2">
      <Icon size={20} className="text-accent mt-0.5 shrink-0" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-muted text-[12.5px] mt-0.5">{text}</div>
      </div>
    </div>
  );
}
