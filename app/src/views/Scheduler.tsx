import { useState } from "react";
import { CalendarClock, ListOrdered, Play, Plus, Square, Trash2 } from "lucide-react";
import { AfterQueue, api, MAIN_QUEUE, Queue } from "../api";
import { Button, Modal, Select, SettingRow, Switch, TextInput, useToast } from "../components/ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Plain-English summary of a queue's schedule. */
export function describeSchedule(q: Queue): string {
  const s = q.schedule;
  if (!s || (!s.startTime && !s.stopTime)) return "Starts only when you press Start.";
  const days = s.days.length === 0 || s.days.length === 7 ? "every day" : s.days.join() === "1,2,3,4,5" ? "on weekdays" : s.days.join() === "0,6" ? "at weekends" : `on ${s.days.map((d) => DAYS[d]).join(", ")}`;
  const parts = [];
  if (s.startTime) parts.push(`Starts at ${fmtTime(s.startTime)} ${days}`);
  if (s.stopTime) parts.push(`${s.startTime ? "and stops" : "Stops"} at ${fmtTime(s.stopTime)}${s.startTime ? "" : ` ${days}`}`);
  return parts.join(", ") + ".";
}

export function SchedulerDialog({ queues, onChanged, onClose }: { queues: Queue[]; onChanged: () => void; onClose: () => void }) {
  const toast = useToast();
  const [selId, setSelId] = useState<number>(queues[0]?.id ?? MAIN_QUEUE);
  const [draft, setDraft] = useState<Queue | null>(queues.find((q) => q.id === selId) ? structuredClone(queues.find((q) => q.id === selId)!) : null);

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
      toast("Schedule saved", "ok");
    } catch (e) {
      toast(String(e), "error");
    }
  };
  const live = queues.find((q) => q.id === draft?.id);

  return (
    <Modal
      title="Queues and schedule"
      subtitle="Download several files in turn, or at night when nobody needs the internet."
      icon={CalendarClock}
      width={760}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={save} disabled={!draft}>Save changes</Button>
        </>
      }
    >
      <div className="flex gap-4 min-h-[340px]">
        <div className="w-[200px] shrink-0 flex flex-col">
          <div className="flex-1 space-y-1">
            {queues.map((q) => (
              <button
                key={q.id}
                onClick={() => pick(q)}
                className={`w-full flex items-center gap-2 text-left h-9 px-2.5 rounded-lg cursor-pointer ${q.id === selId && draft?.id !== 0 ? "bg-accent-soft text-accent font-medium" : "hover:bg-hover"}`}
              >
                <ListOrdered size={15} />
                <span className="truncate flex-1">{q.name}</span>
                {q.running && <span className="size-2 rounded-full bg-ok" title="Running" />}
              </button>
            ))}
            {draft?.id === 0 && <div className="h-9 px-2.5 rounded-lg bg-accent-soft text-accent font-medium flex items-center">{draft.name}</div>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="justify-start"
            onClick={() => setDraft({ id: 0, name: "New queue", maxConcurrent: 2, schedule: null, afterDone: "nothing", running: false })}
          >
            New queue
          </Button>
        </div>

        {draft && (
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <TextInput className="flex-1 font-medium" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Queue name" />
              {draft.id > 0 &&
                (live?.running ? (
                  <Button icon={Square} onClick={() => api.stopQueue(draft.id).then(onChanged)}>Stop</Button>
                ) : (
                  <Button variant="primary" icon={Play} onClick={() => api.startQueue(draft.id).then(onChanged)}>Start now</Button>
                ))}
              {draft.id > 0 && draft.id !== MAIN_QUEUE && (
                <Button
                  variant="ghost"
                  icon={Trash2}
                  aria-label="Delete queue"
                  onClick={async () => {
                    await api.deleteQueue(draft.id).catch((e) => toast(String(e), "error"));
                    setDraft(null);
                    onChanged();
                  }}
                />
              )}
            </div>
            <div className="px-3 py-2 rounded-lg bg-surface-2 text-[12.5px] text-muted mb-1">{describeSchedule(draft)}</div>
            <div className="divide-y divide-line">
              <SettingRow title="Files at the same time" description="How many downloads from this queue run together.">
                <Select value={draft.maxConcurrent} onChange={(e) => setDraft({ ...draft, maxConcurrent: Number(e.target.value) })} aria-label="Files at the same time">
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </Select>
              </SettingRow>
              <SettingRow title="Start automatically" description="OurIDM must be running (it can start with Windows).">
                <div className="flex items-center gap-2">
                  {sched.startTime && <TextInput type="time" value={sched.startTime} onChange={(e) => setSched({ startTime: e.target.value })} aria-label="Start time" />}
                  <Switch label="Start automatically" checked={!!sched.startTime} onChange={(v) => setSched({ startTime: v ? "02:00" : null })} />
                </div>
              </SettingRow>
              <SettingRow title="Stop automatically" description="Pauses whatever is still downloading.">
                <div className="flex items-center gap-2">
                  {sched.stopTime && <TextInput type="time" value={sched.stopTime} onChange={(e) => setSched({ stopTime: e.target.value })} aria-label="Stop time" />}
                  <Switch label="Stop automatically" checked={!!sched.stopTime} onChange={(v) => setSched({ stopTime: v ? "07:00" : null })} />
                </div>
              </SettingRow>
              {(sched.startTime || sched.stopTime) && (
                <div className="py-3.5">
                  <div className="font-medium mb-2">On these days</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {DAYS.map((d, i) => {
                      const on = sched.days.length === 0 || sched.days.includes(i);
                      return (
                        <button
                          key={d}
                          aria-pressed={on}
                          onClick={() => {
                            const cur = sched.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : sched.days;
                            const next = on ? cur.filter((x) => x !== i) : [...cur, i].sort();
                            setSched({ days: next.length === 7 ? [] : next });
                          }}
                          className={`h-8 w-12 rounded-full border text-[12.5px] cursor-pointer transition-colors ${on ? "bg-accent text-on-accent border-accent" : "border-line hover:bg-hover"}`}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <SettingRow title="When everything is downloaded">
                <Select value={draft.afterDone} onChange={(e) => setDraft({ ...draft, afterDone: e.target.value as AfterQueue })} aria-label="When everything is downloaded">
                  <option value="nothing">Do nothing</option>
                  <option value="exit">Close OurIDM</option>
                  <option value="sleep">Put the PC to sleep</option>
                  <option value="shutdown">Shut down the PC (1-minute warning)</option>
                </Select>
              </SettingRow>
            </div>
            <p className="text-[12px] text-faint mt-2">Add files with “Later”, or right-click a download and choose “Download later”.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
