import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckIcon,
  CircleDotIcon,
  GitBranchIcon,
  PaperclipIcon,
  PanelRightIcon,
  ShieldCheckIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { createCodePlugin } from '@streamdown/code'
import { Streamdown, type Components } from 'streamdown'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Badge } from '@/components/ui/badge'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '@/components/ui/message'
import { Skeleton } from '@/components/ui/skeleton'
import './App.css'

type Row = Record<string, unknown>

interface DerivedTaskResult {
  kind: string
  task_id: string
  actor?: string | null
  action_kind?: string
  reason?: string
  action?: Row
}

interface DerivedWorker {
  session?: { session_id?: string | null; liveness?: string; work_in_flight?: boolean }
  deliverable?: boolean
  tasks?: DerivedTaskResult[]
}

interface Snapshot {
  project: Row
  repository: Row
  agents: Row[]
  sessions: Row[]
  tasks: Row[]
  leases: Row[]
  claim_reservations: Row[]
  task_roles: Row[]
  worktrees: Row[]
  messages: Row[]
  proposals: Row[]
  decisions: Row[]
  blockers: Row[]
  reviews: Row[]
  findings: Row[]
  verifications: Row[]
  check_policy_overrides: Row[]
  dispatches: Row[]
  context_bundles: Row[]
  operations: Row[]
  events: Row[]
  attachments: Row[]
  message_attachments: Row[]
  task_attachments: Row[]
  derived_actions: Record<string, DerivedWorker>
}

const StreamList = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={['stream-content', className].filter(Boolean).join(' ')} {...props} />
  ),
)
StreamList.displayName = 'StreamList'

const virtuosoComponents = { List: StreamList }
const markdownPlugins = {
  code: createCodePlugin({ themes: ['github-dark', 'github-dark'] }),
}
const markdownComponents: Components = {
  h1: 'h3',
  h2: 'h4',
  h3: 'h5',
  h4: 'h6',
  h5: 'h6',
  h6: 'h6',
}

const actorNames: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  human: 'Human',
}

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function shortSha(value: unknown): string {
  const sha = text(value)
  return sha === '—' ? sha : sha.slice(0, 9)
}

function formatTime(value: unknown): string {
  const date = new Date(text(value, ''))
  if (Number.isNaN(date.valueOf())) return 'time unknown'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function titleCase(value: unknown): string {
  return text(value).replaceAll('_', ' ')
}

function sessionForAgent(snapshot: Snapshot, agentId: string): Row | undefined {
  return snapshot.sessions.find((session) => session['agent_id'] === agentId && session['status'] === 'open')
}

async function readTextFiles(list: FileList | null): Promise<Array<{ filename: string; content: string }>> {
  if (!list || list.length === 0) return []
  return Promise.all(
    Array.from(list).map(async (file) => ({ filename: file.name, content: await file.text() })),
  )
}

const TASK_STORAGE_KEY = 'scrapgrid.selected-task'
const WORKER_STORAGE_KEY = 'scrapgrid.selected-worker'

function taskTitle(task: Row | undefined): string {
  return text(task?.['goal'], 'Untitled work')
}

function isVisibleWork(task: Row): boolean {
  const id = text(task['id'])
  const goal = text(task['goal']).toLowerCase()
  if (id === 'TASK-OPX') return false
  if (goal.includes('disposable')) return false
  if (goal.includes('operator experience')) return false
  return !['accepted', 'cancelled'].includes(text(task['status']))
}

function newTaskId(): string {
  return `TASK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
}

function defaultRoles(talkingTo: string): { implementer: string; reviewer: string; verifier: string } {
  if (talkingTo === 'claude') return { implementer: 'claude', reviewer: 'codex', verifier: 'grok' }
  if (talkingTo === 'grok') return { implementer: 'grok', reviewer: 'claude', verifier: 'codex' }
  return { implementer: 'codex', reviewer: 'claude', verifier: 'grok' }
}

function messageFiles(snapshot: Snapshot, messageId: string): Row[] {
  return (snapshot.message_attachments ?? [])
    .filter((link) => link['message_id'] === messageId)
    .map((link) => snapshot.attachments.find((file) => file['id'] === link['attachment_id']))
    .filter((file): file is Row => Boolean(file))
}

function MarkdownBody({ children, className }: { children: string; className?: string }) {
  return (
    <Streamdown
      className={['markdown-body', className].filter(Boolean).join(' ')}
      components={markdownComponents}
      mode="static"
      plugins={markdownPlugins}
    >
      {children}
    </Streamdown>
  )
}

async function readApiResponse<T>(response: Response, operation: string): Promise<T> {
  const rawBody = await response.text()
  let body: (T & { error?: string }) | null = null

  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as T & { error?: string }
    } catch {
      if (response.ok) throw new Error(`${operation} returned invalid JSON.`)
    }
  }

  if (!response.ok) {
    const fallback = response.status >= 500
      ? `${operation} unavailable (HTTP ${response.status}). Start npm run dev:api alongside npm run dev.`
      : `${operation} failed (HTTP ${response.status}).`
    throw new Error(body?.error ?? fallback)
  }

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
    const review = snapshot.reviews.find((item) => item['id'] === finding?.['review_id'])
    return review?.['task_id'] as string | undefined
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
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await apiFetch('/api/snapshot', { signal })
      const body = await readApiResponse<Snapshot>(response, 'Snapshot service')
      setSnapshot(body)
      setLastUpdated(new Date())
      setUnauthorized(false)
      setError(null)
    } catch (requestError) {
      if ((requestError as Error).name === 'AbortError') return
      setUnauthorized(requestError instanceof UnauthorizedError)
      setError(requestError instanceof Error ? requestError.message : 'Snapshot unavailable')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(controller.signal), 2_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [refresh])

  return { snapshot, setSnapshot, error, unauthorized, lastUpdated, refresh }
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
  label,
  title,
  description,
  pending,
  disabled,
  onConfirm,
  variant = 'outline',
}: {
  label: string
  title: string
  description: string
  pending: boolean
  disabled?: boolean
  onConfirm: () => Promise<void>
  variant?: 'default' | 'outline'
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size="sm" disabled={disabled || pending}>
          {pending ? 'Working…' : label}
        </Button>
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
  event,
  snapshot,
  pending,
  runMutation,
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
  const payload = (event['payload'] as Row | null) ?? {}

  if (action === 'message_sent') {
    const message = snapshot.messages.find((item) => item['id'] === id)
    if (!message) return null
    return (
      <Message align={actor === 'human' ? 'end' : 'start'} data-actor={actor}>
        <MessageContent>
          <MessageHeader>
            <span>{actorNames[actor] ?? actor}</span>
            <span className="message-route">→ {actorNames[text(message['recipient'])] ?? text(message['recipient'])}</span>
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
    const mutationKey = `decision:${id}`
    return (
      <Artifact label="Decision proposed" tone="decision">
        <MarkdownBody className="decision-statement">{text(decision['statement'])}</MarkdownBody>
        <MarkdownBody className="decision-rationale">{text(decision['rationale'])}</MarkdownBody>
        <div className="artifact-meta">
          <span>{actorNames[actor] ?? actor}</span>
          <span>{time}</span>
          <Badge variant={decision['status'] === 'accepted' ? 'default' : 'outline'}>{text(decision['status'])}</Badge>
        </div>
        {decision['status'] === 'proposed' && (
          <div className="artifact-action">
            <ConfirmAction
              label="Accept decision"
              title="Accept this decision?"
              description="The existing CollaborationService will record human acceptance."
              pending={pending === mutationKey}
              onConfirm={() => runMutation(mutationKey, `/api/decisions/${encodeURIComponent(id)}/accept`)}
            />
          </div>
        )}
      </Artifact>
    )
  }

  if (action === 'proposals_revealed') {
    const proposals = snapshot.proposals.filter(
      (proposal) => proposal['task_id'] === id && proposal['visibility'] === 'revealed',
    )
    return (
      <Artifact label="Proposals revealed" tone="proposal">
        <div className="proposal-stack">
          {proposals.map((proposal) => (
            <section key={text(proposal['id'])} className="proposal">
              <strong>{actorNames[text(proposal['agent_id'])] ?? text(proposal['agent_id'])}</strong>
              <MarkdownBody>{text(proposal['content'])}</MarkdownBody>
            </section>
          ))}
        </div>
        <div className="artifact-meta"><span>Human</span><span>{time}</span></div>
      </Artifact>
    )
  }

  if (action.startsWith('verification_')) {
    const verification = snapshot.verifications.find((item) => item['id'] === id)
    if (!verification) return null
    const passed = Number(verification['exit_code']) === 0
    const command = Array.isArray(verification['command_argv'])
      ? verification['command_argv'].map(String).join(' ')
      : text(verification['command'])
    return (
      <Artifact label={passed ? 'Verification passed' : 'Verification failed'} tone={passed ? 'pass' : 'fail'}>
        <div className="artifact-title-row">
          {passed ? <ShieldCheckIcon /> : <TriangleAlertIcon />}
          <code>{command}</code>
        </div>
        <div className="artifact-meta">
          <span>{actorNames[text(verification['runner'])] ?? text(verification['runner'])}</span>
          <span>exit {String(verification['exit_code'])}</span>
          <span>{shortSha(verification['commit_sha'])}</span>
          <span>{time}</span>
        </div>
      </Artifact>
    )
  }

  if (action === 'review_requested' || action === 'review_approved' || action === 'review_needs_revision') {
    const review = snapshot.reviews.find((item) => item['id'] === id)
    if (!review) return null
    const findings = snapshot.findings.filter((finding) => finding['review_id'] === id)
    return (
      <Artifact label={titleCase(action)} tone={review['verdict'] === 'approved' ? 'pass' : 'review'}>
        <div className="artifact-title-row">
          <GitBranchIcon />
          <strong>{shortSha(review['commit_sha'])}</strong>
          <Badge variant={review['verdict'] === 'approved' ? 'default' : 'outline'}>{text(review['verdict'])}</Badge>
        </div>
        {findings.length > 0 && <p>{findings.length} finding{findings.length === 1 ? '' : 's'} attached</p>}
        <div className="artifact-meta"><span>{actorNames[actor] ?? actor}</span><span>{time}</span></div>
      </Artifact>
    )
  }

  if (action === 'review_finding_added') {
    const finding = snapshot.findings.find((item) => item['id'] === id)
    if (!finding) return null
    return (
      <Artifact label={`${titleCase(finding['severity'])} finding`} tone={finding['severity'] === 'blocking' ? 'fail' : 'review'}>
        <p>{text(finding['description'])}</p>
        {finding['location'] ? <code>{text(finding['location'])}</code> : null}
        <div className="artifact-meta">
          <span>{actorNames[text(finding['raised_by'])] ?? text(finding['raised_by'])}</span>
          <Badge variant={finding['status'] === 'open' ? 'outline' : 'secondary'}>{text(finding['status'])}</Badge>
          <span>{time}</span>
        </div>
      </Artifact>
    )
  }

  if (action === 'blocker_added') {
    const blocker = snapshot.blockers.find((item) => item['id'] === id)
    if (!blocker) return null
    return (
      <Artifact label="Blocker raised" tone="fail">
        <p>{text(blocker['description'])}</p>
        <div className="artifact-meta"><span>{actorNames[actor] ?? actor}</span><span>{time}</span></div>
      </Artifact>
    )
  }

  const detail = action === 'lease_acquired'
    ? `${actorNames[actor] ?? actor} claimed ${id}`
    : action === 'task_created'
      ? `${actorNames[actor] ?? actor} created ${id}`
      : action === 'task_accepted'
        ? `${id} accepted by human`
        : action === 'proposal_submitted'
          ? `${actorNames[actor] ?? actor} sealed a proposal`
          : action === 'decision_accepted'
            ? 'Decision accepted by human'
            : action === 'worktree_managed'
              ? `${text(payload['branch'])} registered at ${shortSha(payload['head_commit'])}`
              : `${actorNames[actor] ?? actor} · ${titleCase(action)}`

  return (
    <Marker variant="separator">
      <MarkerIcon>{action.includes('accepted') ? <CheckIcon /> : <CircleDotIcon />}</MarkerIcon>
      <MarkerContent>{detail} · {time}</MarkerContent>
    </Marker>
  )
}

function LoadingShell() {
  return (
    <div className="loading-shell" aria-label="Loading collaboration state">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-24 w-3/4" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-32 w-4/5" />
    </div>
  )
}

function App() {
  const { snapshot, setSnapshot, error, unauthorized, refresh } = useSnapshot()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => window.localStorage.getItem(TASK_STORAGE_KEY))
  const [selectedWorkerId, setSelectedWorkerId] = useState(() => window.localStorage.getItem(WORKER_STORAGE_KEY) ?? 'codex')
  const [view, setView] = useState<'chat' | 'activity'>('chat')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'nav' | 'chat' | 'details' | 'activity'>('chat')
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [streamAtBottom, setStreamAtBottom] = useState(true)
  const [goalDraft, setGoalDraft] = useState('')
  const [messageDraft, setMessageDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<string[]>([])
  const messageFilesRef = useRef<HTMLInputElement>(null)
  const briefingFilesRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<VirtuosoHandle>(null)
  const restored = useRef(false)

  const chooseTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId)
    setView('chat')
    setMobilePanel('chat')
    if (taskId) window.localStorage.setItem(TASK_STORAGE_KEY, taskId)
    else window.localStorage.removeItem(TASK_STORAGE_KEY)
  }, [])

  const chooseWorker = useCallback((workerId: string) => {
    setSelectedWorkerId(workerId)
    setView('chat')
    setMobilePanel('chat')
    window.localStorage.setItem(WORKER_STORAGE_KEY, workerId)
  }, [])

  useEffect(() => {
    if (!snapshot || restored.current) return
    restored.current = true
    const stored = window.localStorage.getItem(TASK_STORAGE_KEY)
    const visible = snapshot.tasks.filter((task) => isVisibleWork(task))
    if (stored && visible.some((task) => task['id'] === stored)) {
      setSelectedTaskId(stored)
      return
    }
    chooseTask(text(visible[0]?.['id'] ?? '', '') || null)
  }, [snapshot, chooseTask])

  useEffect(() => {
    if (!snapshot || !selectedTaskId) return
    const selected = snapshot.tasks.find((task) => task['id'] === selectedTaskId)
    if (selected && !isVisibleWork(selected)) {
      const visible = snapshot.tasks.filter((task) => isVisibleWork(task))
      chooseTask(text(visible[0]?.['id'] ?? '', '') || null)
    }
  }, [chooseTask, selectedTaskId, snapshot])

  useEffect(() => setStreamAtBottom(true), [selectedTaskId, view])

  const selectedTask = snapshot?.tasks.find((task) => task['id'] === selectedTaskId)
  const stream = useMemo(() => {
    if (!snapshot) return []
    return snapshot.events.filter((event) => {
      if (!selectedTaskId) return true
      return eventTaskId(event, snapshot) === selectedTaskId
    })
  }, [selectedTaskId, snapshot])

  const runMutation = useCallback(async (key: string, path: string, body?: Row) => {
    setPending(key)
    setMutationError(null)
    try {
      const response = await apiFetch(path, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const result = await readApiResponse<Snapshot>(response, 'Action')
      setSnapshot(result)
    } catch (actionError) {
      setMutationError(actionError instanceof Error ? actionError.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }, [setSnapshot])

  const runHuman = useCallback(async (key: string, operation: string, input: Row = {}) => {
    setPending(key)
    setMutationError(null)
    try {
      const response = await humanOperation(operation, input)
      const result = await readApiResponse<Snapshot>(response, 'Action')
      setSnapshot(result)
    } catch (actionError) {
      setMutationError(actionError instanceof Error ? actionError.message : 'Action failed')
      throw actionError
    } finally {
      setPending(null)
    }
  }, [setSnapshot])

  const ensureWork = useCallback(async (goalHint?: string): Promise<string> => {
    let taskId = selectedTaskId
    if (!taskId) {
      taskId = newTaskId()
      await runHuman('create', 'task.create', {
        id: taskId,
        goal: (goalHint ?? 'New conversation').trim().slice(0, 160) || 'New conversation',
        acceptance: [],
      })
      chooseTask(taskId)
    }
    const alreadyAssigned = (snapshot?.task_roles ?? []).some((role) => role['task_id'] === taskId)
    if (!alreadyAssigned) {
      const roles = defaultRoles(selectedWorkerId)
      try {
        await runHuman('roles', 'task.assign_roles', { taskId, ...roles })
      } catch {
        // Already assigned between snapshot and this click.
      }
    }
    return taskId
  }, [chooseTask, runHuman, selectedTaskId, selectedWorkerId, snapshot?.task_roles])

  const openAttachment = useCallback((id: string) => {
    void apiFetch(`/api/attachments/${encodeURIComponent(id)}`)
      .then((response) => readApiResponse<Row>(response, 'Attachment'))
      .then((body) => {
        const blob = new Blob([text(body['body'])], { type: text(body['media_type'], 'text/plain') })
        window.open(URL.createObjectURL(blob), '_blank', 'noopener')
      })
      .catch((loadError: unknown) => {
        setMutationError(loadError instanceof Error ? loadError.message : 'Attachment unavailable')
      })
  }, [])

  const sealedProposals = snapshot?.proposals.filter(
    (proposal) => proposal['task_id'] === selectedTaskId && proposal['visibility'] === 'sealed',
  ) ?? []
  const modelAgents = snapshot?.agents.filter((agent) => agent['kind'] === 'model') ?? []
  const conversationItems = useMemo(() => {
    if (!snapshot || !selectedTask) return []
    const thread = snapshot.messages.filter((message) => {
      if (message['task_id'] !== selectedTaskId) return false
      const parties = [text(message['sender']), text(message['recipient'])]
      return parties.includes('human') && parties.includes(selectedWorkerId)
    })
    const reviews = snapshot.reviews.filter(
      (review) => review['task_id'] === selectedTaskId && (review['reviewer'] === selectedWorkerId || review['requester'] === selectedWorkerId),
    )
    const items: Array<{ key: string; at: string; type: string; row: Row }> = []
    for (const message of thread) {
      items.push({ key: `message:${text(message['id'])}`, at: text(message['created_at']), type: 'message', row: message })
    }
    for (const proposal of snapshot.proposals.filter((item) => item['task_id'] === selectedTaskId && item['agent_id'] === selectedWorkerId)) {
      items.push({ key: `proposal:${text(proposal['id'])}`, at: text(proposal['created_at']), type: 'proposal', row: proposal })
    }
    for (const review of reviews) {
      items.push({ key: `review:${text(review['id'])}`, at: text(review['submitted_at'] ?? review['created_at']), type: 'review', row: review })
    }
    for (const finding of snapshot.findings.filter((item) => item['raised_by'] === selectedWorkerId && reviews.some((review) => review['id'] === item['review_id']))) {
      items.push({ key: `finding:${text(finding['id'])}`, at: text(finding['created_at']), type: 'finding', row: finding })
    }
    for (const verification of snapshot.verifications.filter((item) => item['task_id'] === selectedTaskId && item['runner'] === selectedWorkerId)) {
      items.push({ key: `verification:${text(verification['id'])}`, at: text(verification['created_at']), type: 'verification', row: verification })
    }
    return items.sort((left, right) => left.at.localeCompare(right.at) || left.key.localeCompare(right.key))
  }, [selectedTask, selectedTaskId, selectedWorkerId, snapshot])
  const taskFiles = (snapshot?.task_attachments ?? [])
    .filter((link) => link['task_id'] === selectedTaskId)
    .map((link) => snapshot?.attachments.find((file) => file['id'] === link['attachment_id']))
    .filter((file): file is Row => Boolean(file))
  const currentWork = snapshot?.tasks.filter((task) => isVisibleWork(task)) ?? []
  const workerName = actorNames[selectedWorkerId] ?? selectedWorkerId

  return (
    <main className={`messenger-shell${inspectorOpen ? '' : ' inspector-collapsed'}`} data-panel={mobilePanel}>
      <header className="messenger-header">
        <div className="brand-lockup">
          <TerminalSquareIcon aria-hidden="true" />
          <div>
            <h1>SCRAPGRID</h1>
            <p className="desktop-only">Field terminal</p>
          </div>
        </div>
        {currentWork.length > 1 ? (
          <label className="header-work">
            <span className="sr-only">Current work</span>
            <select
              value={selectedTaskId ?? ''}
              onChange={(event) => chooseTask(event.target.value || null)}
            >
              {currentWork.map((task) => (
                <option key={text(task['id'])} value={text(task['id'])}>{taskTitle(task)}</option>
              ))}
            </select>
          </label>
        ) : (
          <div className="header-task">
            <strong>{selectedTask ? taskTitle(selectedTask) : 'Talk to Claude, Codex, or Grok'}</strong>
          </div>
        )}
        <Button size="sm" variant="outline" onClick={() => setNewTaskOpen(true)}>New</Button>
        <Button size="sm" variant="ghost" className="desktop-only" onClick={() => setView((current) => current === 'activity' ? 'chat' : 'activity')}>
          {view === 'activity' ? 'Back to chat' : 'History'}
        </Button>
        <div className="mobile-nav">
          <Button size="xs" variant={mobilePanel === 'nav' ? 'default' : 'outline'} onClick={() => setMobilePanel('nav')}>Chats</Button>
          <Button size="xs" variant={mobilePanel === 'chat' ? 'default' : 'outline'} onClick={() => { setView('chat'); setMobilePanel('chat') }}>Chat</Button>
        </div>
      </header>

      <aside className="nav-rail" aria-label="Who to talk to">
        <ul className="conversation-list">
          {modelAgents.map((agent) => {
            const id = text(agent['id'])
            const live = snapshot ? sessionForAgent(snapshot, id)?.['liveness'] === 'live' : false
            return (
              <li key={id} data-agent={id}>
                <button
                  type="button"
                  className="nav-item conversation-item"
                  data-selected={view === 'chat' && selectedWorkerId === id || undefined}
                  onClick={() => chooseWorker(id)}
                >
                  <span className="presence" data-live={live || undefined} aria-hidden="true" />
                  <strong>{actorNames[id] ?? text(agent['name'])}</strong>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <section className="chat-pane" aria-label="Conversation">
        {(error || mutationError) && (
          <Alert variant="destructive" className="chat-alert">
            <AlertCircleIcon />
            <AlertTitle>
              {mutationError ? 'Action rejected' : unauthorized ? 'Credential required' : 'Connection interrupted'}
            </AlertTitle>
            <AlertDescription>
              {mutationError ?? error}
              {!mutationError && !unauthorized && (
                <Button variant="ghost" size="xs" onClick={() => void refresh()}>Retry</Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {unauthorized && !snapshot ? (
          <div className="empty-state">{CREDENTIAL_HINT}</div>
        ) : !snapshot ? (
          <LoadingShell />
        ) : view === 'activity' ? (
          <div className="activity-pane">
            <div className="chat-heading">
              <div>
                <span className="eyebrow">History</span>
                <h2>{selectedTask ? taskTitle(selectedTask) : 'Everything'}</h2>
              </div>
              <span>{stream.length} records</span>
            </div>
            <div className="stream-scroller">
              {stream.length === 0 ? (
                <div className="empty-state">No activity for this task yet.</div>
              ) : (
                <Virtuoso
                  key={selectedTaskId ?? 'all'}
                  ref={streamRef}
                  className="stream-virtuoso"
                  data={stream}
                  components={virtuosoComponents}
                  computeItemKey={(_index, event) => String(event['id'])}
                  initialTopMostItemIndex={{ index: stream.length - 1, align: 'end' }}
                  followOutput="auto"
                  atBottomStateChange={setStreamAtBottom}
                  itemContent={(_index, event) => (
                    <div className="stream-item" data-slot="message-scroller-item">
                      <StreamEvent event={event} snapshot={snapshot} pending={pending} runMutation={runMutation} />
                    </div>
                  )}
                />
              )}
              {!streamAtBottom && stream.length > 0 && (
                <Button
                  className="stream-latest"
                  variant="secondary"
                  size="icon-sm"
                  onClick={() => streamRef.current?.scrollToIndex({ index: stream.length - 1, align: 'end' })}
                >
                  <ArrowDownIcon />
                  <span className="sr-only">Scroll to latest activity</span>
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-heading">
              <div>
                <h2>{workerName}</h2>
              </div>
              <Button className="desktop-only" size="icon-sm" variant="ghost" onClick={() => setInspectorOpen((open) => !open)} aria-expanded={inspectorOpen} aria-controls="task-inspector">
                <PanelRightIcon />
                <span className="sr-only">{inspectorOpen ? 'Hide files' : 'Show files'}</span>
              </Button>
            </div>
            <ol className="chat-log">
              {conversationItems.length === 0 && (
                <li className="empty-state compact">Say what you need. Attach a file if it helps.</li>
              )}
              {conversationItems.map((item) => {
                if (item.type === 'message') {
                  const fromHuman = item.row['sender'] === 'human'
                  const files = messageFiles(snapshot, text(item.row['id']))
                  return (
                    <li key={item.key} className={`chat-turn${fromHuman ? ' from-human' : ''}`} data-actor={text(item.row['sender'])}>
                      <strong>{actorNames[text(item.row['sender'])] ?? text(item.row['sender'])}</strong>
                      <div className="chat-bubble">
                        <MarkdownBody>{text(item.row['body'])}</MarkdownBody>
                      </div>
                      {files.length > 0 && (
                        <ul className="file-chips">
                          {files.map((file) => (
                            <li key={text(file['id'])}>
                              <button type="button" onClick={() => openAttachment(text(file['id']))}>{text(file['filename'])}</button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <time>{formatTime(item.at)}</time>
                    </li>
                  )
                }
                if (item.type === 'proposal') {
                  return (
                    <li key={item.key}>
                      <Artifact label="Proposal" tone="proposal">
                        <Badge variant="outline">{text(item.row['visibility'])}</Badge>
                        {item.row['visibility'] === 'revealed' ? <MarkdownBody>{text(item.row['content'])}</MarkdownBody> : <p>Sealed until you reveal proposals.</p>}
                      </Artifact>
                    </li>
                  )
                }
                if (item.type === 'review') {
                  return (
                    <li key={item.key}>
                      <Artifact label="Review" tone={item.row['verdict'] === 'approved' ? 'pass' : 'review'}>
                        <p>{titleCase(item.row['verdict'])} · {shortSha(item.row['commit_sha'])}</p>
                      </Artifact>
                    </li>
                  )
                }
                if (item.type === 'finding') {
                  return (
                    <li key={item.key}>
                      <Artifact label={`${titleCase(item.row['severity'])} finding`} tone={item.row['severity'] === 'blocking' ? 'fail' : 'review'}>
                        <p>{text(item.row['description'])}</p>
                      </Artifact>
                    </li>
                  )
                }
                return (
                  <li key={item.key}>
                    <Artifact label={Number(item.row['exit_code']) === 0 ? 'Verification passed' : 'Verification failed'} tone={Number(item.row['exit_code']) === 0 ? 'pass' : 'fail'}>
                      <p>exit {text(item.row['exit_code'])} · {shortSha(item.row['commit_sha'])}</p>
                    </Artifact>
                  </li>
                )
              })}
            </ol>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault()
                void readTextFiles(messageFilesRef.current?.files ?? null).then(async (files) => {
                  const taskId = await ensureWork(messageDraft)
                  await runHuman('message', 'message.send', {
                    to: selectedWorkerId,
                    taskId,
                    body: messageDraft,
                    files,
                  })
                  setMessageDraft('')
                  setPendingFiles([])
                  if (messageFilesRef.current) messageFilesRef.current.value = ''
                }).catch(() => undefined)
              }}
            >
              <label className="sr-only" htmlFor="message-box">Message {workerName}</label>
              <textarea
                id="message-box"
                value={messageDraft}
                onChange={(event) => setMessageDraft(event.target.value)}
                rows={2}
                required
                placeholder={`Message ${workerName}…`}
              />
              <div className="composer-bar">
                <label className="attach-button">
                  <PaperclipIcon />
                  <span>Attach</span>
                  <input
                    ref={messageFilesRef}
                    type="file"
                    multiple
                    accept=".md,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.xml"
                    onChange={(event) => setPendingFiles(Array.from(event.target.files ?? []).map((file) => file.name))}
                  />
                </label>
                {pendingFiles.length > 0 && <span className="pending-files">{pendingFiles.join(', ')}</span>}
                <Button type="submit" disabled={pending !== null || messageDraft.trim().length === 0}>Send</Button>
              </div>
            </form>
          </>
        )}
      </section>

      <aside id="task-inspector" className="inspector" aria-label="Files">
        <div className="inspector-heading">
          <h2>Files</h2>
        </div>
        <div className="briefing-list">
          {taskFiles.length === 0 ? <p>Drop notes or docs here if you want them on this work.</p> : (
            <ul>
              {taskFiles.map((file) => (
                <li key={text(file['id'])}>
                  <button type="button" onClick={() => openAttachment(text(file['id']))}>{text(file['filename'])}</button>
                </li>
              ))}
            </ul>
          )}
          <label className="file-field">
            <span>Add a file</span>
            <input ref={briefingFilesRef} type="file" multiple accept=".md,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.xml" disabled={pending !== null} />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null || !selectedTaskId}
            onClick={() => {
              void readTextFiles(briefingFilesRef.current?.files ?? null).then((files) => {
                if (files.length === 0) {
                  setMutationError('Choose a file first.')
                  return
                }
                return runHuman('brief', 'task.file.add', { taskId: selectedTaskId, files })
              }).catch(() => undefined)
            }}
          >
            Add
          </Button>
        </div>
        {sealedProposals.length > 0 && selectedTaskId && (
          <div className="inspector-actions">
            <ConfirmAction
              label="Show everyone’s ideas"
              title="Show sealed proposals?"
              description="The three models wrote these privately. Showing them lets everyone see the same ideas."
              pending={pending === `reveal:${selectedTaskId}`}
              onConfirm={() => runMutation(`reveal:${selectedTaskId}`, `/api/tasks/${encodeURIComponent(selectedTaskId)}/reveal-proposals`)}
            />
          </div>
        )}
        {selectedTask?.['status'] === 'in_review' && (
          <div className="inspector-actions">
            <ConfirmAction
              label="Looks good"
              title="Mark this work done?"
              description="Say this is finished."
              pending={pending === `task:${selectedTaskId}`}
              variant="default"
              onConfirm={() => runMutation(
                `task:${selectedTaskId}`,
                `/api/tasks/${encodeURIComponent(selectedTaskId ?? '')}/accept`,
                { expected_version: selectedTask['version'] },
              )}
            />
          </div>
        )}
      </aside>

      {newTaskOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setNewTaskOpen(false)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-task-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              const id = newTaskId()
              void runHuman('create', 'task.create', {
                id,
                goal: goalDraft.trim(),
                acceptance: [],
              }).then(async () => {
                chooseTask(id)
                try {
                  await runHuman('roles', 'task.assign_roles', { taskId: id, ...defaultRoles(selectedWorkerId) })
                } catch {
                  // Already assigned.
                }
                setNewTaskOpen(false)
                setGoalDraft('')
              }).catch(() => undefined)
            }}
          >
            <h2 id="new-task-title">What do you want to build?</h2>
            <label>
              <span className="sr-only">Describe it</span>
              <textarea value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} required rows={3} placeholder="In plain language." />
            </label>
            <div className="modal-actions">
              <Button type="button" variant="outline" onClick={() => setNewTaskOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pending !== null}>Start talking</Button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}

export default App
