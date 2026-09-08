import { useState, type ReactNode } from 'react'
import {
  Columns3,
  GripVertical,
  LayoutGrid,
  Square,
} from 'lucide-react'
import { useStore } from '../state/store'
import type { LayoutMode, Page, Pane } from '../state/store'
import { BlotterPage } from './pages/BlotterPage'
import { AnalyticsPage } from './pages/AnalyticsPage'
import { JournalPage } from './pages/JournalPage'
import { AlertsPage } from './pages/AlertsPage'
import { ResearchPage } from './pages/ResearchPage'
import { ScreenPage } from './pages/ScreenPage'
import { HeatmapPage } from './pages/HeatmapPage'
import { PulsePage } from './pages/PulsePage'
import { BotsPage } from './pages/BotsPage'
import { DetailPanel } from './DetailPanel'
import { ChartPanel } from './chart/ChartPanel'

const PAGES: Array<[Page, string]> = [
  ['pulse', 'pulse'],
  ['chart', 'chart'],
  ['screen', 'screen'],
  ['heatmap', 'heat'],
  ['research', 'des'],
  ['alerts', 'alerts'],
  ['blotter', 'blotter'],
  ['analytics', 'analytics'],
  ['journal', 'journal'],
  ['bots', 'bots'],
]

const LAYOUTS: Array<[LayoutMode, string]> = [
  ['single', 'single'],
  ['double', 'double'],
  ['quad', 'quad'],
]

function renderPage(type: Page, pane: Pane, index: number) {
  const common = (node: ReactNode) => (
    <div className="min-h-0 flex-1 overflow-hidden">{node}</div>
  )
  switch (type) {
    case 'chart':
      return (
        <ChartPanel
          key={`${index}-${pane.symbol ?? ''}`}
          standalone
          compact
          initialSymbol={pane.symbol ?? ''}
          slotIndex={index}
        />
      )
    case 'pulse':
      return common(<PulsePage />)
    case 'screen':
      return common(<ScreenPage />)
    case 'heatmap':
      return common(<HeatmapPage />)
    case 'research':
      return common(<ResearchPage />)
    case 'alerts':
      return common(<AlertsPage />)
    case 'blotter':
      return common(<BlotterPage />)
    case 'analytics':
      return common(<AnalyticsPage />)
    case 'journal':
      return common(<JournalPage />)
    case 'bots':
      return common(<BotsPage />)
  }
}

export function WorkspaceArea() {
  const layout = useStore((s) => s.layout)
  const setLayout = useStore((s) => s.setLayout)
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const panes = useStore((s) => s.panes)

  const nPanes = layout === 'double' ? 2 : 4
  const isMulti = layout !== 'single'

  const switchLayout = (m: LayoutMode) => {
    setLayout(m)
  }

  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-[var(--bg)]">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1 text-[11px] text-[var(--dim)]">
        {LAYOUTS.map(([m, label]) => (
          <button
            key={m}
            onClick={() => switchLayout(m)}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 uppercase tracking-wider ${
              layout === m
                ? 'bg-[var(--panel2)] font-bold text-[var(--amber)]'
                : 'hover:text-[var(--text)]'
            }`}
          >
            {m === 'single' ? (
              <Square size={11} />
            ) : m === 'double' ? (
              <Columns3 size={12} />
            ) : (
              <LayoutGrid size={12} />
            )}
            {label}
          </button>
        ))}
        <span className="mx-2 text-[10px] text-[var(--dim)]">|</span>
        {isMulti ? (
          <span className="text-[10px] text-[var(--dim)]">
            drag widgets between panels to rearrange
          </span>
        ) : (
          <>
            {PAGES.map(([p, label]) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`rounded px-2 py-0.5 uppercase tracking-wider ${
                  page === p
                    ? 'bg-[var(--panel2)] font-bold text-[var(--amber)]'
                    : 'hover:text-[var(--text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </>
        )}
      </div>

      {isMulti ? (
        <>
          <div className="flex flex-wrap items-center gap-1 px-3 pt-1.5 text-[10px] text-[var(--dim)]">
            <span>add widgets:</span>
            <PagePicker />
          </div>

          <div
            className={`grid min-h-0 flex-1 gap-2 p-2 ${
              layout === 'double' ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'
            }`}
          >
            {panes.slice(0, nPanes).map((pane, i) => (
              <PaneCard
                key={i}
                index={i}
                pane={pane}
                setPaneType={(t) => useStore.getState().setPaneType(i, t)}
                setPaneSymbol={(k) => useStore.getState().setPaneSymbol(i, k)}
                swapPanes={(from, to) => useStore.getState().swapPanes(from, to)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {page === 'chart' ? (
            <DetailPanel />
          ) : (
            renderPage(page, { type: page }, 0)
          )}
        </div>
      )}
    </div>
  )
}

// A row of draggable page-chips that can be dropped into any panel.
function PagePicker() {
  return (
    <div className="flex flex-wrap gap-1">
      {PAGES.map(([p, label]) => (
        <span
          key={p}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/widget', label)
            e.dataTransfer.setData('text/widget-type', p)
            e.dataTransfer.effectAllowed = 'move'
          }}
          className="cursor-grab rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 uppercase tracking-wider text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
          title="drag into a panel"
        >
          {label}
        </span>
      ))}
    </div>
  )
}

interface PaneCardProps {
  index: number
  pane: Pane
  setPaneType: (t: Page) => void
  setPaneSymbol: (k: string) => void
  swapPanes: (from: number, to: number) => void
}

function PaneCard({
  index,
  pane,
  setPaneType,
  setPaneSymbol,
  swapPanes,
}: PaneCardProps) {
  const [dropHint, setDropHint] = useState<'none' | 'move' | 'symbol'>('none')

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const sym = e.dataTransfer.getData('text/symbol')
        setDropHint(sym ? 'symbol' : 'move')
      }}
      onDragLeave={() => setDropHint('none')}
      onDrop={(e) => {
        e.preventDefault()
        const sym = e.dataTransfer.getData('text/symbol')
        const fromIdx = e.dataTransfer.getData('text/pane-index')
        const widget = e.dataTransfer.getData('text/widget-type') as Page
        if (sym) {
          setPaneType('chart')
          setPaneSymbol(sym)
        } else if (widget) {
          setPaneType(widget)
        } else if (fromIdx !== '') {
          swapPanes(parseInt(fromIdx, 10), index)
        }
        setDropHint('none')
      }}
      className={`flex min-h-0 flex-col overflow-hidden border transition-colors ${
        dropHint === 'symbol'
          ? 'border-[var(--amber)] bg-[var(--amber)]/5'
          : dropHint === 'move'
            ? 'border-[var(--up)] bg-[var(--up)]/5'
            : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-center gap-1 border-b border-[var(--border)]/60 bg-[var(--panel2)] px-1 py-0.5 text-[10px] text-[var(--dim)]">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/pane-index', String(index))
            e.dataTransfer.setData('text/pane-type', pane.type)
            e.dataTransfer.effectAllowed = 'move'
          }}
          className="cursor-grab text-[var(--dim)] hover:text-[var(--amber)]"
          title="drag to another panel to swap positions"
        >
          <GripVertical size={12} />
        </span>
        <select
          value={pane.type}
          onChange={(e) => setPaneType(e.target.value as Page)}
          className="rounded border border-transparent bg-transparent px-1 py-0 text-[10px] uppercase tracking-wider text-[var(--amber)] outline-none hover:border-[var(--border)]"
          title="widget type"
        >
          {PAGES.map(([p, label]) => (
            <option key={p} value={p}>
              {label}
            </option>
          ))}
        </select>
        {pane.type === 'chart' && pane.symbol && (
          <span className="ml-auto font-semibold text-[var(--text)]">
            {pane.symbol.split(':').pop()}
          </span>
        )}
        <span className="ml-auto text-[9px] text-[var(--dim)]">#{index + 1}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {renderPage(pane.type, pane, index)}
      </div>
    </div>
  )
}
