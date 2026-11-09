import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiClient } from '@/services/api-client';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useSessionStore } from '@/stores/session-store';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

interface Task {
  id: string;
  kind: string;
  sourceId: string;
  sessionId: string;
  originSessionId: string;
  title: string;
  stage: string;
  detail: string;
  result: string;
  artifacts: unknown[];
  updatedAt: number;
  inputs: Array<{ id: string; text: string; at: number }>;
  history: Array<{ stage: string; detail: string; at: number }>;
}
interface Question {
  id: string;
  sessionId?: string;
  question: string;
  options: string[];
  multiple: boolean;
}
interface Approval {
  id: string;
  sessionId?: string;
  toolName: string;
  args: unknown;
}
interface Rule {
  id: string;
  revision: number;
  name: string;
  source: string;
  mode: string;
  channel: string;
  peer: string;
  contains: string;
  prompt: string;
  agentId: string;
  intervalMinutes: number;
  nextAt?: number;
}
interface Snapshot {
  tasks: Task[];
  questions: Question[];
  approvals: Approval[];
  rules: Rule[];
  deliveries: Array<{
    id: string;
    channel: string;
    peer: string;
    content: string;
    state: string;
    error: string;
    receipt?: string;
    attempts: number;
    nextAt: number;
  }>;
  admissions: Array<{
    id: string;
    ruleId: string;
    reason: string;
    input: string;
    state: string;
    createdAt: number;
    taskId?: string;
  }>;
  notices: Array<{
    id: string;
    taskId: string;
    stage: string;
    title: string;
    read: boolean;
    at: number;
  }>;
}
const needsAttention = (stage: string) => ['answer', 'review', 'blocked'].includes(stage);
const stageText = (stage: string): string =>
  ({
    queued: wt('排队中'),
    working: wt('执行中'),
    answer: wt('待回答'),
    review: wt('待审核'),
    blocked: wt('待处理'),
    completed: wt('已完成'),
    cancelled: wt('已取消'),
    sending: wt('发送中'),
    sent: wt('已发送'),
    unknown: wt('结果待核对'),
    observed: wt('已观察'),
    dispatched: wt('已派发'),
  })[stage] ?? stage;
const freshRule = (): Rule => ({
  id: crypto.randomUUID(),
  revision: 0,
  name: '',
  source: 'interval',
  mode: 'observe',
  channel: '',
  peer: '',
  contains: '',
  prompt: '',
  agentId: '',
  intervalMinutes: 60,
});
type RunAction = (operation: () => Promise<unknown>) => Promise<void>;

function QuestionAnswer({ question, run }: { question: Question; run: RunAction }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const answer = text.trim() ? [text.trim()] : selected;
  return (
    <section className="space-y-2 border-l-2 border-blue-400 pl-3">
      <p className="whitespace-pre-wrap">{question.question}</p>
      {question.options.map((option) => (
        <label key={option} className="flex gap-2">
          <input
            type={question.multiple ? 'checkbox' : 'radio'}
            name={question.id}
            checked={selected.includes(option)}
            onChange={() =>
              setSelected(
                question.multiple
                  ? selected.includes(option)
                    ? selected.filter((v) => v !== option)
                    : [...selected, option]
                  : [option],
              )
            }
          />
          {option}
        </label>
      ))}
      <textarea
        aria-label={wt('填写回答')}
        className="input w-full"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="btn-primary"
        disabled={!answer.length}
        onClick={() =>
          void run(() => apiClient.post('/tools/ask-user/respond', { id: question.id, answer }))
        }
      >
        {wt('提交回答')}
      </button>
    </section>
  );
}

export function TaskCenterPage() {
  useWorkbenchLanguage();
  const navigate = useNavigate();
  const [data, setData] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState('tasks');
  const [onlyAttention, setOnlyAttention] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [rule, setRule] = useState<Rule>(freshRule);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const refresh = useCallback(async () => {
    setData(await apiClient.get<Snapshot>('/scheduler'));
  }, []);
  useEffect(() => {
    let live = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await apiClient.get<Snapshot>('/scheduler');
        if (live) setData(value);
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        pending = false;
      }
    };
    void poll();
    void apiClient
      .get<Array<{ id: string; name: string }>>('/scheduler/prompts')
      .then((value) => {
        if (live) setAgents(value);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const run: RunAction = async (operation) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const openSession = (id: string) => {
    useSessionStore.getState().selectSession(id);
    navigate('/');
  };
  const action = (task: Task, operation: string) =>
    run(() =>
      apiClient.post(`/scheduler/tasks/${encodeURIComponent(task.id)}/${operation}`, {
        confirmReplay: confirmed[task.id] === true,
      }),
    );
  const tasks = [...(data?.tasks ?? [])]
    .filter((t) => !onlyAttention || needsAttention(t.stage))
    .sort(
      (a, b) =>
        Number(needsAttention(b.stage)) - Number(needsAttention(a.stage)) ||
        b.updatedAt - a.updatedAt,
    );
  return (
    <main className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{wt('任务中心')}</h1>
        <Link className="btn-secondary" to="/inbox">
          {wt('收件箱')}
        </Link>
      </div>
      <nav className="flex gap-2 flex-wrap">
        {[
          ['tasks', wt('任务')],
          ['rules', wt('主动规则')],
          ['deliveries', wt('发送队列')],
          ['prompts', wt('提示词版本')],
          ['notices', wt('通知')],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="text-red-500 whitespace-pre-wrap">
          {error}
        </p>
      )}
      {!data && <p>{wt('加载中…')}</p>}
      <fieldset disabled={busy} className="space-y-4 min-w-0">
        {tab === 'tasks' && (
          <>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={onlyAttention}
                onChange={(e) => setOnlyAttention(e.target.checked)}
              />
              {wt('只看待处理')}
            </label>
            {!tasks.length && <p>{wt('暂无任务')}</p>}
            {tasks.map((task) => (
              <article
                key={task.id}
                className="border-b border-[var(--border-color)] pb-5 space-y-3"
              >
                <div className="flex justify-between gap-3">
                  <strong>{task.title}</strong>
                  <span>{stageText(task.stage)}</span>
                </div>
                {task.detail && <p className="whitespace-pre-wrap text-sm">{task.detail}</p>}
                {data?.questions
                  .filter((q) => q.sessionId === task.sessionId)
                  .map((q) => (
                    <QuestionAnswer key={q.id} question={q} run={run} />
                  ))}
                {data?.approvals
                  .filter((a) => a.sessionId === task.sessionId)
                  .map((a) => (
                    <section key={a.id} className="space-y-2">
                      <strong>{a.toolName}</strong>
                      <pre className="text-sm whitespace-pre-wrap break-all">
                        {JSON.stringify(a.args, null, 2)}
                      </pre>
                      <div className="flex gap-2">
                        <button
                          className="btn-primary"
                          onClick={() =>
                            void run(() =>
                              apiClient.post(`/approvals/${a.id}`, { decision: 'allow-once' }),
                            )
                          }
                        >
                          {wt('允许本次')}
                        </button>
                        <button
                          className="btn-secondary"
                          onClick={() =>
                            void run(() =>
                              apiClient.post(`/approvals/${a.id}`, { decision: 'denied' }),
                            )
                          }
                        >
                          {wt('拒绝')}
                        </button>
                      </div>
                    </section>
                  ))}
                <div className="flex gap-2 flex-wrap">
                  {task.originSessionId && (
                    <button
                      className="btn-secondary"
                      onClick={() => openSession(task.originSessionId)}
                    >
                      {wt('打开原对话')}
                    </button>
                  )}
                  {task.kind === 'workflow' && (
                    <Link className="btn-secondary" to="/workflow">
                      {wt('工作流')}
                    </Link>
                  )}
                  {['queued', 'working', 'answer', 'review'].includes(task.stage) && (
                    <button className="btn-secondary" onClick={() => void action(task, 'cancel')}>
                      {wt('停止')}
                    </button>
                  )}
                  {task.kind !== 'chat' && ['blocked', 'cancelled'].includes(task.stage) && (
                    <button className="btn-secondary" onClick={() => void action(task, 'resume')}>
                      {wt('继续')}
                    </button>
                  )}
                  {task.kind === 'workflow' && task.stage === 'review' && (
                    <button className="btn-primary" onClick={() => void action(task, 'approve')}>
                      {wt('确认产物并继续')}
                    </button>
                  )}
                  {task.kind === 'workflow' && task.stage === 'blocked' && (
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={confirmed[task.id] === true}
                        onChange={(e) =>
                          setConfirmed({ ...confirmed, [task.id]: e.target.checked })
                        }
                      />
                      {wt('已核对未完成步骤，允许重试')}
                    </label>
                  )}
                </div>
                {task.result && (
                  <details>
                    <summary>{wt('结果')}</summary>
                    <MarkdownRenderer content={task.result} />
                  </details>
                )}
                {task.artifacts.length > 0 && (
                  <details>
                    <summary>{wt('产物')}</summary>
                    <pre className="whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(task.artifacts, null, 2)}
                    </pre>
                  </details>
                )}
                <details>
                  <summary>{wt('任务记录')}</summary>
                  {task.inputs.map((input) => (
                    <p key={input.id} className="whitespace-pre-wrap my-2">
                      {input.text}
                    </p>
                  ))}
                  {task.history.map((entry, i) => (
                    <p key={i} className="text-sm py-1">
                      {new Date(entry.at).toLocaleString()} · {stageText(entry.stage)}{' '}
                      {entry.detail}
                    </p>
                  ))}
                </details>
              </article>
            ))}
          </>
        )}
        {tab === 'deliveries' &&
          data?.deliveries.map((item) => (
            <article className="border-b pb-4 space-y-2" key={item.id}>
              <div className="flex justify-between">
                <strong>
                  {item.channel} · {item.peer}
                </strong>
                <span>{stageText(item.state)}</span>
              </div>
              <p className="whitespace-pre-wrap">{item.content}</p>
              <p className="text-sm">{item.error}</p>
              {item.receipt && (
                <p className="text-xs">
                  {wt('回执')} · {item.receipt}
                </p>
              )}
              <p className="text-sm">
                {wt('尝试次数')} · {item.attempts}
                {item.state === 'queued' && <> · {new Date(item.nextAt).toLocaleString()}</>}
              </p>
              {!['sent', 'sending', 'cancelled'].includes(item.state) && (
                <>
                  <label className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={confirmed[item.id] === true}
                      onChange={(e) => setConfirmed({ ...confirmed, [item.id]: e.target.checked })}
                    />
                    {wt('已核对接收方和实际发送结果')}
                  </label>
                  <div className="flex gap-2">
                    {[
                      ['retry', wt('重试发送')],
                      ['sent', wt('标记已送达')],
                      ['cancel', wt('取消发送')],
                    ].map(([id, title]) => (
                      <button
                        key={id}
                        disabled={id !== 'cancel' && !confirmed[item.id]}
                        className="btn-secondary"
                        onClick={() =>
                          void run(() =>
                            apiClient.post(`/scheduler/deliveries/${item.id}/${id}`, {
                              confirmed: confirmed[item.id] === true,
                            }),
                          )
                        }
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </article>
          ))}
        {tab === 'rules' && (
          <>
            <div className="flex gap-2 flex-wrap">
              <button className="btn-secondary" onClick={() => setRule(freshRule())}>
                {wt('新建规则')}
              </button>
              {data?.rules.map((r) => (
                <button className="btn-secondary" key={r.id} onClick={() => setRule(r)}>
                  {r.name} · {r.mode}
                </button>
              ))}
            </div>
            <form
              className="grid sm:grid-cols-2 gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const { revision, nextAt: _nextAt, ...body } = rule;
                  const saved = await apiClient.post<Rule>('/scheduler/rules', {
                    ...body,
                    expectedRevision: revision,
                  });
                  setRule(saved);
                });
              }}
            >
              <label>
                {wt('名称')}
                <input
                  className="input w-full"
                  required
                  value={rule.name}
                  onChange={(e) => setRule({ ...rule, name: e.target.value })}
                />
              </label>
              <label>
                {wt('运行模式')}
                <select
                  className="input w-full"
                  value={rule.mode}
                  onChange={(e) => setRule({ ...rule, mode: e.target.value })}
                >
                  <option value="off">{wt('关闭')}</option>
                  <option value="observe">{wt('仅观察')}</option>
                  <option value="auto">{wt('自动执行')}</option>
                </select>
              </label>
              <label>
                {wt('触发来源')}
                <select
                  className="input w-full"
                  value={rule.source}
                  onChange={(e) => setRule({ ...rule, source: e.target.value })}
                >
                  <option value="interval">{wt('定时')}</option>
                  <option value="task">{wt('任务完成')}</option>
                  <option value="channel">{wt('渠道消息')}</option>
                </select>
              </label>
              {rule.source === 'interval' && (
                <label>
                  {wt('间隔分钟')}
                  <input
                    className="input w-full"
                    type="number"
                    min={1}
                    max={525600}
                    value={rule.intervalMinutes}
                    onChange={(e) => setRule({ ...rule, intervalMinutes: Number(e.target.value) })}
                  />
                </label>
              )}
              {rule.source === 'channel' && (
                <>
                  <label>
                    {wt('渠道')}
                    <input
                      className="input w-full"
                      value={rule.channel}
                      onChange={(e) => setRule({ ...rule, channel: e.target.value })}
                    />
                  </label>
                  <label>
                    {wt('发送者')}
                    <input
                      className="input w-full"
                      value={rule.peer}
                      onChange={(e) => setRule({ ...rule, peer: e.target.value })}
                    />
                  </label>
                </>
              )}
              {rule.source !== 'interval' && (
                <label>
                  {wt('包含文本')}
                  <input
                    className="input w-full"
                    value={rule.contains}
                    onChange={(e) => setRule({ ...rule, contains: e.target.value })}
                  />
                </label>
              )}
              {rule.source !== 'channel' && (
                <>
                  <label>
                    {wt('智能体')}
                    <select
                      className="input w-full"
                      value={rule.agentId}
                      onChange={(e) => setRule({ ...rule, agentId: e.target.value })}
                    >
                      <option value="">{wt('默认')}</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="sm:col-span-2">
                    {wt('任务指令')}
                    <textarea
                      className="input w-full min-h-32"
                      required={rule.mode !== 'off'}
                      value={rule.prompt}
                      onChange={(e) => setRule({ ...rule, prompt: e.target.value })}
                    />
                  </label>
                </>
              )}
              <button className="btn-primary" type="submit">
                {wt('保存规则')}
              </button>
            </form>
            <details>
              <summary>{wt('触发记录')}</summary>
              {data?.admissions.map((a) => (
                <div className="border-b py-2" key={a.id}>
                  <p>
                    {data.rules.find((r) => r.id === a.ruleId)?.name} · {stageText(a.state)} ·{' '}
                    {new Date(a.createdAt).toLocaleString()}
                  </p>
                  <p>{a.reason}</p>
                  <p className="whitespace-pre-wrap">{a.input}</p>
                </div>
              ))}
            </details>
          </>
        )}
        {tab === 'prompts' && <PromptEditor agents={agents} run={run} />}
        {tab === 'notices' && (
          <>
            <button
              className="btn-secondary"
              onClick={() => void run(() => apiClient.post('/scheduler/notices/read', {}))}
            >
              {wt('全部已读')}
            </button>
            {[...(data?.notices ?? [])].reverse().map((n) => (
              <button
                className="block text-left py-2"
                key={n.id}
                onClick={() => {
                  setOnlyAttention(false);
                  setTab('tasks');
                }}
              >
                {!n.read && '● '}
                {n.title} · {stageText(n.stage)} · {new Date(n.at).toLocaleString()}
              </button>
            ))}
          </>
        )}
      </fieldset>
    </main>
  );
}

interface PromptDocument {
  id: string;
  revisions: Array<{ revision: number; text: string; at: number; reason: string }>;
  template: string;
  pendingTemplate?: string;
  effective: string;
  diff: string;
}
function PromptEditor({
  agents,
  run,
}: {
  agents: Array<{ id: string; name: string }>;
  run: RunAction;
}) {
  const [agentId, setAgentId] = useState('');
  const [doc, setDoc] = useState<PromptDocument | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [compare, setCompare] = useState('');
  const [sessionId, setSessionId] = useState(
    () => useSessionStore.getState().currentSessionId ?? '',
  );
  const sequence = useRef(0);
  const load = async (id: string, comparison = '', replaceEditor = true) => {
    const request = ++sequence.current;
    try {
      const value = await apiClient.get<PromptDocument>(
        `/scheduler/prompts/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}&compare=${comparison}`,
      );
      if (request !== sequence.current) return;
      setDoc(value);
      if (replaceEditor) {
        setText(value.revisions.at(-1)?.text ?? '');
        setBaseRevision(value.revisions.at(-1)?.revision ?? 0);
      }
      setError('');
    } catch (e) {
      if (request === sequence.current) setError(String(e));
    }
  };
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  return (
    <section className="space-y-3">
      <label>
        {wt('智能体')}
        <select
          className="input w-full"
          value={agentId}
          onChange={(e) => {
            const id = e.target.value;
            sequence.current++;
            setAgentId(id);
            setDoc(null);
            setText('');
            setCompare('');
            if (id) void load(id);
          }}
        >
          <option value="">{wt('请选择')}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      {doc && (
        <>
          <textarea
            aria-label={wt('提示词')}
            className="input w-full min-h-64 font-mono text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="btn-primary"
              onClick={() =>
                void run(async () => {
                  await apiClient.post(`/scheduler/prompts/${encodeURIComponent(agentId)}`, {
                    text,
                    expectedRevision: baseRevision,
                  });
                  await load(agentId);
                })
              }
            >
              {wt('保存版本')}
            </button>
            <button className="btn-secondary" onClick={() => void load(agentId)}>
              {wt('重新加载')}
            </button>
          </div>
          <label>
            {wt('对比版本')}
            <select
              className="input w-full"
              value={compare}
              onChange={(e) => {
                setCompare(e.target.value);
                void load(agentId, e.target.value, false);
              }}
            >
              <option value="">{wt('上一版本')}</option>
              {doc.revisions.map((r) => (
                <option key={r.revision} value={r.revision}>
                  v{r.revision} · {new Date(r.at).toLocaleString()} · {r.reason}
                </option>
              ))}
            </select>
          </label>
          <pre className="whitespace-pre-wrap break-all text-sm">{doc.diff}</pre>
          {compare && (
            <button
              className="btn-secondary"
              onClick={() =>
                setText(doc.revisions.find((r) => r.revision === Number(compare))?.text ?? text)
              }
            >
              {wt('载入此版本')}
            </button>
          )}
          {doc.pendingTemplate !== undefined && (
            <details open>
              <summary>{wt('默认模板更新')}</summary>
              <pre className="whitespace-pre-wrap">{doc.pendingTemplate}</pre>
              <button
                className="btn-secondary"
                onClick={() =>
                  void run(async () => {
                    await apiClient.post(`/scheduler/prompts/${encodeURIComponent(agentId)}`, {
                      text,
                      expectedRevision: baseRevision,
                      merge: true,
                    });
                    await load(agentId);
                  })
                }
              >
                {wt('以当前编辑内容合并')}
              </button>
            </details>
          )}
          <label>
            {wt('预览会话')}
            <input
              className="input w-full"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </label>
          <button className="btn-secondary" onClick={() => void load(agentId, compare, false)}>
            {wt('刷新生效预览')}
          </button>
          <details>
            <summary>{wt('完整生效提示词')}</summary>
            <pre className="whitespace-pre-wrap break-all text-sm">{doc.effective}</pre>
          </details>
        </>
      )}
    </section>
  );
}
