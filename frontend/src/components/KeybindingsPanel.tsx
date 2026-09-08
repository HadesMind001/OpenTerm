import { useState } from 'react'
import { KeyRound, PlusCircle, X } from 'lucide-react'
import { useStore } from '../state/store'
import { api } from '../lib/api'
import type { KeybindingRow } from '../lib/types'

function Row({ item, onEdit, onDelete }: {
  item: KeybindingRow
  onEdit: (item: KeybindingRow) => void
  onDelete: (id: number) => void
}) {
  return (
    <div className="group flex items-center gap-2 border-b border-[var(--border)]/50 px-3 py-1.5 hover:bg-[var(--panel2)]">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{item.name}</div>
        <div className="truncate text-[10px] text-[var(--dim)]">
          {item.bindings.slice(0, 120)}
        </div>
      </div>
      <button
        onClick={() => onEdit(item)}
        className="opacity-0 transition-opacity group-hover:opacity-100 text-[var(--dim)] hover:text-[var(--text)]"
        title="edit"
      >
        ✎
      </button>
      <button
        onClick={() => onDelete(item.id)}
        className="opacity-0 transition-opacity group-hover:opacity-100 text-[var(--dim)] hover:text-[var(--down)]"
        title="remove"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function KeybindingsPanel() {
  const keybindings = useStore((s) => s.keybindings)
  const pushToast = useStore((s) => s.pushToast)
  const reloadPrefs = useStore((s) => s.reloadPrefs)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<{ name: string; bindings: string }>({
    name: '',
    bindings: '',
  })

  const startCreate = () => {
    setForm({ name: '', bindings: '' })
    setEditingId(null)
    setShowForm(true)
  }

  const startEdit = (item: KeybindingRow) => {
    setForm({ name: item.name, bindings: item.bindings })
    setEditingId(item.id)
    setShowForm(true)
  }

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.bindings.trim()) {
      pushToast('error', 'name and bindings required')
      return
    }
    try {
      if (editingId != null) {
        await api.updateKeybinding(editingId, form)
      } else {
        await api.addKeybinding(form)
      }
      setShowForm(false)
      setEditingId(null)
      setForm({ name: '', bindings: '' })
      pushToast('info', editingId != null ? 'keybinding updated' : 'keybinding saved')
      await reloadPrefs()
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'save failed')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await api.removeKeybinding(id)
      await reloadPrefs()
      pushToast('info', 'keybinding removed')
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'delete failed')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--dim)]">
        <KeyRound size={13} /> Keybinding profiles
      </div>
      <div className="flex-1 overflow-y-auto">
        {keybindings.length === 0 && !showForm && (
          <div className="p-4 text-center text-xs text-[var(--dim)]">
            No keybinding profiles yet. Add one below.
          </div>
        )}
        {keybindings.map((item) => (
          <Row key={item.id} item={item} onEdit={startEdit} onDelete={handleDelete} />
        ))}

        {showForm && (
          <div className="border-b border-[var(--border)] bg-[var(--panel2)] p-3">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="profile name"
              className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none"
            />
            <textarea
              value={form.bindings}
              onChange={(e) => setForm({ ...form, bindings: e.target.value })}
              placeholder='JSON, e.g. {"ctrl+k": "command"}'
              spellCheck={false}
              rows={4}
              className="mb-2 w-full resize-none rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-xs outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void handleSubmit()}
                className="flex-1 rounded bg-[var(--amber)] py-1.5 text-xs font-medium text-black hover:opacity-90"
              >
                {editingId != null ? 'Update' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setShowForm(false)
                  setEditingId(null)
                }}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)] hover:text-[var(--text)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 px-3 py-2 border-t border-[var(--border)] bg-[var(--panel)]">
          <button
            onClick={startCreate}
            disabled={showForm && editingId == null}
            className="w-full flex items-center justify-center gap-2 rounded bg-[var(--amber)] py-1.5 font-medium text-black hover:opacity-90 disabled:opacity-40"
          >
            <PlusCircle size={13} /> Add New
          </button>
        </div>
      </div>
    </div>
  )
}
