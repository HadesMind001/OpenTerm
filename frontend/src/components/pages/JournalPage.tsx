import { useEffect, useRef, useState } from 'react'
import { BookOpen, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import type { JournalEntry } from '../../lib/types'

export function JournalPage() {
  const selected = useStore((s) => s.selected)
  const pushToast = useStore((s) => s.pushToast)
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [text, setText] = useState('')
  const [tags, setTags] = useState('')
  const textRef = useRef<HTMLInputElement>(null)

  const reload = () => void api.journal().then(setEntries)
  useEffect(reload, [])

  const add = async () => {
    if (!text.trim()) return
    await api.addJournal(selected ?? 'GENERAL', text.trim(), tags.trim())
    setText('')
    setTags('')
    pushToast('info', 'journal entry saved')
    reload()
  }

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        <BookOpen size={13} /> Trade journal
        <span className="normal-case">— attaching to: {selected ?? 'GENERAL'}</span>
      </div>
      <div className="flex gap-2">
        <input
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="note — setup, thesis, mistake, lesson…"
          className="flex-1 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-xs outline-none focus:border-[var(--amber)]"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="tags"
          className="w-28 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-xs outline-none focus:border-[var(--amber)]"
        />
        <button
          onClick={() => void add()}
          className="rounded bg-[var(--amber)] px-3 text-xs font-bold text-black"
        >
          log
        </button>
      </div>
      <div className="mt-4 space-y-1.5">
        {entries.map((e) => (
          <div
            key={e.id}
            className="group flex items-start gap-2 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs"
          >
            <span className="rounded-sm bg-[var(--panel2)] px-1.5 py-0.5 text-[10px] text-[var(--amber)]">
              {e.symbol_key.split(':').pop()}
            </span>
            <span className="min-w-0 flex-1">{e.text}</span>
            {e.tags && (
              <span className="text-[10px] text-[#38bdf8]">#{e.tags.replace(/,/g, ' #')}</span>
            )}
            <span className="shrink-0 text-[10px] text-[var(--dim)]">
              {new Date(e.created * 1000).toLocaleDateString()}
            </span>
            <button
              onClick={() => {
                void api.removeJournal(e.id).then(reload)
              }}
              className="opacity-0 transition group-hover:opacity-100 hover:text-[var(--down)]"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {!entries.length && (
          <div className="py-6 text-center text-xs text-[var(--dim)]">
            no entries yet — log your first trade note above
          </div>
        )}
      </div>
    </div>
  )
}
