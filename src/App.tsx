import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownIcon,
  CheckIcon,
  CircleDotIcon,
  ArrowUpIcon,
  PlusIcon,
  Trash2Icon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { createCodePlugin } from '@streamdown/code'
import { Streamdown, type Components } from 'streamdown'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiFetch, humanOperation, CREDENTIAL_HINT, hasCredential, UnauthorizedError } from '@/lib/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '@/components/ui/message'
import './App.css'

type Row = Record<string, unknown>
type Target = 'global' | 'claude' | 'codex' | 'grok'
interface QueueItem { id: string; title: string }
interface DerivedTaskResult {
  kind: string
  task_id: string
  actor?: string | null
  action_kind?: string
  action?: Row
}
interface DerivedWorker {
  session?: { liveness?: string; work_in_flight?: boolean }
  tasks?: DerivedTaskResult[]
}
interface RuntimeAgent {
  agent_id: string
  presence: 'not_connected' | 'connected' | 'working' | 'disconnected'
  activity?: string | null
  summary?: string
  pid?: number | null
  cwd?: string | null
  native_session_id?: string | null
  last_observed_at?: string | null
}
interface RuntimeEventRow {
  id: number
  agent_id: string
  kind: string
  title: string
  body: string
  timestamp: string
}
interface Snapshot {
  project: Row
  agents: Row[]
  sessions: Row[]
  tasks: Row[]
  task_roles: Row[]
  messages: Row[]
  proposals: Row[]
  decisions: Row[]
  reviews: Row[]
  findings: Row[]
  verifications: Row[]
  events: Row[]
  attachments: Row[]
  message_attachments: Row[]
  task_attachments: Row[]
  derived_actions: Record<string, DerivedWorker>
  runtimes?: RuntimeAgent[]
  runtime_events?: RuntimeEventRow[]
}

const StreamList = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={['stream-content', className].filter(Boolean).join(' ')} {...props} />
  ),
)
StreamList.displayName = 'StreamList'
const virtuosoComponents = { List: StreamList }

function VirtualList<T>({
  data,
  itemKey,
  empty,
  className,
  itemContent,
}: {
  data: T[]
  itemKey: (item: T) => string
  empty: string
  className?: string
  itemContent: (index: number, item: T) => React.ReactNode
}) {
  if (data.length === 0) return <p className="quiet">{empty}</p>
  return (
    <Virtuoso
      className={['virtual-list', className].filter(Boolean).join(' ')}
      data={data}
      computeItemKey={(_index, item) => itemKey(item)}
      itemContent={itemContent}
    />
  )
}
const markdownPlugins = { code: createCodePlugin({ themes: ['github-dark', 'github-dark'] }) }
const markdownComponents: Components = { h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6' }
const actorNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', human: 'You' }
const TASK_KEY = 'scrapgrid.selected-task'
const QUEUE_KEY = 'scrapgrid.work-queue'
const WORKERS = ['claude', 'codex', 'grok'] as const

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
function shortSha(value: unknown): string {
  const sha = text(value)
  return sha === '—' ? sha : sha.slice(0, 9)
}
function formatTime(value: unknown): string {
  const date = new Date(text(value, ''))
  if (Number.isNaN(date.valueOf())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}
function taskTitle(task: Row | undefined): string {
  return text(task?.['goal'], 'Untitled work')
}
function isVisibleWork(task: Row): boolean {
  const goal = text(task['goal']).toLowerCase()
  if (text(task['id']) === 'TASK-OPX') return false
  if (goal.includes('disposable') || goal.includes('operator experience')) return false
  return !['accepted', 'cancelled'].includes(text(task['status']))
}
function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}
function defaultRoles(): { implementer: string; reviewer: string; verifier: string } {
  return { implementer: 'codex', reviewer: 'claude', verifier: 'grok' }
}
function workerLabel(id: string): string {
  return actorNames[id] ?? id
}
function runtimeOf(snapshot: Snapshot, agentId: string): RuntimeAgent | undefined {
  return snapshot.runtimes?.find((row) => row.agent_id === agentId)
}
function workerPresence(snapshot: Snapshot, agentId: string): RuntimeAgent['presence'] {
  return runtimeOf(snapshot, agentId)?.presence ?? 'not_connected'
}
function workerIsBusy(snapshot: Snapshot, agentId: string): boolean {
  return workerPresence(snapshot, agentId) === 'working' || Boolean(snapshot.derived_actions?.[agentId]?.session?.work_in_flight)
}
function presenceLabel(presence: RuntimeAgent['presence'], busy: boolean): string {
  if (busy || presence === 'working') return 'Working'
  if (presence === 'connected') return 'Idle'
  if (presence === 'disconnected') return 'Disconnected'
  return 'Offline'
}
function dispatchStatus(snapshot: Snapshot, taskId: string, agentId: string): string | null {
  const derived = snapshot.derived_actions?.[agentId]?.tasks?.find((row) => row.task_id === taskId)
  if (snapshot.derived_actions?.[agentId]?.session?.work_in_flight) return 'Harness mutation in flight.'
  if (!derived) return null
  if (derived.kind === 'action') {
    switch (derived.action?.['kind'] ?? derived.action_kind) {
      case 'claim':
        return 'Next harness action: claim.'
      case 'implement':
        return 'Next harness action: implement.'
      case 'review':
        return 'Next harness action: review.'
      case 'verify':
        return 'Next harness action: verify.'
      default:
        return 'Has a harness action.'
    }
  }
  if (derived.kind === 'waiting' && derived.actor === 'human') return 'Waiting on you.'
  return null
}
function whatTheyAreDoing(snapshot: Snapshot, taskId: string, agentId: string): string {
  const runtime = runtimeOf(snapshot, agentId)
  const presence = runtime?.presence ?? 'not_connected'
  if (presence === 'working') return runtime?.summary || 'Working right now.'
  if (presence === 'disconnected') return 'Disconnected.'
  if (presence === 'not_connected') return 'Not connected.'
  const next = dispatchStatus(snapshot, taskId, agentId)
  return next ? `Connected. Idle. ${next}` : 'Connected. Idle.'
}
function asRuntimeStreamEvent(row: RuntimeEventRow): Row {
  return {
    id: `rt-${row.id}`,
    actor: row.agent_id,
    entity_type: 'runtime',
    entity_id: String(row.id),
    action: 'runtime_activity',
    payload: row,
    timestamp: row.timestamp,
  }
}

async function readTextFiles(list: FileList | null): Promise<Array<{ filename: string; content: string }>> {
  if (!list || list.length === 0) return []
  return Promise.all(Array.from(list).map(async (file) => ({ filename: file.name, content: await file.text() })))
}

function MarkdownBody({ children }: { children: string }) {
  return (
    <Streamdown className="markdown-body" components={markdownComponents} mode="static" plugins={markdownPlugins}>
      {children}
    </Streamdown>
  )
}

async function readApiResponse<T>(response: Response, operation: string): Promise<T> {
  const rawBody = await response.text()
  let body: (T & { error?: string }) | null = null
  if (rawBody) {
    try { body = JSON.parse(rawBody) as T & { error?: string } } catch {
      if (response.ok) throw new Error(`${operation} returned invalid JSON.`)
    }
  }
  if (!response.ok) throw new Error(body?.error ?? `${operation} failed (HTTP ${response.status}).`)
  if (!body) throw new Error(`${operation} returned an empty response.`)
  return body
}

function eventTaskId(event: Row, snapshot: Snapshot): string | undefined {
  const payload = event['payload'] as Row | null
  if (typeof payload?.['task_id'] === 'string') return payload['task_id']
  if (event['entity_type'] === 'task') return text(event['entity_id'])
  if (event['entity_type'] === 'review') {
    return snapshot.reviews.find((review) => review['id'] === event['entity_id'])?.['task_id'] as string | undefined
  }
  if (event['entity_type'] === 'review_finding') {
    const finding = snapshot.findings.find((item) => item['id'] === event['entity_id'])
    return snapshot.reviews.find((item) => item['id'] === finding?.['review_id'])?.['task_id'] as string | undefined
  }
  if (event['entity_type'] === 'verification') {
    return snapshot.verifications.find((item) => item['id'] === event['entity_id'])?.['task_id'] as string | undefined
  }
  return undefined
}

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unauthorized, setUnauthorized] = useState(!hasCredential())
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await apiFetch('/api/snapshot', { signal })
      setSnapshot(await readApiResponse<Snapshot>(response, 'Snapshot service'))
      setUnauthorized(false)
      setError(null)
    } catch (requestError) {
      if ((requestError as Error).name === 'AbortError') return
      setUnauthorized(requestError instanceof UnauthorizedError)
      setError(requestError instanceof Error ? requestError.message : 'Could not load work')
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 2_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    const pull = async () => {
      try {
        const response = await apiFetch('/api/runtime', { signal: controller.signal })
        if (!response.ok) return
        const body = await readApiResponse<{ runtimes: RuntimeAgent[]; events: RuntimeEventRow[] }>(response, 'Runtime')
        setSnapshot((current) => (
          current ? { ...current, runtimes: body.runtimes, runtime_events: body.events } : current
        ))
      } catch (requestError) {
        if ((requestError as Error).name === 'AbortError') return
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), 500)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [])
  return { snapshot, setSnapshot, error, unauthorized, refresh }
}

function Artifact({ label, children, tone = 'neutral' }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <article className="artifact" data-tone={tone}>
      <div className="artifact-label">{label}</div>
      {children}
    </article>
  )
}

function ConfirmAction({
  label, title, description, pending, onConfirm, variant = 'outline',
}: {
  label: string
  title: string
  description: string
  pending: boolean
  onConfirm: () => Promise<void>
  variant?: 'default' | 'outline'
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size="sm" disabled={pending}>{pending ? 'Working…' : label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function StreamEvent({
  event, snapshot, pending, runMutation,
}: {
  event: Row
  snapshot: Snapshot
  pending: string | null
  runMutation: (key: string, path: string, body?: Row) => Promise<void>
}) {
  const id = text(event['entity_id'])
  const action = text(event['action'])
  const actor = text(event['actor'])
  const time = formatTime(event['timestamp'])

  if (action === 'runtime_activity') {
    const payload = (event['payload'] ?? {}) as RuntimeEventRow
    const kind = text(payload.kind)
    if (kind === 'output') {
      return (
        <Message align="start" data-actor={actor}>
          <MessageContent>
            <MessageHeader>
              <span>{workerLabel(actor)}</span>
              <span className="message-route">live</span>
            </MessageHeader>
            <Bubble variant="outline" align="start">
              <BubbleContent><MarkdownBody>{text(payload.body)}</MarkdownBody></BubbleContent>
            </Bubble>
            <MessageFooter>{time}</MessageFooter>
          </MessageContent>
        </Message>
      )
    }
    if (kind === 'thought') {
      return (
        <Message align="start" data-actor={actor} data-kind="thought">
          <MessageContent>
            <MessageHeader>
              <span>{workerLabel(actor)}</span>
              <span className="message-route">thinking</span>
            </MessageHeader>
            <Bubble variant="outline" align="start">
              <BubbleContent><p className="thought-body">{text(payload.body) || 'Thinking.'}</p></BubbleContent>
            </Bubble>
            <MessageFooter>{time}</MessageFooter>
          </MessageContent>
        </Message>
      )
    }
    return (
      <Marker variant="separator">
        <MarkerIcon><CircleDotIcon /></MarkerIcon>
        <MarkerContent>
          {workerLabel(actor)} · {text(payload.title) || kind}{time ? ` · ${time}` : ''}
        </MarkerContent>
      </Marker>
    )
  }

  if (action === 'message_sent') {
    const message = snapshot.messages.find((item) => item['id'] === id)
    if (!message) return null
    return (
      <Message align={actor === 'human' ? 'end' : 'start'} data-actor={actor}>
        <MessageContent>
          <MessageHeader>
            <span>{workerLabel(actor)}</span>
            {text(message['recipient']) !== actor && (
              <span className="message-route">to {workerLabel(text(message['recipient']))}</span>
            )}
          </MessageHeader>
          <Bubble variant={actor === 'human' ? 'tinted' : 'outline'} align={actor === 'human' ? 'end' : 'start'}>
            <BubbleContent><MarkdownBody>{text(message['body'])}</MarkdownBody></BubbleContent>
          </Bubble>
          <MessageFooter>{time}</MessageFooter>
        </MessageContent>
      </Message>
    )
  }
  if (action === 'decision_proposed') {
    const decision = snapshot.decisions.find((item) => item['id'] === id)
    if (!decision) return null
    return (
      <Artifact label="Decision" tone="decision">
        <MarkdownBody>{text(decision['statement'])}</MarkdownBody>
        {decision['status'] === 'proposed' && (
          <div className="artifact-action">
            <ConfirmAction
              label="Accept this"
              title="Accept this decision?"
              description="The team will treat this as agreed."
              pending={pending === `decision:${id}`}
              onConfirm={() => runMutation(`decision:${id}`, `/api/decisions/${encodeURIComponent(id)}/accept`)}
            />
          </div>
        )}
      </Artifact>
    )
  }
  if (action === 'proposals_revealed') {
    const proposals = snapshot.proposals.filter((proposal) => proposal['task_id'] === id && proposal['visibility'] === 'revealed')
    return (
      <Artifact label="Ideas shared" tone="proposal">
        <div className="proposal-stack">
          {proposals.map((proposal) => (
            <section key={text(proposal['id'])}>
              <strong>{workerLabel(text(proposal['agent_id']))}</strong>
              <MarkdownBody>{text(proposal['content'])}</MarkdownBody>
            </section>
          ))}
        </div>
      </Artifact>
    )
  }
  if (action.startsWith('verification_')) {
    const verification = snapshot.verifications.find((item) => item['id'] === id)
    if (!verification) return null
    const passed = Number(verification['exit_code']) === 0
    return (
      <Artifact label={passed ? 'Check passed' : 'Check failed'} tone={passed ? 'pass' : 'fail'}>
        <div className="artifact-title-row">{passed ? <ShieldCheckIcon /> : <TriangleAlertIcon />}<span>{workerLabel(text(verification['runner']))} ran the checks</span></div>
        <div className="artifact-meta"><span>{time}</span></div>
      </Artifact>
    )
  }
  if (action === 'review_requested' || action === 'review_approved' || action === 'review_needs_revision') {
    const review = snapshot.reviews.find((item) => item['id'] === id)
    if (!review) return null
    const label = action === 'review_approved' ? 'Review approved' : action === 'review_needs_revision' ? 'Needs changes' : 'Review started'
    return (
      <Artifact label={label} tone={review['verdict'] === 'approved' ? 'pass' : 'review'}>
        <p>{workerLabel(actor)} {action === 'review_requested' ? 'asked for a review' : 'finished a review'}.</p>
        <div className="artifact-meta"><span>{time}</span></div>
      </Artifact>
    )
  }
  if (action === 'review_finding_added') {
    const finding = snapshot.findings.find((item) => item['id'] === id)
    if (!finding) return null
    return (
      <Artifact label={text(finding['severity']) === 'blocking' ? 'Blocking note' : 'Review note'} tone={text(finding['severity']) === 'blocking' ? 'fail' : 'review'}>
        <p>{text(finding['description'])}</p>
      </Artifact>
    )
  }
  const story: Record<string, string> = {
    task_created: `${workerLabel(actor)} started this work`,
    task_roles_assigned: 'The team was assigned',
    task_file_added: 'A file was added to this work',
    task_accepted: 'This work was accepted',
    task_cancelled: 'This work was cancelled',
    lease_acquired: `${workerLabel(actor)} started implementing`,
    proposal_submitted: `${workerLabel(actor)} sent a private idea`,
    decision_accepted: 'A decision was accepted',
    worktree_managed: 'A workspace was set up',
  }
  if (action.startsWith('dispatch') || action.includes('bundle') || action.includes('session')) return null
  return (
    <Marker variant="separator">
      <MarkerIcon>{action.includes('accepted') ? <CheckIcon /> : <CircleDotIcon />}</MarkerIcon>
      <MarkerContent>{story[action] ?? `${workerLabel(actor)} · ${action.replaceAll('_', ' ')}`}{time ? ` · ${time}` : ''}</MarkerContent>
    </Marker>
  )
}

function App() {
  const { snapshot, setSnapshot, error, unauthorized } = useSnapshot()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => window.localStorage.getItem(TASK_KEY))
  const [filter, setFilter] = useState<Target>('global')
  const [composerTarget, setComposerTarget] = useState<Target>('global')
  const [queue, setQueue] = useState<QueueItem[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(QUEUE_KEY) ?? '[]') as QueueItem[] } catch { return [] }
  })
  const [queueDraft, setQueueDraft] = useState('')
  const [messageDraft, setMessageDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<string[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'work' | 'live' | 'side'>('live')
  const [atBottom, setAtBottom] = useState(true)
  const filesRef = useRef<HTMLInputElement>(null)
  const contextRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<VirtuosoHandle>(null)
  const booted = useRef(false)
  const promoteLock = useRef(false)

  const chooseTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId)
    if (taskId) window.localStorage.setItem(TASK_KEY, taskId)
    else window.localStorage.removeItem(TASK_KEY)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  }, [queue])

  useEffect(() => {
    if (!snapshot || booted.current) return
    booted.current = true
    const visible = snapshot.tasks.filter((task) => isVisibleWork(task))
    const stored = window.localStorage.getItem(TASK_KEY)
    if (stored && visible.some((task) => task['id'] === stored)) setSelectedTaskId(stored)
    else chooseTask(text(visible[0]?.['id'] ?? '', '') || null)
  }, [chooseTask, snapshot])

  useEffect(() => {
    if (!snapshot || !selectedTaskId) return
    const selected = snapshot.tasks.find((task) => task['id'] === selectedTaskId)
    if (selected && !isVisibleWork(selected)) {
      chooseTask(text(snapshot.tasks.filter((task) => isVisibleWork(task))[0]?.['id'] ?? '', '') || null)
    }
  }, [chooseTask, selectedTaskId, snapshot])

  const currentWork = snapshot?.tasks.filter((task) => isVisibleWork(task)) ?? []
  const completedWork = snapshot?.tasks.filter((task) => text(task['status']) === 'accepted') ?? []
  const selectedTask = snapshot?.tasks.find((task) => task['id'] === selectedTaskId)
  const taskFiles = (snapshot?.task_attachments ?? [])
    .filter((link) => link['task_id'] === selectedTaskId)
    .map((link) => snapshot?.attachments.find((file) => file['id'] === link['attachment_id']))
    .filter((file): file is Row => Boolean(file))
  const sealed = snapshot?.proposals.filter((item) => item['task_id'] === selectedTaskId && item['visibility'] === 'sealed') ?? []
  const stream = useMemo(() => {
    if (!snapshot) return []
    const coordination = snapshot.events.filter((event) => {
      if (selectedTaskId && eventTaskId(event, snapshot) !== selectedTaskId) return false
      if (filter === 'global') return true
      return text(event['actor']) === filter
    })
    const live = (snapshot.runtime_events ?? [])
      .map(asRuntimeStreamEvent)
      .filter((event) => filter === 'global' || text(event['actor']) === filter)
    return [...coordination, ...live].sort((left, right) => {
      const leftTime = Date.parse(text(left['timestamp']))
      const rightTime = Date.parse(text(right['timestamp']))
      if (leftTime !== rightTime) return leftTime - rightTime
      return String(left['id']).localeCompare(String(right['id']), undefined, { numeric: true })
    })
  }, [filter, selectedTaskId, snapshot])

  const runMutation = useCallback(async (key: string, path: string, body?: Row) => {
    setPending(key)
    setActionError(null)
    try {
      const response = await apiFetch(path, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      setSnapshot(await readApiResponse<Snapshot>(response, 'Action'))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That didn’t work')
    } finally {
      setPending(null)
    }
  }, [setSnapshot])

  const runHuman = useCallback(async (key: string, operation: string, input: Row = {}) => {
    setPending(key)
    setActionError(null)
    try {
      const response = await humanOperation(operation, input)
      setSnapshot(await readApiResponse<Snapshot>(response, 'Action'))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That didn’t work')
      throw err
    } finally {
      setPending(null)
    }
  }, [setSnapshot])

  const startWork = useCallback(async (goal: string) => {
    const id = newId('TASK').toUpperCase()
    await runHuman('create', 'task.create', { id, goal, acceptance: [] })
    try { await runHuman('roles', 'task.assign_roles', { taskId: id, ...defaultRoles() }) } catch { /* already assigned */ }
    chooseTask(id)
  }, [chooseTask, runHuman])

  const addJob = useCallback((title: string) => {
    setQueue((items) => [...items, { id: newId('queue'), title }])
  }, [])

  const removeJob = useCallback((id: string) => {
    setQueue((items) => items.filter((row) => row.id !== id))
  }, [])

  const openFile = useCallback((file: Row) => {
    void apiFetch(`/api/attachments/${encodeURIComponent(text(file['id']))}`)
      .then((response) => readApiResponse<Row>(response, 'File'))
      .then((body) => {
        const blob = new Blob([text(body['body'])], { type: text(body['media_type'], 'text/plain') })
        window.open(URL.createObjectURL(blob), '_blank', 'noopener')
      })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : 'Could not open file'))
  }, [])

  useEffect(() => {
    if (!snapshot || promoteLock.current || pending !== null) return
    if (snapshot.tasks.some((task) => isVisibleWork(task))) return
    const next = queue[0]
    if (!next) return
    promoteLock.current = true
    void startWork(next.title)
      .then(() => {
        setQueue((items) => items.filter((row) => row.id !== next.id))
      })
      .catch(() => undefined)
      .finally(() => {
        promoteLock.current = false
      })
  }, [pending, queue, snapshot, startWork])

  const needsYou = (() => {
    if (!snapshot || !selectedTaskId || !selectedTask) return null as null | { text: string; kind: 'start' | 'share' | 'approve' }
    const waitingAssign = Object.values(snapshot.derived_actions ?? {}).some((worker) => {
      const result = worker.tasks?.find((row) => row.task_id === selectedTaskId)
      return result?.kind === 'waiting' && result.actor === 'human' && result.action_kind === 'assign_roles'
    })
    if (waitingAssign) return { text: 'The team needs you to start this work.', kind: 'start' as const }
    if (sealed.length > 0) return { text: 'The team has private ideas ready to share.', kind: 'share' as const }
    if (selectedTask['status'] === 'in_review' || Object.values(snapshot.derived_actions ?? {}).some((worker) => {
      const result = worker.tasks?.find((row) => row.task_id === selectedTaskId)
      return result?.kind === 'waiting' && result.actor === 'human' && result.action_kind === 'accept'
    })) {
      return { text: 'The work passed review and checks.', kind: 'approve' as const }
    }
    return null
  })()

  return (
    <main className="board" data-panel={mobilePanel}>
      <header className="board-header">
        <div className="board-brand">
          <h1>SCRAPGRID</h1>
        </div>
        <div className="board-title chat-measure">
          <span className="building-now">Building now</span>
          <strong>{selectedTask ? taskTitle(selectedTask) : 'Nothing yet — add a job on the left'}</strong>
        </div>
        <div className="board-actions">
          <Button size="sm" variant="outline" onClick={() => setShowHistory((open) => !open)}>{showHistory ? 'Hide history' : 'History'}</Button>
        </div>
        <div className="mobile-nav">
          <Button size="xs" variant={mobilePanel === 'work' ? 'default' : 'outline'} onClick={() => setMobilePanel('work')}>Work</Button>
          <Button size="xs" variant={mobilePanel === 'live' ? 'default' : 'outline'} onClick={() => setMobilePanel('live')}>Live</Button>
          <Button size="xs" variant={mobilePanel === 'side' ? 'default' : 'outline'} onClick={() => setMobilePanel('side')}>Files</Button>
        </div>
      </header>

      <div className="board-body">
        <aside className="col col-work">
          <div className="col-stack">
            <h2 className="col-heading">Build queue</h2>
            <section className="queue-group">
              <p className="section-kicker">Now</p>
              <div className="queue-lane">
                <VirtualList
                  data={currentWork}
                  itemKey={(task) => text(task['id'])}
                  empty="Nothing yet. Add a job below."
                  itemContent={(_index, task) => (
                    <button type="button" className="work-item" data-current={task['id'] === selectedTaskId || undefined} onClick={() => chooseTask(text(task['id']))}>
                      <span className={task['id'] === selectedTaskId ? 'dot dot-live' : 'dot'} />
                      <strong>{taskTitle(task)}</strong>
                      {task['id'] === selectedTaskId && <Badge>Now</Badge>}
                    </button>
                  )}
                />
              </div>
            </section>
            <section className="queue-group">
              <p className="section-kicker">Up next</p>
              <div className="queue-lane">
                <VirtualList
                  data={queue}
                  itemKey={(item) => item.id}
                  empty="Queue is empty."
                  itemContent={(index, item) => (
                    <div className="work-item work-item-queued">
                      <span className="queue-index">{index + 1}.</span>
                      <strong>{item.title}</strong>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="queue-remove"
                        aria-label={`Remove ${item.title} from the queue`}
                        onClick={() => removeJob(item.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  )}
                />
              </div>
            </section>
            <section className="queue-group">
              <p className="section-kicker">Done</p>
              <div className="queue-lane">
                <VirtualList
                  data={completedWork}
                  itemKey={(task) => text(task['id'])}
                  empty="None yet."
                  itemContent={(_index, task) => (
                    <button type="button" className="work-item work-item-done" onClick={() => chooseTask(text(task['id']))}>
                      <CheckIcon />
                      <strong>{taskTitle(task)}</strong>
                    </button>
                  )}
                />
              </div>
            </section>
            <form
              className="queue-form"
              onSubmit={(event) => {
                event.preventDefault()
                const title = queueDraft.trim()
                if (!title) return
                addJob(title)
                setQueueDraft('')
              }}
            >
              <Input value={queueDraft} onChange={(event) => setQueueDraft(event.target.value)} placeholder="i.e. Player Movement" aria-label="Add next job" />
              <Button type="submit" size="sm">Add next job</Button>
            </form>
          </div>
        </aside>

        <section className="col col-live" aria-label="Live collaboration">
          <div className="live-stage">
            <div className="live-head chat-measure">
              <h2 className="col-heading">The team</h2>
              {snapshot && (
                <div className="worker-grid">
                  {WORKERS.map((id) => {
                    const busy = workerIsBusy(snapshot, id)
                    const presence = workerPresence(snapshot, id)
                    const status = selectedTaskId
                      ? whatTheyAreDoing(snapshot, selectedTaskId, id)
                      : presence === 'not_connected'
                        ? 'Not connected.'
                        : presence === 'working'
                          ? (runtimeOf(snapshot, id)?.summary ?? 'Working.')
                          : presence === 'disconnected'
                            ? 'Disconnected.'
                            : 'Connected. Idle.'
                    return (
                      <Card
                        key={id}
                        className="worker-card"
                        data-worker={id}
                        data-busy={busy || undefined}
                        data-presence={presence}
                      >
                        <CardHeader>
                          <div className="worker-name">
                            <strong>{workerLabel(id)}</strong>
                            <Badge variant={busy ? 'secondary' : 'outline'}>{presenceLabel(presence, busy)}</Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="worker-status">{status}</p>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              )}
              <Separator />
              {error && !unauthorized && (
                <Alert variant="destructive">
                  <AlertTitle>Couldn’t load work</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {actionError && (
                <Alert variant="destructive">
                  <AlertTitle>Couldn’t do that</AlertTitle>
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              )}
              {unauthorized && !snapshot && (
                <Alert>
                  <AlertTitle>Open this from the launcher</AlertTitle>
                  <AlertDescription>{CREDENTIAL_HINT}</AlertDescription>
                </Alert>
              )}
              <Tabs value={filter} onValueChange={(value) => setFilter(value as Target)}>
                <TabsList className="w-full" aria-label="Whose work to show">
                  <TabsTrigger value="global">Everyone</TabsTrigger>
                  {WORKERS.map((id) => (
                    <TabsTrigger key={id} value={id}>{workerLabel(id)}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {showHistory && snapshot && (
                <p className="quiet">History is the live stream below. Filter with the tabs.</p>
              )}
            </div>
            <div className="stream-well chat-measure">
              <div className="stream-wrap">
                {!snapshot ? (
                  <div className="empty-live">
                    <h3>Loading the room…</h3>
                    <p>The team will show up here.</p>
                  </div>
                ) : stream.length === 0 ? (
                  <div className="empty-live">
                    <h3>Waiting for the team</h3>
                    <p>Nothing from them yet. Tell them what you want below.</p>
                  </div>
                ) : (
                  <Virtuoso
                    key={`${selectedTaskId}:${filter}`}
                    ref={streamRef}
                    className="stream-virtuoso"
                    data={stream}
                    components={virtuosoComponents}
                    computeItemKey={(_index, event) => String(event['id'])}
                    initialTopMostItemIndex={{ index: stream.length - 1, align: 'end' }}
                    followOutput="auto"
                    atBottomStateChange={setAtBottom}
                    itemContent={(_index, event) => (
                      <div className="stream-item">
                        <StreamEvent event={event} snapshot={snapshot} pending={pending} runMutation={runMutation} />
                      </div>
                    )}
                  />
                )}
                {!atBottom && stream.length > 0 && (
                  <Button className="stream-latest" size="icon-sm" variant="secondary" onClick={() => streamRef.current?.scrollToIndex({ index: stream.length - 1, align: 'end' })}>
                    <ArrowDownIcon />
                    <span className="sr-only">Jump to latest</span>
                  </Button>
                )}
              </div>
            </div>
            <form
              className="composer chat-measure"
              onSubmit={(event) => {
                event.preventDefault()
                const body = messageDraft.trim()
                if (!body) return
                void (async () => {
                  let taskId = selectedTaskId ?? (text(currentWork[0]?.['id'] ?? '', '') || null)
                  if (!taskId) {
                    await startWork(body.slice(0, 120))
                    taskId = window.localStorage.getItem(TASK_KEY)
                  }
                  if (!taskId) return
                  const files = await readTextFiles(filesRef.current?.files ?? null)
                  const targets = composerTarget === 'global' ? [...WORKERS] : [composerTarget]
                  for (const to of targets) {
                    await runHuman('message', 'message.send', { to, taskId, body, files })
                  }
                  setMessageDraft('')
                  setPendingFiles([])
                  if (filesRef.current) filesRef.current.value = ''
                })().catch(() => undefined)
              }}
            >
              {pendingFiles.length > 0 && (
                <p className="composer-files">With this message: {pendingFiles.join(', ')}</p>
              )}
              <div className="composer-row">
                <Select
                  value={composerTarget}
                  onValueChange={(value) => setComposerTarget(value as Target)}
                >
                  <SelectTrigger
                    id="message-to"
                    size="sm"
                    className="shrink-0"
                    aria-label="Send to"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectGroup>
                      <SelectItem value="global">Everyone</SelectItem>
                      {WORKERS.map((id) => (
                        <SelectItem key={id} value={id}>{workerLabel(id)}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Attach a file to this message"
                      onClick={() => filesRef.current?.click()}
                    >
                      <PlusIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach a file</TooltipContent>
                </Tooltip>
                <input
                  ref={filesRef}
                  className="sr-only"
                  type="file"
                  multiple
                  accept=".md,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.xml"
                  onChange={(event) => setPendingFiles(Array.from(event.target.files ?? []).map((file) => file.name))}
                />
                <label className="sr-only" htmlFor="team-message">Message</label>
                <Textarea
                  id="team-message"
                  value={messageDraft}
                  rows={1}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="Tell the team what you need…"
                  required
                  className="min-h-11 max-h-40"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="submit"
                      size="icon"
                      disabled={pending !== null || messageDraft.trim().length === 0}
                      aria-label="Send"
                    >
                      <ArrowUpIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send</TooltipContent>
                </Tooltip>
              </div>
            </form>
          </div>
        </section>

        <aside className="col col-side">
            <div className="col-stack">
              <Card className="files-card">
                <CardHeader>
                  <h2 className="col-heading">Project files</h2>
                </CardHeader>
                <CardContent className="files-card-body">
                  <VirtualList
                    data={taskFiles}
                    itemKey={(file) => text(file['id'])}
                    empty="Docs the team should keep."
                    itemContent={(_index, file) => (
                      <button type="button" className="file-row" onClick={() => openFile(file)}>
                        {text(file['filename'])}
                      </button>
                    )}
                  />
                </CardContent>
                <CardFooter>
                  <label className="attach">
                    <Button size="sm" variant="outline" asChild>
                      <span>Add files</span>
                    </Button>
                    <input
                      ref={contextRef}
                      type="file"
                      multiple
                      accept=".md,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.xml"
                      onChange={() => {
                        if (!selectedTaskId) {
                          setActionError('Add a job first, then add files.')
                          return
                        }
                        void readTextFiles(contextRef.current?.files ?? null).then((files) => {
                          if (files.length === 0) return
                          return runHuman('brief', 'task.file.add', { taskId: selectedTaskId, files })
                        }).catch(() => undefined)
                      }}
                    />
                  </label>
                </CardFooter>
              </Card>
              <Card className="needs-card" data-alert={needsYou ? true : undefined}>
                <CardHeader>
                  <h2 className="col-heading">Needs Your Attention</h2>
                </CardHeader>
                <CardContent>
                  {!needsYou ? (
                    <p className="ok-note">Nothing right now</p>
                  ) : (
                    <div className="needs-you">
                      <p>{needsYou.text}</p>
                      {needsYou.kind === 'start' && selectedTaskId && (
                        <Button
                          size="sm"
                          disabled={pending !== null}
                          onClick={() => {
                            void runHuman('roles', 'task.assign_roles', { taskId: selectedTaskId, ...defaultRoles() }).catch(() => undefined)
                          }}
                        >
                          Start work
                        </Button>
                      )}
                      {needsYou.kind === 'share' && selectedTaskId && (
                        <ConfirmAction
                          label="See ideas"
                          title="Share the team’s ideas?"
                          description="They wrote these separately. Sharing lets everyone see them."
                          pending={pending === `reveal:${selectedTaskId}`}
                          onConfirm={() => runMutation(`reveal:${selectedTaskId}`, `/api/tasks/${encodeURIComponent(selectedTaskId)}/reveal-proposals`)}
                        />
                      )}
                      {needsYou.kind === 'approve' && selectedTask && (
                        <ConfirmAction
                          label="Approve"
                          title="Approve this work?"
                          description="Say this is done."
                          pending={pending === `accept:${selectedTaskId}`}
                          variant="default"
                          onConfirm={() => runMutation(`accept:${selectedTaskId}`, `/api/tasks/${encodeURIComponent(selectedTaskId ?? '')}/accept`, { expected_version: selectedTask['version'] })}
                        />
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
              <details className="tech">
                <summary>Technical details</summary>
                <pre>
{selectedTask
  ? `status ${text(selectedTask['status'])}\nbase ${shortSha(selectedTask['base_commit'])}\ncandidate ${shortSha(selectedTask['candidate_commit'])}`
  : 'No work selected'}
                </pre>
              </details>
            </div>
        </aside>
      </div>
    </main>
  )
}

export default App
