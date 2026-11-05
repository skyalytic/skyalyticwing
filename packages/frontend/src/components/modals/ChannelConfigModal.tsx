import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 渠道配置弹窗：当前保留渠道的专属配置表单。
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../Icon';
import { toast } from '../ui/Toast';
import { WeChatQrLogin } from '../channel/WeChatQrLogin';

export type ChannelValues = Record<string, any>;

export interface ChannelConfigModalProps {
  open: boolean;
  channelId: string;
  channelName?: string;
  channelEnabled?: boolean;
  savedConfig?: ChannelValues;
  configuredSecrets?: string[];
  onClose: () => void;
  onSave: (channelId: string, values: ChannelValues, enabled: boolean) => Promise<void> | void;
}

interface Field {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'checkbox';
  placeholder?: string;
  defaultValue?: string | number;
  full?: boolean;
  required?: boolean;
}

/** 各渠道专属字段定义（对齐旧版） */
const CHANNEL_FIELDS: Record<
  string,
  { title: string; color: string; fields: Field[]; note?: string }
> = {
email: { title: 'Email', color: 'text-gray-400', fields: [], get note(){return wt('该渠道尚未接入，暂不能启用或连接');} },
webchat: {
    title: 'Web Chat',
    color: 'text-purple-300',
    fields: [
      {
        key: 'webhookUrl',
        get label() {
          return wt('Webhook URL (可选)');
        },
        placeholder: 'https://your-domain.com/webhook',
      },
    ],
    get note() {
      return wt('Web Chat 为内置渠道，无需额外配置。');
    },
  },
sms: { title: 'SMS', color: 'text-gray-400', fields: [], get note(){return wt('该渠道尚未接入，暂不能启用或连接');} },
dingtalk: {
    get title() {
      return wt('钉钉机器人');
    },
    color: 'text-blue-500',
    fields: [
      { key: 'appKey', label: 'AppKey', placeholder: 'dingxxxxxxxxx' },
      {
        key: 'appSecret',
        get label() {
          return wt('AppSecret (应用密钥)');
        },
        type: 'password',
      },
    ],
    get note() {
      return wt(
        'Stream长连接模式，无需公网IP和端口配置。配置步骤: 1.钉钉开放平台创建应用 2.获取AppKey/Secret 3.添加机器人能力 4.填写上方信息后点连接',
      );
    },
  },
feishu: {
    get title() {
      return wt('飞书/Lark');
    },
    color: 'text-green-400',
    fields: [
      {
        key: 'appId',
        get label() {
          return wt('应用 ID');
        },
        placeholder: 'cli_xxxxxxxx',
      },
      {
        key: 'appSecret',
        get label() {
          return wt('应用密钥');
        },
        type: 'password',
      },
    ],
    get note() {
      return wt(
        'WebSocket长连接模式，无需公网IP和端口配置。配置步骤: 1.飞书开放平台创建企业自建应用 2.获取AppID/Secret 3.开启机器人能力 4.将应用发布到可用范围 5.填写上方信息后点连接',
      );
    },
  },
'wechat-work': {
    get title() {
      return wt('企业微信');
    },
    color: 'text-green-600',
    fields: [
      {
        key: 'botId',
        label: 'Bot ID',
        get placeholder() {
          return wt('扫码后自动填充');
        },
      },
      {
        key: 'secret',
        label: 'Secret',
        type: 'password',
        get placeholder() {
          return wt('扫码后自动填充');
        },
      },
    ],
    get note() {
      return wt(
        'WebSocket长连接模式，无需公网IP。点击「扫码接入」用企业微信扫码即可自动获取 Bot ID 和 Secret',
      );
    },
  },
weixin: {
    get title() {
      return wt('微信 iLink');
    },
    color: 'text-green-500',
    fields: [
      {
        key: 'botToken',
        get label() {
          return wt('机器人令牌');
        },
        type: 'password',
        placeholder: 'iLink Bot Token',
      },
      {
        key: 'baseUrl',
        get label() {
          return wt('服务地址 (可选)');
        },
        defaultValue: 'https://ilinkai.weixin.qq.com',
      },
    ],
    get note() {
      return wt(
        '提示: 推荐使用扫码登录。如扫码失败，可在终端执行: npx -y @tencent-weixin/openclaw-weixin-cli@latest install',
      );
    },
  }
};

const EMPTY_CONFIG: ChannelValues = {};
const EMPTY_SECRETS: string[] = [];

export function ChannelConfigModal({
  open,
  channelId,
  channelName,
  channelEnabled = true,
  savedConfig = EMPTY_CONFIG,
  configuredSecrets = EMPTY_SECRETS,
  onClose,
  onSave,
}: ChannelConfigModalProps) {
  useWorkbenchLanguage();
  const [enabled, setEnabled] = useState(channelEnabled);
  const [values, setValues] = useState<ChannelValues>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEnabled(channelEnabled);
      const init: ChannelValues = {};
      const def = CHANNEL_FIELDS[channelId];
      if (def) {
        def.fields.forEach((f) => {
          init[f.key] = savedConfig[f.key] ?? f.defaultValue ?? '';
        });
      }
      setValues(init);
    }
  }, [open, channelId, channelEnabled, savedConfig]);

  const def = CHANNEL_FIELDS[channelId];
  const isSimpleChannel = !def;

  const validate = (): string | null => {
    if (def) {
      for (const f of def.fields) {
        const v = values[f.key];
        if (enabled && f.type === 'password' && f.required !== false && !v && !configuredSecrets.includes(f.key)) {
          // 令牌类必填（webchat/wechat-work 等扫码渠道除外）
          if (channelId !== 'webchat' && channelId !== 'wechat-work') {
            return wt('请填写 {{v0}}', { v0: f.label });
          }
        }
      }
    }
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      toast.error(wt('表单校验失败'), err);
      return;
    }
    setSaving(true);
    try {
      const submitted = { ...values };
      for (const key of configuredSecrets) if (!submitted[key]) delete submitted[key];
      await onSave(channelId, submitted, enabled);
    } catch {
      // The page reports the save failure; keep the draft open for retry.
    } finally {
      setSaving(false);
    }
  };

  const setVal = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={
        <span className="flex items-center gap-2">
          <Icon name="channel" size={18} /> {wt('渠道配置 -')}
          {channelName || channelId}
        </span>
      }
      footer={
        <>
          <button className="btn-primary text-sm" onClick={save} disabled={saving}>
            {saving ? wt('保存中…') : wt('保存配置')}
          </button>
          <button className="btn-secondary text-sm" onClick={onClose}>
            {wt('取消')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">{wt('状态')}</label>
          <select
            className="input-field text-sm"
            value={enabled ? 'true' : 'false'}
            onChange={(e) => setEnabled(e.target.value === 'true')}
          >
            <option value="true">{wt('已启用')}</option>
            <option value="false">{wt('已禁用')}</option>
          </select>
        </div>

        {def ? (
          <div className="border-t border-gray-700 pt-3 mt-3">
            <h4 className={`text-sm font-semibold mb-2 flex items-center gap-1 ${def.color}`}>
              <Icon name="send" size={14} /> {def.title}
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {def.fields.map((f) => (
                <div key={f.key} className={f.full ? 'col-span-2' : ''}>
                  <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                  <input
                    type={f.type ?? 'text'}
                    className="input-field text-sm"
                    value={values[f.key] ?? ''}
                    checked={f.type==='checkbox'?values[f.key]===true:undefined}
                    placeholder={configuredSecrets.includes(f.key) ? wt('已保存，留空保留；填写可替换') : f.placeholder}
                    onChange={(e) =>
                      setVal(f.key, f.type === 'checkbox'?e.target.checked:f.type === 'number' ? Number(e.target.value) : e.target.value)
                    }
                  />
                </div>
              ))}
            </div>
            {def.note ? (
              <p className="text-xs text-gray-600 mt-2 bg-gray-900 p-2 rounded">{def.note}</p>
            ) : null}
            {channelId === 'weixin' || channelId === 'wechat-work' ? (
              <WeChatQrLogin
                variant={channelId === 'weixin' ? 'weixin' : 'wecom'}
                onFill={(vals) => {setValues((s) => ({ ...s, ...vals }));setEnabled(true);}}
              />
            ) : null}
          </div>
        ) : isSimpleChannel ? (
          <div className="border-t border-gray-700 pt-3 mt-3">
            <p className="text-gray-500 text-sm">{wt('该渠道使用默认设置，无需额外配置')}</p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default ChannelConfigModal;
