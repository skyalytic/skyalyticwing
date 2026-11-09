import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
import { EcosystemPage } from '../account/EcosystemPage';
import { ExpertRunHistory } from './ExpertRunHistory';
// 智能体页面（SkyalyticWing 新版形态，结合专家市场式智能体团设计）：
// 区块一「智能体」——分组行式列表（内置智能体 / 自定义智能体，首次安装仅内置 Agent；
//   内置只能编辑、不能删除），点击行打开智能体详情弹窗
//   （模型切换 / 多智能体协作信息 / 信箱对话 / 工作区配置 全功能保留）
// 区块二「智能体团」——专家市场式卡片网格（图标/名称/擅长领域标签/简介/成员头像叠加），
//   点击卡片打开智能体团详情弹窗（魅力介绍 / 擅长领域 / 成员列表含主管标记 /
//   试试这样问我 / 召唤智能体团），召唤 = 选中该智能体团进入多智能体协作对话
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Icon, AGENT_ICONS_MAP } from '../../components/Icon';
import { showConfirm } from '../../components/modals/ConfirmDialog';
import { toast } from '../../components/ui/Toast';
import { apiClient } from '@/services/api-client';
import { useSessionStore } from '@/stores/session-store';
import { formatRelativeTime } from '@/utils/format';

interface Agent {
  promptRevision?: number;
  id: string;
  name: string;
  type?: string;
  status?: string;
  description?: string;
  tasksCompleted?: number;
  model?: string;
  emoji?: string;
  builtin?: boolean;
  slug?: string;
  callable?: boolean;
  invocationHint?: string;
  systemPrompt?: string;
  /** 头像（base64 dataURL；空/缺省表示未设置） */
  avatar?: string;
}

/** 智能体团（多智能体协作单元） */
interface Team {
  id: string;
  name: string;
  description?: string;
  memberIds: string[];
  leadId?: string;
  tags?: string[];
  /** 智能体团头像（base64 dataURL；空/缺省表示未设置） */
  avatar?: string;
}

/** 可用模型（GET /models） */
interface AvailableModel {
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
  available?: boolean;
}

/** Agent 间消息（对齐后端 AgentMessage） */
interface AgentMessageItem {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  content: string;
  type: string;
  timestamp: number;
  read: boolean;
}

/** 信箱/对话响应（apiClient 已解包 ApiResponse.data） */
interface AgentMessageListResult {
  agentId?: string;
  messages: AgentMessageItem[];
  unreadCount?: number;
}

interface AgentForm {
  promptRevision?: number;
  name: string;
  type: string;
  description: string;
  model: string;
  systemPrompt: string;
  slug: string;
  callable: boolean;
  invocationHint: string;
  /** 头像（base64 dataURL；空串表示未设置） */
  avatar: string;
}

const EMPTY_FORM: AgentForm = {
  name: '',
  type: 'specialist',
  description: '',
  model: '',
  systemPrompt: '',
  slug: '',
  callable: true,
  invocationHint: '',
  avatar: '',
};

/** 头像 dataURL 长度上限（≈200KB 二进制经 base64 编码后约 ≤ 280000 字符，与后端校验一致） */
const AVATAR_MAX_LENGTH = 280000;

/**
 * 读取图片文件并压缩为头像 dataURL（上传前处理，后端仅存 base64 字符串）：
 * canvas 绘制缩到 256x256（cover 裁剪居中）→ 输出 PNG dataURL；
 * 若超过 200KB 再降尺寸（192）+ 降质量（JPEG 0.8）重试一次；仍超限返回 null（调用方 toast 提示）。
 */
function readAvatarDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => resolve(null));
    reader.addEventListener('load', () => {
      const img = new Image();
      img.addEventListener('error', () => resolve(null));
      img.addEventListener('load', () => {
        // 按目标边长绘制：取较短边居中裁剪（cover）后缩放到 size x size
        const draw = (size: number, type: 'image/png' | 'image/jpeg', quality?: number): string => {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) return '';
          const w = img.naturalWidth || size;
          const h = img.naturalHeight || size;
          const side = Math.min(w, h);
          const sx = (w - side) / 2;
          const sy = (h - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          return quality === undefined ? canvas.toDataURL(type) : canvas.toDataURL(type, quality);
        };
        // 第一次：256x256 PNG（PNG 不支持质量参数）
        const first = draw(256, 'image/png');
        if (first && first.length <= AVATAR_MAX_LENGTH) {
          resolve(first);
          return;
        }
        // 重试一次：缩到 192 并改用 JPEG 质量压缩（对 base64 输出更小）
        const second = draw(192, 'image/jpeg', 0.8);
        resolve(second && second.length <= AVATAR_MAX_LENGTH ? second : null);
      });
      img.src = String(reader.result);
    });
    reader.readAsDataURL(file);
  });
}

function statusBadgeClass(status?: string): string {
  if (status === 'running') return 'badge badge-green';
  if (status === 'error') return 'badge badge-red';
  if (status === 'idle') return 'badge badge-yellow';
  return 'badge badge-gray';
}

function statusLabel(status?: string): string {
  if (status === 'running') return wt('运行中');
  if (status === 'error') return wt('错误');
  if (!status || status === 'idle') return wt('空闲');
  if (status === 'stopped') return wt('已停止');
  return status;
}

function agentIconName(type?: string): string {
  if (!type) return 'agent';
  return AGENT_ICONS_MAP[type] || 'agent';
}

/** 列表/弹窗场景的圆形头像 img（有头像时替代默认 SVG 图标展示） */
function AvatarImg({ src, size }: { src: string; size: number }) {
  useWorkbenchLanguage();
  return (
    <img
      src={src}
      alt=""
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

export function AgentCenterPage() {
  useWorkbenchLanguage();
  const [resources, setResources] = useState(false);
  return (
    <div className="h-full overflow-y-auto">
      <div className="sky-resource-tabs">
        <button
          className="btn-secondary"
          aria-pressed={!resources}
          onClick={() => setResources(false)}
        >
          {wt('我的智能体')}
        </button>
        <button
          className="btn-secondary"
          aria-pressed={resources}
          onClick={() => setResources(true)}
        >
          {wt('智能体资源')}
        </button>
      </div>
      {resources ? <EcosystemPage resourceKind="agent" /> : <LocalAgentCenterPage />}
    </div>
  );
}
function LocalAgentCenterPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const selectAgentForChat = useSessionStore((s) => s.selectAgent);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 搜索过滤（智能体 + 智能体团；按名称/描述/标识/标签） */
  const [query, setQuery] = useState('');
  /** 渲染上限：超大规模列表防卡死/防页面拉长（超出部分用搜索定位） */
  const RENDER_LIMIT = 200;
  /** 智能体详情弹窗（选中 id；空 = 关闭） */
  const [detailId, setDetailId] = useState('');
  /** 智能体团详情弹窗（智能体团 id；空 = 关闭） */
  const [teamDetailId, setTeamDetailId] = useState('');
  /** 工作区文件 */
  const [wsFiles, setWsFiles] = useState<Record<string, string>>({});
  const [wsLoading, setWsLoading] = useState(false);

  // 创建/编辑智能体弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<AgentForm>({ ...EMPTY_FORM, model: '' });

  // 智能体团创建/编辑弹窗
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [teamEditingId, setTeamEditingId] = useState<string | null>(null);
  const [teamForm, setTeamForm] = useState<{
    name: string;
    description: string;
    memberIds: string[];
    leadId: string;
    tagsText: string;
    /** 头像（base64 dataURL；空串表示未设置） */
    avatar: string;
  }>({ name: '', description: '', memberIds: [], leadId: '', tagsText: '', avatar: '' });
  const [teamSubmitting, setTeamSubmitting] = useState(false);
  /** 头像文件选择器（智能体表单 / 智能体团表单各一个隐藏 input） */
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const teamAvatarInputRef = useRef<HTMLInputElement>(null);
  /** 成员选择弹窗（按钮打开 → 搜索框 + 滚动列表勾选，支撑超大规模智能体） */
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');

  // 工作区文件编辑弹窗
  const [wsEdit, setWsEdit] = useState<{ agentId: string; fn: string; content: string } | null>(
    null,
  );
  const [wsSaving, setWsSaving] = useState(false);
  const [wsNewName, setWsNewName] = useState('');

  // 信箱/对话（保留功能）
  const [inbox, setInbox] = useState<AgentMessageItem[]>([]);
  const [conversation, setConversation] = useState<AgentMessageItem[]>([]);
  const [msgText, setMsgText] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [showMessenger, setShowMessenger] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<Agent[] | { agents?: Agent[] }>('/agents');
      const list: Agent[] = Array.isArray(res) ? res : res?.agents || [];
      setAgents(list);
      setDetailId((cur) => (list.some((a) => a.id === cur) ? cur : ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadTeams = async () => {
    try {
      const res = await apiClient.get<Team[] | { teams?: Team[] }>('/agents/teams');
      setTeams(Array.isArray(res) ? res : res?.teams || []);
    } catch {
      setTeams([]);
    }
  };

  useEffect(() => {
    apiClient
      .get<{ models: AvailableModel[] }>('/models')
      .then((d) => setModels((d?.models || []).filter((m) => m.available)))
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    void load();
    void loadTeams();
  }, []);

  const detailAgent = agents.find((a) => a.id === detailId) || null;
  const detailTeam = teams.find((tm) => tm.id === teamDetailId) || null;
  // 搜索过滤（名称/描述/英文标识/智能体团标签；大小写不敏感）
  const q = query.trim().toLowerCase();
  const hitAgent = (a: Agent) =>
    !q ||
    a.name.toLowerCase().includes(q) ||
    (a.description || '').toLowerCase().includes(q) ||
    (a.slug || '').toLowerCase().includes(q);
  const hitTeam = (tm: Team) =>
    !q ||
    tm.name.toLowerCase().includes(q) ||
    (tm.description || '').toLowerCase().includes(q) ||
    (tm.tags || []).some((tag) => tag.toLowerCase().includes(q));
  const customAgents = agents.filter((a) => !a.builtin && hitAgent(a));
  const builtinAgents = agents.filter((a) => a.builtin && hitAgent(a));
  const filteredTeams = teams.filter(hitTeam);
  // 渲染上限截断（10 万量级时避免 DOM 爆炸；提示用搜索）
  const customShown = customAgents.slice(0, RENDER_LIMIT);
  const teamShown = filteredTeams.slice(0, RENDER_LIMIT);

  /** 打开智能体详情弹窗：加载工作区 + 信箱 */
  const openDetail = async (id: string) => {
    setDetailId(id);
    setShowMessenger(false);
    setWsLoading(true);
    try {
      const d = await apiClient.get<{ files?: Record<string, string> }>(
        `/agents/${encodeURIComponent(id)}/workspace`,
      );
      setWsFiles(d?.files ?? {});
    } catch {
      setWsFiles({});
    } finally {
      setWsLoading(false);
    }
  };

  // 选中详情时预载信箱未读数（不阻塞）
  useEffect(() => {
    if (!detailId) return;
    apiClient
      .get<AgentMessageListResult>(`/agents/inbox/${encodeURIComponent(detailId)}`)
      .then((d) => setInbox(Array.isArray(d?.messages) ? d.messages : []))
      .catch(() => setInbox([]));
  }, [detailId]);

  /** 保存模型切换（onchange 即存 PUT /agents/:id） */
  const updateModel = async (agent: Agent, model: string) => {
    setAgents((as) => as.map((a) => (a.id === agent.id ? { ...a, model } : a)));
    try {
      await apiClient.put(`/agents/${encodeURIComponent(agent.id)}`, {
        name: agent.name,
        description: agent.description || '',
        model,
        type: agent.type || 'specialist',
        slug: agent.slug || '',
        callable: agent.callable !== false,
        invocationHint: agent.invocationHint || '',
      });
      toast.success(wt('模型已切换为 {{v0}}', { v0: model }));
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : undefined);
      load();
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, model: models[0]?.id || '' });
    setModalOpen(true);
  };

  const openEdit = (a: Agent) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      type: a.type || 'specialist',
      description: a.description || '',
      model: a.model || '',
      promptRevision: a.promptRevision,
      systemPrompt: a.systemPrompt || '',
      slug: a.slug || '',
      callable: a.callable !== false,
      invocationHint: a.invocationHint || '',
      avatar: a.avatar || '',
    });
    setModalOpen(true);
  };

  /** 选择智能体头像：读取 + 前端压缩；超限/失败 toast 提示 */
  const pickAvatar = async (file: File) => {
    const dataUrl = await readAvatarDataUrl(file);
    if (!dataUrl) {
      toast.warn(wt('头像压缩后仍超过 200KB，请换一张更小的图片'));
      return;
    }
    setForm((f) => ({ ...f, avatar: dataUrl }));
  };

  /** 选择智能体团头像：读取 + 前端压缩；超限/失败 toast 提示 */
  const pickTeamAvatar = async (file: File) => {
    const dataUrl = await readAvatarDataUrl(file);
    if (!dataUrl) {
      toast.warn(wt('头像压缩后仍超过 200KB，请换一张更小的图片'));
      return;
    }
    setTeamForm((f) => ({ ...f, avatar: dataUrl }));
  };

  /**
   * 头像上传控件：点击圆形预览（有头像显示图片，无则默认 user 图标）+ 上传/移除按钮。
   * 实际文件选择由各弹窗内的隐藏 file input 承担。
   */
  const renderAvatarPicker = (
    avatar: string,
    inputRef: React.RefObject<HTMLInputElement | null>,
    onRemove: () => void,
  ): React.ReactNode => (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="rounded-full overflow-hidden bg-gray-700 border border-gray-600 flex items-center justify-center shrink-0 hover:border-blue-400"
        style={{ width: 64, height: 64 }}
        title={wt('点击上传头像')}
        onClick={() => inputRef.current?.click()}
      >
        {avatar ? <AvatarImg src={avatar} size={64} /> : <Icon name="user" size={32} />}
      </button>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-gray-500">
          {wt('支持 PNG / JPEG / WebP，自动压缩至 256×256（≤200KB）')}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
            onClick={() => inputRef.current?.click()}
          >
            {wt('上传')}
          </button>
          {avatar ? (
            <button
              type="button"
              className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
              onClick={onRemove}
            >
              {wt('移除')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  /** 头像隐藏 file input 通用属性（onChange 在各弹窗内联绑定，选择后清空 value 以支持重复选择同一文件） */
  const avatarInputAttrs = {
    type: 'file' as const,
    accept: 'image/png,image/jpeg,image/webp',
    className: 'hidden',
  };

  const submit = async () => {
    if (!form.name.trim()) {
      toast.warn(t('agents.nameRequired'));
      return;
    }
    if (form.slug.trim() && !/^[a-z0-9][a-z0-9-]*$/i.test(form.slug.trim())) {
      toast.warn(wt('英文标识名仅允许字母、数字与连字符'));
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        name: form.name,
        description: form.description,
        model: form.model.trim() || 'default',
        type: form.type,
        systemPrompt: form.systemPrompt,
        ...(editingId ? { promptRevision: form.promptRevision } : {}),
        slug: form.slug.trim(),
        callable: form.callable,
        invocationHint: form.invocationHint,
        avatar: form.avatar,
      };
      if (editingId) {
        await apiClient.put(`/agents/${encodeURIComponent(editingId)}`, body);
      } else {
        await apiClient.post('/agents', body);
      }
      setModalOpen(false);
      await load();
    } catch (e) {
      toast.error(t('common.saveFailed'), e instanceof Error ? e.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (a: Agent) => {
    if (a.builtin) {
      toast.warn(wt('内置智能体不可删除'));
      return;
    }
    if (
      !(await showConfirm(
        wt(
          '确定要删除智能体 "{{v0}}" 吗？\n\n这将同时删除该智能体的工作区目录和所有配置文件！此操作不可撤销。',
          { v0: a.name },
        ),
      ))
    )
      return;
    try {
      await apiClient.delete(`/agents/${encodeURIComponent(a.id)}`);
      setDetailId('');
      await load();
    } catch (e) {
      toast.error(t('common.deleteFailed'), e instanceof Error ? e.message : undefined);
    }
  };

  // ── 智能体团管理 ──

  const openTeamCreate = () => {
    setTeamEditingId(null);
    setTeamForm({ name: '', description: '', memberIds: [], leadId: '', tagsText: '', avatar: '' });
    setTeamModalOpen(true);
  };

  const openTeamEdit = (team: Team) => {
    setTeamEditingId(team.id);
    setTeamForm({
      name: team.name,
      description: team.description || '',
      memberIds: [...team.memberIds],
      leadId: team.leadId || team.memberIds[0] || '',
      tagsText: (team.tags || []).join('、'),
      avatar: team.avatar || '',
    });
    setTeamModalOpen(true);
  };

  const submitTeam = async () => {
    if (!teamForm.name.trim()) {
      toast.warn(wt('请输入智能体团名称'));
      return;
    }
    if (teamForm.memberIds.length === 0) {
      toast.warn(wt('请至少选择一名智能体团成员'));
      return;
    }
    setTeamSubmitting(true);
    try {
      const body = {
        name: teamForm.name,
        description: teamForm.description,
        memberIds: teamForm.memberIds,
        leadId: teamForm.memberIds.includes(teamForm.leadId)
          ? teamForm.leadId
          : teamForm.memberIds[0],
        tags: teamForm.tagsText
          .split(/[、,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
        avatar: teamForm.avatar,
      };
      if (teamEditingId) {
        await apiClient.put(`/agents/teams/${encodeURIComponent(teamEditingId)}`, body);
      } else {
        await apiClient.post('/agents/teams', body);
      }
      setTeamModalOpen(false);
      await loadTeams();
      toast.success(teamEditingId ? wt('智能体团已更新') : wt('智能体团已创建'));
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setTeamSubmitting(false);
    }
  };

  const removeTeam = async (team: Team) => {
    if (
      !(await showConfirm(
        wt('确定要删除智能体团 "{{v0}}" 吗？（不会删除智能体团成员智能体）', { v0: team.name }),
      ))
    )
      return;
    try {
      await apiClient.delete(`/agents/teams/${encodeURIComponent(team.id)}`);
      setTeamDetailId('');
      await loadTeams();
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const toggleTeamMember = (id: string) => {
    setTeamForm((f) => {
      const memberIds = f.memberIds.includes(id)
        ? f.memberIds.filter((m) => m !== id)
        : [...f.memberIds, id];
      return {
        ...f,
        memberIds,
        leadId: memberIds.includes(f.leadId) ? f.leadId : (memberIds[0] ?? ''),
      };
    });
  };

  /** 召唤智能体团：选中智能体团进入多智能体协作对话 */
  const summonTeam = (team: Team) => {
    selectAgentForChat(`team:${team.id}`);
    toast.success(
      wt('已召唤「{{v0}}」', { v0: team.name }),
      wt('智能体团协作模式已开启，前往对话开始任务'),
    );
    setTeamDetailId('');
    navigate('/');
  };

  // ── 工作区文件管理 ──

  const addWsFile = async () => {
    let fn = wsNewName.trim();
    if (!fn) {
      toast.warn(wt('请输入文件名'));
      return;
    }
    if (/[/\\]|\.\./.test(fn)) {
      toast.warn(wt('文件名不能包含路径分隔符或 ..'));
      return;
    }
    if (!fn.endsWith('.md')) fn += '.md';
    try {
      await apiClient.post(`/agents/${encodeURIComponent(detailId)}/workspace`, {
        file: fn,
        content: '',
      });
      setWsFiles((f) => ({ ...f, [fn]: '' }));
      setWsNewName('');
      setWsEdit({ agentId: detailId, fn, content: '' });
    } catch (e) {
      toast.error(wt('创建失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const saveWsFile = async () => {
    if (!wsEdit) return;
    setWsSaving(true);
    try {
      await apiClient.post(`/agents/${encodeURIComponent(wsEdit.agentId)}/workspace`, {
        file: wsEdit.fn,
        content: wsEdit.content,
      });
      setWsFiles((f) => ({ ...f, [wsEdit.fn]: wsEdit.content }));
      toast.success(wt('工作区文件已保存'));
      setWsEdit(null);
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setWsSaving(false);
    }
  };

  const deleteWsFile = async (fn: string) => {
    if (!(await showConfirm(wt('确定要删除 {{v0}} 吗？', { v0: fn })))) return;
    try {
      // DELETE :id/workspace 需 body 传 file（apiClient.delete 不带 body），fetch 直接携带
      await authenticatedFetch(`/api/agents/${encodeURIComponent(detailId)}/workspace`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: fn }),
      });
      setWsFiles((f) => {
        const n = { ...f };
        delete n[fn];
        return n;
      });
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  // ── 信箱/对话（保留） ──

  const loadMessenger = async (a: Agent) => {
    setDetailLoading(true);
    try {
      const [inboxRes, convRes] = await Promise.all([
        apiClient.get<AgentMessageListResult>(`/agents/inbox/${encodeURIComponent(a.id)}`),
        apiClient.get<AgentMessageListResult>(
          `/agents/conversation?agent1=main&agent2=${encodeURIComponent(a.id)}`,
        ),
      ]);
      setInbox(Array.isArray(inboxRes?.messages) ? inboxRes.messages : []);
      setConversation(Array.isArray(convRes?.messages) ? convRes.messages : []);
    } catch {
      /* 保留空列表 */
    } finally {
      setDetailLoading(false);
    }
  };

  const sendAgentMessage = async () => {
    if (!detailAgent || !msgText.trim()) return;
    setDetailLoading(true);
    try {
      await apiClient.post('/agents/message', {
        from: 'main',
        to: detailAgent.id,
        message: msgText.trim(),
      });
      setMsgText('');
      await loadMessenger(detailAgent);
    } catch (e) {
      toast.error(t('common.sendFailed'), e instanceof Error ? e.message : undefined);
    } finally {
      setDetailLoading(false);
    }
  };

  const modelOptions = models.length
    ? models.map((m) => ({ value: m.id, label: `${m.name} (${m.providerName || '?'})` }))
    : [];

  /** 成员头像叠加排列（智能体团卡片/详情用） */
  const memberStack = (memberIds: string[], size = 20): React.ReactNode => (
    <div className="flex items-center">
      {memberIds.slice(0, 5).map((mid, i) => {
        const m = agents.find((a) => a.id === mid);
        return (
          <span
            key={mid}
            className={`inline-flex items-center justify-center rounded-full bg-gray-700 border border-gray-800 ${i > 0 ? '-ml-1.5' : ''}`}
            style={{ width: size, height: size, zIndex: 10 - i }}
            title={m?.name || mid}
          >
            <Icon name={agentIconName(m?.type)} size={size - 8} />
          </span>
        );
      })}
      {memberIds.length > 5 ? (
        <span
          className="-ml-1.5 inline-flex items-center justify-center rounded-full bg-gray-600 border border-gray-800 text-xs text-gray-300"
          style={{ width: size, height: size }}
        >
          +{memberIds.length - 5}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="max-w-6xl mx-auto p-5">
        {/* ══ 页头（对齐参考形态：标题 + 右上创建） ══ */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold text-primary flex items-center gap-2">
              {wt('智能体')}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {wt('创建智能体，或把它们拉进智能体团组成多智能体协作')}
            </p>
          </div>
          <button className="btn-primary text-sm flex items-center gap-1" onClick={openCreate}>
            <Icon name="plus" size={14} /> {wt('创建')}
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <button className="btn-secondary" onClick={() => navigate('/workflow')}>
            {wt('阶段协作工作流')}
          </button>
        </div>
        <ExpertRunHistory />
        {/* ══ 搜索（智能体 + 智能体团统一过滤；大规模列表的定位入口） ══ */}
        <div className="mb-4">
          <div className="relative">
            <Icon
              name="search"
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              className="input-field text-sm"
              style={{ paddingLeft: 36, width: '100%' }}
              placeholder={wt('搜索智能体或智能体团（名称 / 描述 / 标识 / 标签）…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                onClick={() => setQuery('')}
              >
                <Icon name="x" size={14} />
              </button>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div className="py-20 flex items-center justify-center text-gray-400">
            <span className="spinner inline-block mr-2" /> {wt('加载中…')}
          </div>
        ) : error ? (
          <div className="py-20 flex flex-col items-center justify-center text-red-400 gap-3">
            <span>
              {wt('加载失败:')}
              {error}
            </span>
            <button className="btn-secondary text-sm" onClick={load}>
              {wt('重试')}
            </button>
          </div>
        ) : (
          <>
            {/* ══ 区块一：智能体（简洁行式分组列表；固定高度滚动区防页面拉长） ══ */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-gray-300 mb-2">
                {wt('自定义智能体')}
                {customAgents.length > 0 ? (
                  <span className="text-xs text-gray-500 font-normal ml-2">
                    {wt('共')}
                    {customAgents.length} {wt('个')}
                  </span>
                ) : null}
              </h2>
              {customAgents.length === 0 ? (
                <div className="card p-4 text-gray-500 text-sm flex items-center gap-2">
                  {q ? (
                    wt('没有匹配的自定义智能体')
                  ) : (
                    <>
                      {wt('暂无自定义智能体')}
                      <button
                        className="text-blue-400 underline hover:text-blue-300"
                        onClick={openCreate}
                      >
                        {wt('创建')}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="card divide-y divide-gray-700 max-h-80 overflow-y-auto scrollbar-thin">
                  {customShown.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-700/40 rounded"
                      onClick={() => void openDetail(a.id)}
                    >
                      {a.avatar ? (
                        <AvatarImg src={a.avatar} size={24} />
                      ) : (
                        <span
                          className="flex items-center justify-center"
                          style={{ width: 28, height: 28 }}
                        >
                          <Icon name={agentIconName(a.type)} size={28} />
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{a.name}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {a.description || a.slug || a.id}
                        </p>
                      </div>
                      <span className={statusBadgeClass(a.status)}>{statusLabel(a.status)}</span>
                      <button
                        className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(a);
                        }}
                      >
                        {wt('编辑')}
                      </button>
                      <button
                        className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(a);
                        }}
                      >
                        {wt('删除')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {customAgents.length > RENDER_LIMIT ? (
                <p className="text-xs text-gray-500 mt-1.5 px-1">
                  {wt('共')}
                  {customAgents.length} {wt('个，仅显示前')}
                  {RENDER_LIMIT} {wt('个——请用搜索定位其余智能体')}
                </p>
              ) : null}

              <h2 className="text-sm font-semibold text-gray-300 mt-4 mb-2">{wt('内置智能体')}</h2>
              <div className="card divide-y divide-gray-700">
                {builtinAgents.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-700/40 rounded"
                    onClick={() => void openDetail(a.id)}
                  >
                    {a.avatar ? (
                      <AvatarImg src={a.avatar} size={24} />
                    ) : (
                      <span
                        className="flex items-center justify-center"
                        style={{ width: 28, height: 28 }}
                      >
                        <Icon name={agentIconName(a.type)} size={28} />
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate flex items-center gap-2">
                        {a.name} <span className="badge badge-blue text-xs">{wt('内置')}</span>
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {a.description ? wt(a.description) : wt('不可删除，仅可编辑')}
                      </p>
                    </div>
                    <span className={statusBadgeClass(a.status)}>{statusLabel(a.status)}</span>
                    <button
                      className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(a);
                      }}
                    >
                      {wt('编辑')}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            {/* ══ 区块二：智能体团（专家市场式卡片网格，多智能体协作） ══ */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h2 className="text-sm font-semibold text-gray-300">{wt('智能体团')}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {wt('把多个智能体拉进智能体团，组成多智能体协作单元')}
                  </p>
                </div>
                <button
                  className="btn-secondary text-xs flex items-center gap-1"
                  onClick={openTeamCreate}
                >
                  <Icon name="plus" size={12} /> {wt('创建智能体团')}
                </button>
              </div>
              {teams.length === 0 ? (
                <div className="card p-6 text-center text-gray-500">
                  <p>{q ? wt('没有匹配的智能体团') : wt('暂无智能体团')}</p>
                  {!q ? (
                    <p className="text-xs mt-1">
                      {wt('创建智能体团并拉入智能体成员，对话时召唤即可进入多智能体协作模式')}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="max-h-[26rem] overflow-y-auto scrollbar-thin pr-1">
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {teamShown.map((team) => {
                      const leadName = agents.find((a) => a.id === team.leadId)?.name;
                      return (
                        <div
                          key={team.id}
                          className="card p-4 cursor-pointer hover:border-blue-500/60 transition-colors flex flex-col"
                          onClick={() => setTeamDetailId(team.id)}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            {team.avatar ? (
                              <AvatarImg src={team.avatar} size={48} />
                            ) : (
                              <span
                                className="flex items-center justify-center rounded bg-blue-900/40 border border-blue-700/50"
                                style={{ width: 32, height: 32 }}
                              >
                                <Icon name="users" size={18} />
                              </span>
                            )}
                            <p className="text-sm font-bold text-primary truncate flex-1">
                              {team.name}
                            </p>
                          </div>
                          {(team.tags || []).length > 0 ? (
                            <div className="flex flex-wrap gap-1 mb-2">
                              {team.tags!.slice(0, 4).map((tag) => (
                                <span
                                  key={tag}
                                  className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <p className="text-xs text-gray-400 line-clamp-3 flex-1">
                            {team.description || wt('（暂无智能体团介绍）')}
                          </p>
                          <div className="flex items-center justify-between mt-3">
                            {memberStack(team.memberIds)}
                            <span className="text-xs text-gray-500">
                              {team.memberIds.length} {wt('名成员')}
                              {leadName ? wt(' · 主管 {{v0}}', { v0: leadName }) : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {filteredTeams.length > RENDER_LIMIT ? (
                    <p className="text-xs text-gray-500 mt-2">
                      {wt('共')}
                      {filteredTeams.length} {wt('个智能体团，仅显示前')}
                      {RENDER_LIMIT} {wt('个——请用搜索定位')}
                    </p>
                  ) : null}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {/* ══ 智能体详情弹窗（模型切换/协作信息/信箱/工作区 全功能保留） ══ */}
      {detailAgent ? (
        <div className="modal-overlay" onClick={() => setDetailId('')}>
          <div className="modal-content max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                {detailAgent.avatar ? (
                  <AvatarImg src={detailAgent.avatar} size={20} />
                ) : (
                  <Icon name={agentIconName(detailAgent.type)} size={18} />
                )}
                {detailAgent.name}
                {detailAgent.builtin ? (
                  <span className="badge badge-blue text-xs">{wt('内置')}</span>
                ) : null}
              </h2>
              <button className="modal-close" onClick={() => setDetailId('')}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto scrollbar-thin pr-1 space-y-4">
              {/* 状态 + 操作 */}
              <div className="flex items-center gap-2">
                <span className={statusBadgeClass(detailAgent.status)}>
                  {statusLabel(detailAgent.status)}
                </span>
                <button
                  className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                  onClick={() => openEdit(detailAgent)}
                >
                  {wt('编辑')}
                </button>
                {!detailAgent.builtin ? (
                  <button
                    className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                    onClick={() => void remove(detailAgent)}
                  >
                    {wt('删除')}
                  </button>
                ) : (
                  <span className="text-xs text-gray-500">
                    {wt('内置智能体只能编辑，不能删除')}
                  </span>
                )}
              </div>

              {/* 信息卡 */}
              <div className="card p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400">{wt('智能体 ID')}</label>
                    <p className="text-sm font-mono">{detailAgent.id}</p>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">{wt('类型')}</label>
                    <p className="text-sm">
                      {detailAgent.builtin ? wt('内置') : detailAgent.type || 'specialist'}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">{wt('模型')}</label>
                    {modelOptions.length > 0 ? (
                      <select
                        className="input-field text-sm py-0.5 mt-1 w-full"
                        value={
                          detailAgent.model &&
                          modelOptions.some((m) => m.value === detailAgent.model)
                            ? detailAgent.model
                            : modelOptions[0].value
                        }
                        onChange={(e) => void updateModel(detailAgent, e.target.value)}
                      >
                        {modelOptions.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-yellow-500 mt-1">
                        {wt('未配置模型（去设置页配置）')}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">{wt('任务完成')}</label>
                    <p className="text-sm">{detailAgent.tasksCompleted || 0}</p>
                  </div>
                </div>
              </div>

              {/* 多智能体协作信息 */}
              <div className="card p-3">
                <h3 className="text-xs font-semibold text-gray-400 mb-2 flex items-center gap-1">
                  <Icon name="users" size={14} /> {wt('多智能体协作')}
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400">{wt('英文标识名')}</label>
                    <p className="text-sm font-mono">{detailAgent.slug || '—'}</p>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">{wt('可被其他智能体调用')}</label>
                    <p className="text-sm">
                      {detailAgent.callable !== false ? wt('是') : wt('否')}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-gray-400">{wt('何时调用')}</label>
                    <p className="text-sm whitespace-pre-wrap">
                      {detailAgent.invocationHint || '—'}
                    </p>
                  </div>
                </div>
              </div>

              {/* 信箱/对话 */}
              <div>
                <button
                  className="text-sm font-semibold text-blue-300 flex items-center gap-1"
                  onClick={() => {
                    setShowMessenger((v) => !v);
                    if (!showMessenger) void loadMessenger(detailAgent);
                  }}
                >
                  <Icon name="mail" size={16} /> {wt('信箱 / 对话（未读')}
                  {inbox.filter((m) => !m.read).length}）
                </button>
                {showMessenger ? (
                  <div className="card p-3 mt-2">
                    {detailLoading ? (
                      <p className="text-xs text-gray-500">{wt('加载中…')}</p>
                    ) : (
                      <>
                        <div className="max-h-40 overflow-y-auto scrollbar-thin mb-2 space-y-1">
                          {(conversation.length > 0 ? conversation : inbox).length === 0 ? (
                            <p className="text-xs text-gray-500">{wt('暂无消息')}</p>
                          ) : (
                            (conversation.length > 0 ? conversation : inbox).map((m) => (
                              <div key={m.id} className="text-xs flex gap-2">
                                <span className="text-gray-500 shrink-0">
                                  {formatRelativeTime(m.timestamp)}
                                </span>
                                <span className="text-blue-400 shrink-0">
                                  {m.fromName || m.from}→{m.toName || m.to}:
                                </span>
                                <span className="text-gray-300 break-all">{m.content}</span>
                              </div>
                            ))
                          )}
                        </div>
                        <div className="flex gap-2">
                          <input
                            className="input-field flex-1 text-sm"
                            placeholder={wt('以 main 身份发消息给该智能体…')}
                            value={msgText}
                            onChange={(e) => setMsgText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void sendAgentMessage();
                            }}
                          />
                          <button
                            className="btn-primary text-sm"
                            onClick={() => void sendAgentMessage()}
                          >
                            {wt('发送')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              {/* 工作区配置 */}
              <div>
                <h3 className="font-semibold text-blue-300 text-sm flex items-center gap-1 mb-2">
                  <Icon name="file" size={16} /> {wt('工作区配置')}
                </h3>
                <div className="flex gap-2 mb-3">
                  <input
                    className="input-field flex-1 text-sm"
                    placeholder={wt('新文件名（如 TOOLS.md，自动补 .md 后缀）')}
                    value={wsNewName}
                    onChange={(e) => setWsNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addWsFile();
                    }}
                  />
                  <button
                    className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                    onClick={() => void addWsFile()}
                  >
                    {wt('+ 添加文件')}
                  </button>
                </div>
                {wsLoading ? (
                  <div className="card p-6 text-center text-gray-500">
                    <span className="spinner inline-block mr-2" /> {wt('加载工作区…')}
                  </div>
                ) : Object.keys(wsFiles).length > 0 ? (
                  <div className="space-y-3">
                    {Object.entries(wsFiles).map(([fn, content]) => (
                      <div className="card p-3" key={fn}>
                        <div className="flex justify-between items-center mb-2">
                          <h3 className="font-medium text-primary text-sm">{fn}</h3>
                          <div className="flex gap-1">
                            <button
                              className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                              onClick={() => setWsEdit({ agentId: detailAgent.id, fn, content })}
                            >
                              {wt('编辑')}
                            </button>
                            <button
                              className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                              onClick={() => void deleteWsFile(fn)}
                            >
                              {wt('删除')}
                            </button>
                          </div>
                        </div>
                        <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {content.substring(0, 500)}
                          {content.length > 500 ? wt('\n... (点击编辑查看完整内容)') : ''}
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="card p-4 text-center text-gray-500 text-sm">
                    <p>{wt('暂无工作区文件')}</p>
                  </div>
                )}
                <div className="card p-3 mt-3">
                  <h4 className="text-xs font-semibold text-gray-400 mb-1">
                    {wt('工作区文件说明')}
                  </h4>
                  <div className="text-xs text-gray-500 space-y-0.5">
                    <p>
                      <b className="text-gray-300">SOUL.md</b>{' '}
                      {wt('- AI人格定义（语气、风格、行为准则）')}
                    </p>
                    <p>
                      <b className="text-gray-300">AGENTS.md</b>{' '}
                      {wt('- 行为规则（工具优先级、安全红线）')}
                    </p>
                    <p>
                      <b className="text-gray-300">IDENTITY.md</b>{' '}
                      {wt('- 身份信息（名字、类型、能力）')}
                    </p>
                    <p>
                      <b className="text-gray-300">USER.md</b>{' '}
                      {wt('- 用户画像（称呼、时区、语言偏好）')}
                    </p>
                    <p>
                      <b className="text-gray-300">MEMORY.md</b>{' '}
                      {wt('- 长期记忆（重要信息持久化）')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ══ 智能体团详情弹窗（魅力介绍/擅长领域/成员列表含主管/试试这样问我/召唤智能体团） ══ */}
      {detailTeam ? (
        <div className="modal-overlay" onClick={() => setTeamDetailId('')}>
          <div className="modal-content max-w-xl" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                {detailTeam.avatar ? (
                  <AvatarImg src={detailTeam.avatar} size={20} />
                ) : (
                  <Icon name="users" size={18} />
                )}
                {detailTeam.name}
              </h2>
              <div className="flex items-center gap-1">
                <button
                  className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                  onClick={() => {
                    setTeamDetailId('');
                    openTeamEdit(detailTeam);
                  }}
                >
                  {wt('编辑')}
                </button>
                <button
                  className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                  onClick={() => void removeTeam(detailTeam)}
                >
                  {wt('删除')}
                </button>
                <button className="modal-close" onClick={() => setTeamDetailId('')}>
                  <Icon name="x" size={18} />
                </button>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-gray-400 mb-1">{wt('魅力介绍')}</h3>
                <p className="text-sm text-gray-300 whitespace-pre-wrap">
                  {detailTeam.description || wt('（暂无智能体团介绍）')}
                </p>
              </div>
              {(detailTeam.tags || []).length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold text-gray-400 mb-1">{wt('擅长领域')}</h3>
                  <div className="flex flex-wrap gap-1">
                    {detailTeam.tags!.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 mb-1">{wt('智能体团成员')}</h3>
                <div className="space-y-1">
                  {detailTeam.memberIds.map((mid) => {
                    const m = agents.find((a) => a.id === mid);
                    const isLead = mid === (detailTeam.leadId || detailTeam.memberIds[0]);
                    return (
                      <div
                        key={mid}
                        className="flex items-center gap-2 p-1.5 rounded hover:bg-gray-700/40"
                      >
                        <span
                          className="flex items-center justify-center"
                          style={{ width: 22, height: 22 }}
                        >
                          <Icon name={agentIconName(m?.type)} size={22} />
                        </span>
                        <span className="text-sm">{m?.name || mid}</span>
                        <span className="text-xs text-gray-500 truncate">
                          {m?.description || m?.slug || ''}
                        </span>
                        {isLead ? (
                          <span className="badge badge-yellow text-xs shrink-0">{wt('主管')}</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-gray-400 mb-1">{wt('试试这样问我')}</h3>
                <div className="space-y-1">
                  {[
                    wt('介绍一下「{{v0}}」的智能体团分工', { v0: detailTeam.name }),
                    wt('用「{{v0}}」帮我完成一个任务', { v0: detailTeam.name }),
                  ].map((q) => (
                    <button
                      key={q}
                      className="w-full text-left text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-3 py-2 flex items-center justify-between"
                      onClick={() => summonTeam(detailTeam)}
                    >
                      <span className="truncate">{q}</span>
                      <Icon name="chevron-right" size={14} />
                    </button>
                  ))}
                </div>
              </div>
              <button
                className="w-full btn-primary py-2.5 text-sm font-semibold flex items-center justify-center gap-2"
                onClick={() => summonTeam(detailTeam)}
              >
                <Icon name="users" size={16} /> {wt('召唤')}
                {detailTeam.name}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 创建/编辑智能体弹窗 */}
      {modalOpen ? (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="agent" size={18} />{' '}
                {editingId ? wt('编辑智能体') : t('views.createAgent')}
              </h2>
              <button className="modal-close" onClick={() => setModalOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3 max-h-[65vh] overflow-y-auto scrollbar-thin pr-1">
              {/* 头像上传：点击圆形预览选择图片，前端压缩为 base64 dataURL 后随表单提交 */}
              <div>
                <label className="form-label">{wt('头像')}</label>
                {renderAvatarPicker(form.avatar, avatarInputRef, () =>
                  setForm({ ...form, avatar: '' }),
                )}
              </div>
              <div>
                <label className="form-label">
                  {wt('名称')}
                  <span className="text-red-400">*</span>
                </label>
                <input
                  className="form-input"
                  maxLength={20}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={wt('请输入智能体名称')}
                />
                <p className="text-xs text-gray-500 text-right mt-0.5">{form.name.length}/20</p>
              </div>
              <div>
                <label className="form-label">{wt('提示词')}</label>
                <textarea
                  className="form-input"
                  rows={5}
                  maxLength={10000}
                  value={form.systemPrompt}
                  onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                  placeholder={wt(
                    '请输入智能体的角色、语气、工作流程、工具偏好及规则规范等。（选填）',
                  )}
                />
                <p className="text-xs text-gray-500 text-right mt-0.5">
                  {form.systemPrompt.length}/10000
                </p>
              </div>
              <div>
                <label className="form-label">{wt('描述')}</label>
                <input
                  className="form-input"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={wt('智能体职责描述')}
                />
              </div>
              <div className="card p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{wt('可被其他智能体调用')}</p>
                    <p className="text-xs text-gray-500">
                      {wt('开启后多智能体协作时可将任务委派给该智能体')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`relative inline-flex h-5 w-10 flex-shrink-0 rounded-full transition-colors ${
                      form.callable ? 'bg-green-600' : 'bg-gray-600'
                    }`}
                    onClick={() => setForm({ ...form, callable: !form.callable })}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        form.callable ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                      style={{ marginTop: 2 }}
                    />
                  </button>
                </div>
              </div>
              <div>
                <label className="form-label">
                  {wt('英文标识名')}
                  <span className="text-red-400">*</span>
                </label>
                <input
                  className="form-input font-mono"
                  maxLength={50}
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  placeholder={wt('被调用时的唯一英文标识名称，例如：project-analyzer')}
                />
                <p className="text-xs text-gray-500 text-right mt-0.5">{form.slug.length}/50</p>
              </div>
              <div>
                <label className="form-label">
                  {wt('何时调用')}
                  <span className="text-red-400">*</span>
                </label>
                <textarea
                  className="form-input"
                  rows={3}
                  value={form.invocationHint}
                  onChange={(e) => setForm({ ...form, invocationHint: e.target.value })}
                  placeholder={wt('请描述其他智能体调用该智能体的合适场景和时机')}
                />
              </div>
              <div>
                <label className="form-label">{wt('模型')}</label>
                {modelOptions.length > 0 ? (
                  <select
                    className="form-input"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                  >
                    {modelOptions.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="form-input font-mono"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder={wt('模型 ID（先在设置中配置模型）')}
                  />
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setModalOpen(false)}>
                {wt('取消')}
              </button>
              <button className="btn-primary" onClick={() => void submit()} disabled={submitting}>
                {submitting ? wt('保存中…') : editingId ? wt('保存') : wt('创建')}
              </button>
            </div>
            {/* 头像文件选择器（隐藏）：仅允许 PNG/JPEG/WebP，选择后压缩并回填表单 */}
            <input
              {...avatarInputAttrs}
              ref={avatarInputRef}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void pickAvatar(f);
              }}
            />
          </div>
        </div>
      ) : null}

      {/* 智能体团创建/编辑弹窗 */}
      {teamModalOpen ? (
        <div className="modal-overlay" onClick={() => setTeamModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="users" size={18} />{' '}
                {teamEditingId ? wt('编辑智能体团') : wt('创建智能体团')}
              </h2>
              <button className="modal-close" onClick={() => setTeamModalOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3">
              {/* 头像上传：点击圆形预览选择图片，前端压缩为 base64 dataURL 后随表单提交 */}
              <div>
                <label className="form-label">{wt('智能体团头像')}</label>
                {renderAvatarPicker(teamForm.avatar, teamAvatarInputRef, () =>
                  setTeamForm({ ...teamForm, avatar: '' }),
                )}
              </div>
              <div>
                <label className="form-label">
                  {wt('智能体团名称')}
                  <span className="text-red-400">*</span>
                </label>
                <input
                  className="form-input"
                  value={teamForm.name}
                  onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })}
                  placeholder={wt('例如：研发协作组')}
                />
              </div>
              <div>
                <label className="form-label">{wt('魅力介绍')}</label>
                <textarea
                  className="form-input"
                  rows={3}
                  value={teamForm.description}
                  onChange={(e) => setTeamForm({ ...teamForm, description: e.target.value })}
                  placeholder={wt('该智能体团的职责与协作目标（展示在智能体团卡片与详情页）')}
                />
              </div>
              <div>
                <label className="form-label">{wt('擅长领域标签')}</label>
                <input
                  className="form-input"
                  value={teamForm.tagsText}
                  onChange={(e) => setTeamForm({ ...teamForm, tagsText: e.target.value })}
                  placeholder={wt('用、或,分隔，例如：SEO内容、关键词研究、转化率优化')}
                />
              </div>
              <div>
                <label className="form-label">
                  {wt('智能体团成员')}
                  <span className="text-red-400">*</span>
                </label>
                <p className="text-xs text-gray-500 mb-1">
                  {wt(
                    '将智能体拉进智能体团组成多智能体协作单元；对话时召唤该智能体团即进入协作模式',
                  )}
                </p>
                <button
                  className="btn-secondary text-sm"
                  onClick={() => {
                    setMemberQuery('');
                    setMemberPickerOpen(true);
                  }}
                >
                  {wt('选择成员（已选')}
                  {teamForm.memberIds.length} {wt('个）')}
                </button>
                {teamForm.memberIds.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {teamForm.memberIds.map((mid) => (
                      <span key={mid} className="badge badge-blue text-xs flex items-center gap-1">
                        {agents.find((a) => a.id === mid)?.name || mid}
                        <Icon
                          name="x"
                          size={11}
                          className="cursor-pointer opacity-60 hover:opacity-100"
                          onClick={() => toggleTeamMember(mid)}
                        />
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div>
                <label className="form-label">{wt('主管人')}</label>
                <select
                  className="form-input"
                  value={teamForm.leadId}
                  onChange={(e) => setTeamForm({ ...teamForm, leadId: e.target.value })}
                >
                  {teamForm.memberIds.map((mid) => (
                    <option key={mid} value={mid}>
                      {agents.find((a) => a.id === mid)?.name || mid}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-0.5">
                  {wt('智能体团详情页将标注该成员为「主管」')}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setTeamModalOpen(false)}>
                {wt('取消')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void submitTeam()}
                disabled={teamSubmitting}
              >
                {teamSubmitting ? wt('保存中…') : teamEditingId ? wt('保存') : wt('创建')}
              </button>
            </div>
            {/* 头像文件选择器（隐藏）：仅允许 PNG/JPEG/WebP，选择后压缩并回填表单 */}
            <input
              {...avatarInputAttrs}
              ref={teamAvatarInputRef}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void pickTeamAvatar(f);
              }}
            />
          </div>
        </div>
      ) : null}

      {/* 工作区文件编辑弹窗 */}
      {wsEdit ? (
        <div className="modal-overlay" onClick={() => setWsEdit(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="file" size={18} /> {wt('编辑:')}
                {wsEdit.fn}
              </h2>
              <button className="modal-close" onClick={() => setWsEdit(null)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <textarea
              className="form-input font-mono text-xs"
              rows={18}
              value={wsEdit.content}
              onChange={(e) => setWsEdit({ ...wsEdit, content: e.target.value })}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setWsEdit(null)}>
                {wt('取消')}
              </button>
              <button className="btn-primary" onClick={() => void saveWsFile()} disabled={wsSaving}>
                {wsSaving ? wt('保存中…') : wt('保存')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 成员选择弹窗：搜索框 + 滚动列表勾选（支撑 10 万量级智能体——搜索定位 + 固定高度滚动 + 渲染上限） */}
      {memberPickerOpen ? (
        <div className="modal-overlay" onClick={() => setMemberPickerOpen(false)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 460 }}
          >
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="agent" size={18} /> {wt('选择智能体团成员')}
              </h2>
              <button className="modal-close" onClick={() => setMemberPickerOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <input
              className="form-input mb-2"
              placeholder={wt('搜索名称 / 描述 / 英文标识…')}
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              autoFocus
            />
            <div className="text-xs text-gray-500 mb-1">
              {wt('已选')}
              {teamForm.memberIds.length} {wt('个 · 勾选即加入智能体团')}
            </div>
            <div className="max-h-72 overflow-y-auto scrollbar-thin space-y-1 border border-gray-700 rounded p-2">
              {(() => {
                // 搜索过滤（名称/描述/标识）+ 渲染上限（超大规模防卡死，超出部分用搜索定位）
                const q = memberQuery.trim().toLowerCase();
                const hit = (a: Agent) =>
                  !q ||
                  a.name.toLowerCase().includes(q) ||
                  (a.description || '').toLowerCase().includes(q) ||
                  (a.slug || '').toLowerCase().includes(q);
                const PICK_RENDER_LIMIT = 200;
                const list = agents.filter(hit).slice(0, PICK_RENDER_LIMIT);
                return (
                  <>
                    {list.map((a) => (
                      <label
                        key={a.id}
                        className="flex items-center gap-2 p-1.5 rounded hover:bg-gray-700 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="accent-blue-500"
                          checked={teamForm.memberIds.includes(a.id)}
                          onChange={() => toggleTeamMember(a.id)}
                        />
                        {a.avatar ? <AvatarImg src={a.avatar} size={20} /> : null}
                        <span className="text-sm">{a.name}</span>
                        <span className="text-xs text-gray-500 truncate">{a.slug || a.id}</span>
                        {a.builtin ? (
                          <span className="badge badge-blue text-xs">{wt('内置')}</span>
                        ) : null}
                      </label>
                    ))}
                    {list.length === 0 ? (
                      <div className="text-sm text-gray-500 p-2">{wt('无匹配的智能体')}</div>
                    ) : null}
                    {agents.filter(hit).length > PICK_RENDER_LIMIT ? (
                      <div className="text-xs text-yellow-500 p-2">
                        {wt('匹配过多，仅显示前')}
                        {PICK_RENDER_LIMIT} {wt('个，请用搜索缩小范围')}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-primary" onClick={() => setMemberPickerOpen(false)}>
                {wt('完成（已选')}
                {teamForm.memberIds.length} {wt('个）')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
