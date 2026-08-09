import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircleIcon,
  CheckIcon,
  CircleDotIcon,
  GitBranchIcon,
  RadioIcon,
  ShieldCheckIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import './App.css'

type Row = Record<string, unknown>

interface Snapshot {
  project: Row
  repository: Row
  agents: Row[]
  tasks: Row[]
  leases: Row[]
  worktrees: Row[]
  messages: Row[]
  proposals: Row[]
  decisions: Row[]
  blockers: Row[]
  reviews: Row[]
  findings: Row[]
  verifications: Row[]
  events: Row[]
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
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/snapshot', { signal })
      const body = await readApiResponse<Snapshot>(response, 'Snapshot service')
      setSnapshot(body)
      setLastUpdated(new Date())
      setError(null)
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') {
        setError(requestError instanceof Error ? requestError.message : 'Snapshot unavailable')
      }
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

  return { snapshot, setSnapshot, error, lastUpdated, refresh }
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
            <BubbleContent>{text(message['body'])}</BubbleContent>
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
        <h3>{text(decision['statement'])}</h3>
        <p>{text(decision['rationale'])}</p>
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
              <p>{text(proposal['content'])}</p>
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
  const { snapshot, setSnapshot, error, lastUpdated, refresh } = useSnapshot()
  const [selectedTaskId, setSelectedTaskId] = useState<string>('all')
  const [pending, setPending] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)

  useEffect(() => {
    if (snapshot && selectedTaskId === 'all' && snapshot.tasks.length === 1) {
      setSelectedTaskId(text(snapshot.tasks[0]?.['id'], 'all'))
    }
  }, [selectedTaskId, snapshot])

  const selectedTask = snapshot?.tasks.find((task) => task['id'] === selectedTaskId)
  const stream = useMemo(() => {
    if (!snapshot) return []
    return snapshot.events.filter((event) => {
      if (selectedTaskId === 'all') return true
      return eventTaskId(event, snapshot) === selectedTaskId
    })
  }, [selectedTaskId, snapshot])

  const runMutation = useCallback(async (key: string, path: string, body?: Row) => {
    setPending(key)
    setMutationError(null)
    try {
      const response = await fetch(path, {
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

  const sealedProposals = snapshot?.proposals.filter(
    (proposal) => proposal['task_id'] === selectedTaskId && proposal['visibility'] === 'sealed',
  ) ?? []

  return (
    <main className="terminal-shell">
      <header className="terminal-header">
        <div className="brand-lockup">
          <TerminalSquareIcon aria-hidden="true" />
          <div>
            <h1>SCRAPGRID</h1>
            <p>Collaboration field terminal</p>
          </div>
        </div>
        <div className="project-state" aria-live="polite">
          <RadioIcon aria-hidden="true" />
          <span>{snapshot ? text(snapshot.project['status']).toUpperCase() : 'CONNECTING'}</span>
          <small>{lastUpdated ? `sync ${formatTime(lastUpdated.toISOString())}` : 'awaiting state'}</small>
        </div>
      </header>

      <div className="terminal-workspace">
        <aside className="context-rail" aria-label="Collaboration context">
          <section className="rail-section">
            <div className="rail-heading"><span>Agents</span><span>{snapshot?.agents.filter((agent) => agent['kind'] === 'model').length ?? 0}</span></div>
            <ul className="agent-list">
              {snapshot?.agents.filter((agent) => agent['kind'] === 'model').map((agent) => (
                <li key={text(agent['id'])} data-agent={text(agent['id'])}>
                  <span className="agent-mark" aria-hidden="true" />
                  <span><strong>{text(agent['name'])}</strong><small>{text(agent['status'])}</small></span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rail-section task-context">
            <div className="rail-heading"><span>Task channel</span></div>
            <Select value={selectedTaskId} onValueChange={setSelectedTaskId}>
              <SelectTrigger aria-label="Filter activity by task">
                <SelectValue placeholder="All activity" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All activity</SelectItem>
                  {snapshot?.tasks.map((task) => (
                    <SelectItem key={text(task['id'])} value={text(task['id'])}>{text(task['id'])}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selectedTask && (
              <div className="task-readout">
                <Badge variant="outline">{titleCase(selectedTask['status'])}</Badge>
                <p>{text(selectedTask['goal'])}</p>
                <dl>
                  <div><dt>Owner</dt><dd>{text(selectedTask['owner_agent_id'])}</dd></div>
                  <div><dt>Base</dt><dd><code>{shortSha(selectedTask['base_commit'])}</code></dd></div>
                  <div><dt>Candidate</dt><dd><code>{shortSha(selectedTask['candidate_commit'])}</code></dd></div>
                </dl>
              </div>
            )}
          </section>

          <section className="rail-section worktree-context">
            <div className="rail-heading"><span>Worktrees</span></div>
            <ul className="worktree-list">
              {snapshot?.worktrees.map((worktree) => (
                <li key={text(worktree['agent_id'])}>
                  <GitBranchIcon aria-hidden="true" />
                  <span><strong>{text(worktree['branch_name'])}</strong><code>{shortSha(worktree['head_commit'])}</code></span>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <section className="stream-panel" aria-labelledby="stream-title">
          <div className="stream-heading">
            <div>
              <span className="eyebrow">Live channel</span>
              <h2 id="stream-title">{selectedTaskId === 'all' ? 'All collaboration' : selectedTaskId}</h2>
            </div>
            <span>{stream.length} records</span>
          </div>

          {(error || mutationError) && (
            <Alert variant="destructive" className="stream-alert">
              <AlertCircleIcon />
              <AlertTitle>{mutationError ? 'Action rejected' : 'Connection interrupted'}</AlertTitle>
              <AlertDescription>
                {mutationError ?? error}
                {!mutationError && <Button variant="ghost" size="xs" onClick={() => void refresh()}>Retry</Button>}
              </AlertDescription>
            </Alert>
          )}

          {!snapshot ? (
            <LoadingShell />
          ) : (
            <MessageScrollerProvider autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className="stream-content">
                    {stream.length === 0 ? (
                      <MessageScrollerItem messageId="empty">
                        <Marker variant="separator"><MarkerContent>No records in this channel yet</MarkerContent></Marker>
                      </MessageScrollerItem>
                    ) : stream.map((event) => (
                      <MessageScrollerItem key={String(event['id'])} messageId={String(event['id'])}>
                        <StreamEvent event={event} snapshot={snapshot} pending={pending} runMutation={runMutation} />
                      </MessageScrollerItem>
                    ))}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          )}
        </section>
      </div>

      <footer className="operator-bar">
        <div className="operator-label">
          <CircleDotIcon aria-hidden="true" />
          <span><strong>Human authority</strong><small>Existing service gates apply</small></span>
        </div>
        <div className="operator-actions">
          <ConfirmAction
            label={`Reveal proposals${sealedProposals.length ? ` (${sealedProposals.length})` : ''}`}
            title="Reveal sealed proposals?"
            description="This calls the existing human-only reveal operation for the selected task."
            pending={pending === `reveal:${selectedTaskId}`}
            disabled={!selectedTask || sealedProposals.length === 0}
            onConfirm={() => runMutation(`reveal:${selectedTaskId}`, `/api/tasks/${encodeURIComponent(selectedTaskId)}/reveal-proposals`)}
          />
          <ConfirmAction
            label="Accept task"
            title={`Accept ${selectedTaskId}?`}
            description="The CollaborationService will enforce review, verification, blocker, finding, commit, and version gates."
            pending={pending === `task:${selectedTaskId}`}
            disabled={!selectedTask || selectedTask['status'] !== 'in_review'}
            variant="default"
            onConfirm={() => runMutation(
              `task:${selectedTaskId}`,
              `/api/tasks/${encodeURIComponent(selectedTaskId)}/accept`,
              { expected_version: selectedTask?.['version'] },
            )}
          />
        </div>
      </footer>
    </main>
  )
}

export default App
