import { useState } from "react";
import { AfterQueue, api, MAIN_QUEUE, Queue } from "../api";
import { Button, Check, Field, Modal, TextInput } from "../components/ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function SchedulerDialog({ queues, onChanged, onClose }: { queues: Queue[]; onChanged: () => void; onClose: () => void }) {
  const [selId, setSelId] = useState<number>(queues[0]?.id ?? MAIN_QUEUE);
  const [draft, setDraft] = useState<Queue | null>(queues.find((q) => q.id === selId) ?? null);
  const [err, setErr] = useState<string | null>(null);

  const pick = (q: Queue) => {
    setSelId(q.id);
    setDraft(structuredClone(q));
  };
  const sched = draft?.schedule ?? { startTime: null, stopTime: null, days: [] };
  const setSched = (patch: Partial<typeof sched>) => {
    if (!draft) return;
    const next = { ...sched, ...patch };
    setDraft({ ...draft, schedule: next.startTime || next.stopTime ? next : null });
  };

  const save = async () => {
    if (!draft) return;
    try {
      const id = await api.saveQueue(draft);
      setSelId(id);
      setDraft({ ...draft, id });
      onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };
  const newQueue = () => setDraft({ id: 0, name: "New queue", maxConcurrent: 2, schedule: null, afterDone: "nothing", running: false });

  return (
    <Modal
      title="Scheduler"
      width={720}
      onClose={onClose}
      footer={
        <>
          {err && <span className="text-danger mr-auto self-center">{err}</span>}
          <Button onClick={onClose}>Close</Button>
          <Button primary onClick={save} disabled={!draft}>Apply</Button>
        </>
      }
    >
      <div className="flex gap-3 min-h-[320px]">
        <div className="w-[200px] border border-line rounded-md p-1 flex flex-col">
          <div className="flex-1 space-y-0.5">
            {queues.map((q) => (
              <button
                key={q.id}
                onClick={() => pick(q)}
                className={`w-full text-left h-7 px-2 rounded cursor-pointer truncate ${q.id === selId && draft?.id !== 0 ? "bg-selected" : "hover:bg-hover"}`}
              >
                {q.name} {q.running && <span className="text-ok">●</span>}
              </button>
            ))}
            {draft?.id === 0 && <div className="h-7 px-2 rounded bg-selected flex items-center">{draft.name}</div>}
          </div>
          <div className="flex gap-1 pt-1">
            <Button className="flex-1 px-2" onClick={newQueue}>New</Button>
            <Button
              className="flex-1 px-2"
              disabled={!draft || draft.id === MAIN_QUEUE || draft.id === 0}
              onClick={async () => {
                if (!draft) return;
                await api.deleteQueue(draft.id).catch((e) => setErr(String(e)));
                setDraft(null);
                onChanged();
              }}
            >
              Delete
            </Button>
          </div>
        </div>

        {draft && (
          <div className="flex-1 space-y-2.5">
            <Field label="Name">
              <TextInput className="w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Download at once">
              <TextInput type="number" min={1} max={16} className="w-20" value={draft.maxConcurrent} onChange={(e) => setDraft({ ...draft, maxConcurrent: Math.max(1, Number(e.target.value)) })} />
            </Field>
            <Field label="Start at">
              <div className="flex items-center gap-2">
                <Check checked={!!sched.startTime} onChange={(v) => setSched({ startTime: v ? "02:00" : null })} label="" />
                <TextInput type="time" disabled={!sched.startTime} value={sched.startTime ?? ""} onChange={(e) => setSched({ startTime: e.target.value })} />
              </div>
            </Field>
            <Field label="Stop at">
              <div className="flex items-center gap-2">
                <Check checked={!!sched.stopTime} onChange={(v) => setSched({ stopTime: v ? "07:00" : null })} label="" />
                <TextInput type="time" disabled={!sched.stopTime} value={sched.stopTime ?? ""} onChange={(e) => setSched({ stopTime: e.target.value })} />
              </div>
            </Field>
            <Field label="Days" hint="None selected = every day">
              <div className="flex gap-1 flex-wrap">
                {DAYS.map((d, i) => {
                  const on = sched.days.includes(i);
                  return (
                    <button
                      key={d}
                      aria-pressed={on}
                      onClick={() => setSched({ days: on ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort() })}
                      className={`h-7 px-2 rounded border cursor-pointer ${on ? "bg-accent text-on-accent border-accent" : "border-line hover:bg-hover"}`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="When done">
              <select
                className="h-8 px-2 rounded-md border border-line bg-surface"
                value={draft.afterDone}
                onChange={(e) => setDraft({ ...draft, afterDone: e.target.value as AfterQueue })}
              >
                <option value="nothing">Do nothing</option>
                <option value="exit">Exit OurIDM</option>
                <option value="sleep">Put the computer to sleep</option>
                <option value="shutdown">Shut down the computer (1 minute warning)</option>
              </select>
            </Field>
            {draft.id > 0 && (
              <div className="pt-2 flex gap-2">
                <Button onClick={() => api.startQueue(draft.id).then(onChanged)}>Start now</Button>
                <Button onClick={() => api.stopQueue(draft.id).then(onChanged)}>Stop</Button>
              </div>
            )}
            <p className="text-[12px] text-muted">Add files to a queue with "Download later" or by right-clicking a download.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
