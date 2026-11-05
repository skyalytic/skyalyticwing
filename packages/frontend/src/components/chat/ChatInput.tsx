import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { primaryModifier, shortcutText } from '@/utils/shortcuts';
import { useDataStore } from '@/services/data-loader';
// 聊天输入区（对齐旧版 renderChatView 底部结构）：
// 工具栏（@ 智能体切换 + 模型选择 + 配置 + 附件 + 压缩 + 清空 + 工具面板）→ 附件预览 → textarea + 发送/停止
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { ApprovalTakeover } from './ApprovalTakeover';
import { useApprovalStore } from '@/stores/approval-store';
import { apiClient } from '@/services/api-client';
import { useSessionStore } from '@/stores/session-store';
import { useProjectPanel } from '@/stores/project-panel-store';
import { formatFileSize } from '@/utils/format';
import type { Attachment } from '@/types';
import {
  BROWSER_ANNOTATION_EVENT,
  isBrowserAnnotation,
  type BrowserAnnotationEvent,
} from '@/services/browser-annotation';
import { BrowserAnnotationChip } from './BrowserAnnotationChip';
import { PermissionModePicker } from './PermissionModePicker';
import { ComposerPicker } from './ComposerPicker';
import { CONTEXT_REFERENCE_EVENT, isContextAttachment } from '@/services/context-reference';
import { readLocalSettings, PREFERENCES_CHANGED } from '@/utils/local-preferences';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';

export interface ChatInputProps {
  onSend: (content: string, attachments?: Attachment[], model?: string) => void;
  /** 停止流式生成（流式中按钮切换为"停止"） */
  onStop?: () => void;
  stopping?: boolean;
  disabled?: boolean;
  /** 只读透视（子代理/系统会话）：隐藏输入区，仅显示提示横幅 */
  readonly?: boolean;
  /** 压缩对话上下文（POST /api/compact） */
  onCompact?: () => void;
  /** 清空当前对话（确认后调用） */
  onClear?: () => void;
  /** 打开工具面板 */
  onOpenToolPanel?: () => void;
}

/** 可用模型项（GET /api/models） */
interface AvailableModel {
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
  available?: boolean;
  /** 模型类型：chat 对话模型 / image 生图模型 / video 生视频模型（旧版响应可能无 kind，缺省按 chat 处理） */
  kind?: 'chat' | 'image' | 'video';
}

/** 智能体条目（GET /agents；内置/自定义分组展示） */
interface AgentOption {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  /** 头像（base64 dataURL；空/缺省表示未设置） */
  avatar?: string;
}

/** 智能体团队条目（GET /agents/teams；选中进入多智能体协作模式） */
interface TeamOption {
  id: string;
  name: string;
  memberIds: string[];
  /** 团队头像（base64 dataURL；空/缺省表示未设置） */
  avatar?: string;
}

/** 旧版附件接受的文件类型 */
const ACCEPT =
  'image/*,.pdf,.txt,.md,.json,.csv,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.h,.go,.rs,.rb,.php,.sh,.bat,.ps1,.yaml,.yml,.toml,.ini,.log,.sql';
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** 项目文件夹 chip（工程模式）：显示当前项目名，点击打开目录选择器 */
function ProjectChip() {
  useWorkbenchLanguage();
  const projectDir = useProjectPanel((s) => s.projectDir);
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);
  const initProjectDir = useProjectPanel((s) => s.initProjectDir);
  // 惰性初始化（ChatInput 挂载即拉取一次，store 内有 initialized 防重）
  useEffect(() => {
    void initProjectDir();
  }, [initProjectDir]);
  const dirName = projectDir
    ? projectDir
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || projectDir
    : '';
  return (
    <button
      className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300 hover:bg-gray-700 flex items-center gap-1"
      title={
        projectDir
          ? wt('当前项目文件夹: {{v0}}（点击更换）', { v0: projectDir })
          : wt('选择项目文件夹（AI 产物将保存到该目录）')
      }
      onClick={() => setPickerOpen(true)}
    >
      <Icon name="folder" size={12} style={{ opacity: projectDir ? 0.95 : 0.5 }} />
      <span className="max-w-[140px] truncate">{dirName || wt('选择文件夹')}</span>
    </button>
  );
}

export function ChatInput({
  onSend,
  onStop,
  stopping,
  disabled,
  readonly,
  onCompact,
  onClear,
  onOpenToolPanel,
}: ChatInputProps) {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const requestedModelId = (location.state as { selectedModelId?: string } | null)?.selectedModelId;
  const [selectedModelId, setSelectedModelId] = useState('');
  const [modelOverride, setModelOverride] = useState<string | undefined>();
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  // Keep model configuration changes in sync without overwriting the current choice.
  useEffect(
    () =>
      useDataStore.subscribe((next, previous) => {
        if (next.models !== previous.models)
          setModels((next.models as AvailableModel[]).filter((m) => m.available));
      }),
    [],
  );
  const [currentModel, setCurrentModel] = useState('');
  const [currentImageModel, setCurrentImageModel] = useState('');
  const [currentVideoModel, setCurrentVideoModel] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 审批接管：存在待决审批时占据输入区（第一个进 takeover，其余留在 ApprovalInlineStack）
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const approvalSessionId = useSessionStore((s) => s.currentSessionId);
  useEffect(() => {
    setAttachments((items) => items.filter((item) => !isContextAttachment(item)));
  }, [approvalSessionId]);
  const approval = pendingApprovals.find(
    (item) => !item.sessionId || item.sessionId === approvalSessionId,
  );
  // G 计划模式：开启后发送的消息自动携带"先出计划再执行"约束（前端注入前缀，零后端改动）
  const [preferences, setPreferences] = useState(readLocalSettings);
  const planMode = preferences.planMode;
  useEffect(() => {
    const sync = () => setPreferences(readLocalSettings());
    window.addEventListener(PREFERENCES_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const [picker, setPicker] = useState<{
    mode: '@' | '/';
    start: number;
    end: number;
    query: string;
  } | null>(null);
  useEffect(() => setPicker(null), [approvalSessionId]);
  const finishPicker = () => {
    if (picker) setValue((text) => text.slice(0, picker.start) + text.slice(picker.end));
    setPicker(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const addReference = (att: Attachment) => {
    setAttachments((items) => (items.some((i) => i.url === att.url) ? items : [...items, att]));
    finishPicker();
  };
  const updateTrigger = (text: string, caret: number) => {
    const match = /(?:^|\s)([@/])([^\s@/]*)$/.exec(text.slice(0, caret));
    setPicker(
      match
        ? {
            mode: match[1] as '@' | '/',
            start: caret - match[2]!.length - 1,
            end: caret,
            query: match[2]!,
          }
        : null,
    );
  };
  useEffect(() => {
    const add = (e: Event) => {
      const att = (e as CustomEvent<Attachment>).detail;
      if (!att || !isContextAttachment(att) || readonly) return;
      setAttachments((items) => (items.some((i) => i.url === att.url) ? items : [...items, att]));
      textareaRef.current?.focus();
    };
    window.addEventListener(CONTEXT_REFERENCE_EVENT, add);
    return () => window.removeEventListener(CONTEXT_REFERENCE_EVENT, add);
  }, [readonly]);
  // ── @ 智能体切换器（对齐参考形态：内置/自定义/团队分组 + 打勾 + 创建入口） ──
  const currentAgentId = useSessionStore((s) => s.currentAgentId);
  const selectAgent = useSessionStore((s) => s.selectAgent);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const agentButtonRef = useRef<HTMLButtonElement>(null);
  // portal 面板位置（fixed 定位）：以按钮上缘为基线向上展开——
  // 渲染到 body 的 portal + fixed 对任何祖先的 overflow/定位上下文免疫，
  // 从机制上杜绝"向下弹"；left 做视口右缘防溢出钳制
  const [pickerPos, setPickerPos] = useState({ left: 0, bottom: 0 });

  const toggleAgentPicker = useCallback(() => {
    if (!agentPickerOpen && agentButtonRef.current) {
      const r = agentButtonRef.current.getBoundingClientRect();
      setPickerPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 272)),
        bottom: window.innerHeight - r.top + 6,
      });
    }
    setAgentPickerOpen((v) => !v);
  }, [agentPickerOpen]);

  useEffect(() => {
    apiClient
      .get<AgentOption[] | { agents?: AgentOption[] }>('/agents')
      .then((d) => setAgents(Array.isArray(d) ? d : d?.agents || []))
      .catch(() => setAgents([]));
    apiClient
      .get<TeamOption[] | { teams?: TeamOption[] }>('/agents/teams')
      .then((d) => setTeams(Array.isArray(d) ? d : d?.teams || []))
      .catch(() => setTeams([]));
  }, []);

  // 点击面板外部关闭
  useEffect(() => {
    if (!agentPickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setAgentPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [agentPickerOpen]);

  // General text insertion is separate from structured webpage annotations.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text !== 'string' || !text) return;
      setValue((v) => (v ? `${v}\n${text}` : text));
      textareaRef.current?.focus();
    };
    window.addEventListener('sky-insert-text', onInsert);
    return () => window.removeEventListener('sky-insert-text', onInsert);
  }, []);

  useEffect(() => {
    const onAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<BrowserAnnotationEvent>).detail;
      if (readonly || !detail?.attachment || !isBrowserAnnotation(detail.attachment)) return;
      setAttachments((items) =>
        items.some((item) => item.url === detail.attachment.url)
          ? items
          : [...items, detail.attachment],
      );
      if (detail.comment)
        setValue((text) => (text ? `${text}\n${detail.comment}` : detail.comment));
      textareaRef.current?.focus();
    };
    window.addEventListener(BROWSER_ANNOTATION_EVENT, onAnnotation);
    return () => window.removeEventListener(BROWSER_ANNOTATION_EVENT, onAnnotation);
  }, [readonly]);

  const builtinList = agents.filter((a) => a.builtin);
  const customList = agents.filter((a) => !a.builtin);
  const selectedAgent = currentAgentId?.startsWith('team:')
    ? teams.find((tm) => `team:${tm.id}` === currentAgentId)
    : agents.find((a) => a.id === currentAgentId);
  const selectedLabel = !currentAgentId
    ? wt('默认')
    : selectedAgent
      ? selectedAgent.name
      : currentAgentId.startsWith('team:')
        ? wt('团队')
        : currentAgentId;
  /** 当前选中项的头像（智能体/团队；无选中或未设置头像时为空，@ 按钮回退默认样式） */
  const selectedAvatar = !currentAgentId
    ? ''
    : currentAgentId.startsWith('team:')
      ? teams.find((tm) => `team:${tm.id}` === currentAgentId)?.avatar || ''
      : agents.find((a) => a.id === currentAgentId)?.avatar || '';

  // 拉取可用模型与默认模型（旧版 _availModels / _getEffectiveModel）；同时恢复默认生图/生视频模型
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const list = await apiClient.get<{ models: AvailableModel[] }>('/models');
        const avail = (list?.models || []).filter((m) => m.available);
        if (!active) return;
        setModels(avail);
        const g = await apiClient.get<Record<string, unknown>>('/config/general');
        const gv = (g as { value?: Record<string, unknown> })?.value ?? g;
        const readStr = (key: string): string =>
          typeof gv?.[key] === 'string' ? (gv[key] as string) : '';
        const df = readStr('defaultModel');
        const dfImg = readStr('defaultImageModel');
        const dfVid = readStr('defaultVideoModel');
        if (!active) return;
        const chatAvail = avail.filter((m) => (m.kind ?? 'chat') === 'chat');
        const eff =
          df && chatAvail.some((m) => m.id === df)
            ? df
            : chatAvail.length > 0
              ? chatAvail[0].id
              : '';
        setCurrentModel(eff);
        setSelectedModelId(avail.some((m) => m.id === requestedModelId) ? requestedModelId! : eff);
        setModelOverride(
          chatAvail.some((m) => m.id === requestedModelId) ? requestedModelId : undefined,
        );
        setCurrentImageModel(
          dfImg && avail.some((m) => m.id === dfImg && m.kind === 'image') ? dfImg : '',
        );
        setCurrentVideoModel(
          dfVid && avail.some((m) => m.id === dfVid && m.kind === 'video') ? dfVid : '',
        );
      } catch {
        /* 加载失败保持空列表（显示未配置提示） */
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [requestedModelId]);

  // 切换模型：chat 写 general.defaultModel（对话即时生效）；image/video 分别写 defaultImageModel / defaultVideoModel
  const switchModel = useCallback(
    async (modelId: string) => {
      if (!modelId) return;
      setSelectedModelId(modelId);
      const kind = models.find((m) => m.id === modelId)?.kind ?? 'chat';
      if (kind === 'chat') {
        setCurrentModel(modelId);
        setModelOverride(modelId);
      } else if (kind === 'image') {
        setCurrentImageModel(modelId);
      } else {
        setCurrentVideoModel(modelId);
      }
      try {
        const g = await apiClient.get('/config/general');
        const gv =
          (g as { value?: Record<string, unknown> })?.value ?? (g as Record<string, unknown>) ?? {};
        const patch: Record<string, string> =
          kind === 'chat'
            ? { defaultModel: modelId }
            : kind === 'image'
              ? { defaultImageModel: modelId }
              : { defaultVideoModel: modelId };
        await apiClient.put('/config/general', { ...gv, ...patch });
        if (kind === 'image') toast.success(t('chat.defaultImageSet'));
        else if (kind === 'video') toast.success(t('chat.defaultVideoSet'));
      } catch {
        /* 持久化失败不影响本次会话使用 */
      }
    },
    [models, t],
  );

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    if (disabled) return;
    // 计划模式：注入先规划约束，AI 用 todo 工具拆解出计划卡，经确认后再执行
    const payload = planMode
      ? wt(
          '【计划模式】新任务先给出执行计划，待用户确认后执行。若本轮已确认计划或要求继续，则按确认的计划执行并验证结果。\n\n{{v0}}',
          { v0: text },
        )
      : text;
    if (modelOverride)
      onSend(payload || ' ', attachments.length > 0 ? attachments : undefined, modelOverride);
    else onSend(payload || ' ', attachments.length > 0 ? attachments : undefined);
    setValue('');
    setPicker(null);
    setAttachments([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = 'auto';
    });
  }, [value, disabled, attachments, onSend, planMode, modelOverride]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || picker) return;
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.altKey &&
        (preferences.sendOnEnter ? !e.ctrlKey && !e.metaKey : primaryModifier(e))
      ) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, picker, preferences.sendOnEnter],
  );

  const addFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((f) => {
      if (f.size > MAX_FILE_SIZE) {
        alert(wt('文件过大: {{v0}} (最大10MB)', { v0: f.name }));
        return;
      }
      const r = new FileReader();
      r.addEventListener('load', () => {
        setAttachments((prev) => [
          ...prev,
          {
            type: f.type.startsWith('image/')
              ? 'image'
              : f.type.startsWith('video/')
                ? 'video'
                : f.type.startsWith('audio/')
                  ? 'audio'
                  : 'file',
            name: f.name,
            mimeType: f.type,
            size: f.size,
            url: String(r.result),
          },
        ]);
      });
      r.addEventListener('error', () => alert(wt('文件读取失败: {{v0}}', { v0: f.name })));
      r.readAsDataURL(f);
    });
  }, []);

  // 粘贴图片（旧版 handleChatPaste）
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const images: DataTransferItem[] = [];
      for (const it of items) {
        if (it.type.indexOf('image/') === 0) images.push(it);
      }
      if (images.length === 0) return;
      e.preventDefault();
      for (const it of images) {
        const f = it.getAsFile();
        if (f) addFiles([f]);
      }
    },
    [addFiles],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const clearChat = useCallback(async () => {
    const ok = await showConfirm(wt('确定清空当前对话的所有消息？'));
    if (ok) onClear?.();
  }, [onClear]);

  // 模型按 kind 分组（缺省 kind 视为 chat；分组下拉展示对话/生图/生视频模型）
  const chatModels = models.filter((m) => (m.kind ?? 'chat') === 'chat');
  const imageModels = models.filter((m) => m.kind === 'image');
  const videoModels = models.filter((m) => m.kind === 'video');

  // ── 工具栏（旧版 _toolBar + @ 智能体切换器）──
  // 纯平列表（无分组标题/分割线）：内置 → 自定义 → 团队，图标/头像区分类型；
  // 固定高度滚动区，数量多时鼠标滚轮/滚动条可用
  const agentFlatList: Array<{
    key: string;
    id: string;
    label: string;
    isTeam: boolean;
    avatar?: string;
  }> = [
    ...builtinList.map((a) => ({
      key: a.id,
      id: a.id,
      label: a.name,
      isTeam: false,
      avatar: a.avatar,
    })),
    ...customList.map((a) => ({
      key: a.id,
      id: a.id,
      label: a.name,
      isTeam: false,
      avatar: a.avatar,
    })),
    ...teams.map((tm) => ({
      key: `team:${tm.id}`,
      id: `team:${tm.id}`,
      label: wt('{{v0}}（{{v1}}人协作）', { v0: tm.name, v1: tm.memberIds.length }),
      isTeam: true,
      avatar: tm.avatar,
    })),
  ];
  const agentPicker = agentPickerOpen
    ? // Portal 渲染到 body + fixed：永远以按钮上缘为基线向上展开
      createPortal(
        <div
          ref={agentPickerRef}
          className="fixed w-64 max-h-72 overflow-y-auto scrollbar-thin bg-gray-800 border border-gray-700 rounded-lg shadow-xl"
          style={{ left: pickerPos.left, bottom: pickerPos.bottom, zIndex: 9999 }}
        >
          {agentFlatList.map((item) => (
            <button
              key={item.key}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 text-left"
              onClick={() => {
                selectAgent(item.id);
                setAgentPickerOpen(false);
              }}
            >
              {item.avatar ? (
                // 有头像：18px 圆形图片替代默认图标
                <img
                  src={item.avatar}
                  alt=""
                  className="rounded-full object-cover shrink-0"
                  style={{ width: 18, height: 18 }}
                />
              ) : (
                <Icon name={item.isTeam ? 'users' : 'agent'} size={16} />
              )}
              <span className="text-sm text-gray-200 flex-1 truncate">{item.label}</span>
              {currentAgentId === item.id ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
          <button
            className="w-full flex items-center justify-center gap-1 px-3 py-2.5 text-sm text-gray-300 hover:bg-gray-700 border-t border-gray-700"
            onClick={() => {
              setAgentPickerOpen(false);
              navigate('/agents');
            }}
          >
            <Icon name="plus" size={14} /> {wt('创建智能体')}
          </button>
        </div>,
        document.body,
      )
    : null;

  const toolbar = (
    <div className="sky-composer-toolbar flex gap-1 items-center mb-2">
      {/* 项目文件夹（工程模式）：显示当前项目，点击打开目录选择器 */}
      <ProjectChip />
      {/* @ 智能体切换器（单智能体 / 团队协作模式切换） */}
      <div className="relative">
        <button
          ref={agentButtonRef}
          className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300 hover:bg-gray-700 flex items-center gap-1"
          title={wt('选择智能体或团队（单智能体 / 多智能体协作）')}
          onClick={toggleAgentPicker}
        >
          <Icon name="agent" size={13} />
          {selectedAvatar ? (
            // 当前选中项有头像：18px 圆形图片
            <img
              src={selectedAvatar}
              alt=""
              className="rounded-full object-cover shrink-0"
              style={{ width: 18, height: 18 }}
            />
          ) : null}
          <span className="max-w-[120px] truncate">{selectedLabel}</span>
          <Icon name="chevron-right" size={12} />
        </button>
        {agentPicker}
      </div>
      {models.length === 0 ? (
        <button
          className="text-xs text-red-400 bg-red-900/30 px-2 py-0.5 rounded hover:bg-red-900/60 border border-red-700"
          onClick={() => navigate('/settings?tab=models')}
          title={wt('点击配置模型')}
        >
          {wt('未配置模型 - 点击配置')}
        </button>
      ) : (
        <>
          <select
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300 max-w-[200px]"
            value={selectedModelId || currentModel}
            onChange={(e) => void switchModel(e.target.value)}
            title={wt('切换模型')}
          >
            {chatModels.length > 0 ? (
              <optgroup label={t('chat.modelGroups.chat')}>
                {chatModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {wt(m.name)}{' '}
                    {m.providerName ? `(${wt(m.providerName)})` : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {imageModels.length > 0 ? (
              <optgroup label={t('chat.modelGroups.image')}>
                {imageModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {`${m.name} [${m.id === currentImageModel ? t('chat.modelBadge.imageDefault') : t('chat.modelBadge.image')}]`}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {videoModels.length > 0 ? (
              <optgroup label={t('chat.modelGroups.video')}>
                {videoModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {`${m.name} [${m.id === currentVideoModel ? t('chat.modelBadge.videoDefault') : t('chat.modelBadge.video')}]`}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <button
            className="text-xs text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded hover:bg-gray-700"
            onClick={() => navigate('/settings?tab=models')}
            title={wt('模型配置')}
          >
            <Icon name="config" size={14} />
          </button>
        </>
      )}
      <button
        className="btn-secondary text-sm py-1 px-2 flex items-center gap-1"
        title={t('chat.attach')}
        onClick={() => fileInputRef.current?.click()}
      >
        <Icon name="plus" size={14} />
        <span>{t('chat.attach')}</span>
      </button>
      <PermissionModePicker />
      <details className="sky-composer-more">
        <summary>
          {t('workbench.more')} <span aria-hidden="true">···</span>
        </summary>
        <div className="sky-composer-menu">
          <button
            className="btn-secondary text-sm py-1 px-2 flex items-center gap-1"
            title={t('chat.compact')}
            onClick={onCompact}
          >
            <Icon name="minimize" size={14} />
            <span>{t('chat.compact')}</span>
          </button>
          <button
            className="btn-secondary text-sm py-1 px-2 text-red-400 flex items-center gap-1"
            title={t('chat.clear')}
            onClick={() => void clearChat()}
          >
            <Icon name="x" size={14} />
            <span>{t('chat.clear')}</span>
          </button>
          <button
            className="btn-secondary text-sm py-1 px-2 flex items-center gap-1"
            title={t('chat.toolPanel')}
            onClick={onOpenToolPanel}
          >
            <Icon name="terminal" size={14} />
            <span>{t('chat.toolPanel')}</span>
          </button>
        </div>
      </details>
    </div>
  );

  // ── 附件预览（旧版 attPreviews：图片 64px 缩略 / 文件 chip）──
  const attPreviews =
    attachments.length > 0 ? (
      <div className="wing-composer-references">
        {attachments.map((att, i) =>
          isContextAttachment(att) ? (
            <BrowserAnnotationChip
              key={i}
              attachment={att}
              onRemove={() => setAttachments((items) => items.filter((_, index) => index !== i))}
            />
          ) : att.type === 'image' || (att.mimeType || '').startsWith('image/') ? (
            <div className="relative inline-block" key={i}>
              <img
                src={att.url || att.path}
                className="h-16 w-16 object-cover rounded border border-gray-600"
                alt={att.name}
              />
              <button
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full w-5 h-5 text-xs leading-5 text-center cursor-pointer"
              >
                ×
              </button>
            </div>
          ) : (
            <div
              key={i}
              className="relative inline-flex items-center gap-1 bg-gray-700 px-2 py-1 rounded text-xs border border-gray-600"
            >
              <span className="flex items-center gap-1">
                <Icon name="file" size={14} /> {att.name || att.mimeType || 'file'}
                {att.size ? ` ${formatFileSize(att.size)}` : ''}
              </span>
              <button
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-red-400 ml-1 cursor-pointer"
              >
                ×
              </button>
            </div>
          ),
        )}
      </div>
    ) : null;

  // 只读透视（子代理/系统会话）：不渲染输入区
  if (readonly) {
    return (
      <div className="border-t border-gray-700 p-4 bg-gray-800 w-full">
        <div className="text-xs bg-gray-900/60 border border-gray-700 rounded px-3 py-2.5 flex items-center gap-2 text-gray-400">
          <Icon name="workspace" size={13} />
          {wt('只读透视——该会话为子代理 / 系统会话，仅可查看消息，不可发送')}
        </div>
      </div>
    );
  }

  return (
    <div
      className="sky-composer border-t border-gray-700 p-4 bg-gray-800 w-full"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {approval ? (
        // 审批接管（composer takeover）：待决审批占据输入区，Enter/Esc 快捷决策
        <ApprovalTakeover />
      ) : (
        <>
          {toolbar}
          {picker && (
            <ComposerPicker
              key={picker.mode + ':' + approvalSessionId}
              mode={picker.mode}
              query={picker.query}
              anchor={textareaRef}
              agents={agents}
              onAttach={addReference}
              onClose={() => setPicker(null)}
              onComplete={finishPicker}
              onCommand={(command) => {
                finishPicker();
                if (command === 'compact') onCompact?.();
                else if (command === 'clear') void clearChat();
                else if (command === 'terminal' || command === 'browser' || command === 'changes') {
                  useProjectPanel.getState().setOpen(true);
                  useWorkspaceTabs.getState().openTab(command);
                }
              }}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex gap-2 items-end">
            <div className="flex-1 relative wing-composer-input">
              {attPreviews}
              <textarea
                ref={textareaRef}
                rows={2}
                className="input-field w-full resize-none"
                placeholder={shortcutText(
                  wt(
                    preferences.sendOnEnter
                      ? '{{v0}}（Enter 发送，Shift+Enter 换行）'
                      : '{{v0}}（Ctrl/⌘ Enter 发送）',
                    {
                      v0: t('chat.inputPlaceholder'),
                    },
                  ),
                )}
                value={value}
                disabled={disabled}
                onChange={(e) => {
                  setValue(e.target.value);
                  updateTrigger(e.target.value, e.target.selectionStart);
                }}
                onSelect={(e) => {
                  if (picker) updateTrigger(e.currentTarget.value, e.currentTarget.selectionStart);
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
            </div>
            {disabled ? (
              <button className="btn-primary px-6" onClick={onStop} disabled={stopping}>
                {stopping ? wt('正在停止…') : t('chat.stop')}
              </button>
            ) : (
              <button
                className="btn-primary px-6"
                onClick={handleSend}
                disabled={!value.trim() && attachments.length === 0}
              >
                {t('chat.send')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
