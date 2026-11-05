import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';

/** 场景入口只填写草稿，用户补全任务并发送后才调用模型。 */
export function TaskWelcome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectDir = useProjectPanel((s) => s.projectDir);
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);
  const openTab = useWorkspaceTabs((s) => s.openTab);
  const projectName = projectDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const templates = [
    { key: 'office', icon: 'doc' },
    { key: 'channels', icon: 'channel' },
    { key: 'browser', icon: 'globe' },
    { key: 'design', icon: 'frame' },
  ];

  return (
    <section className="sky-task-welcome" aria-label={t('workbench.start')}>
      <div className="sky-task-home">
        <div className="sky-home-kicker"><span /> SKYALYTIC WING</div>
        <h1>{t('workbench.headline')}</h1>
        <p className="sky-home-description">{t('workbench.description')}</p>
        <div className="sky-project-entry">
          <div className="sky-project-symbol"><Icon name="folder" size={22} /></div>
          <div className="sky-project-copy">
            <strong>{projectName || t('workbench.projectTitle')}</strong>
            <span title={projectDir || undefined}>{projectDir || t('workbench.projectHint')}</span>
          </div>
          <button className="btn-secondary" onClick={() => setPickerOpen(true)}>
            {projectDir ? t('workbench.changeProject') : t('workbench.openProject')}
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
        <div className="sky-template-heading">{t('workbench.templateHeading')}</div>
        <div className="sky-task-templates">
          {templates.map(({ key, icon }) => (
            <button key={key} className="sky-task-template" onClick={() => {
              window.dispatchEvent(new CustomEvent('sky-insert-text', { detail: t(`workbench.${key}Prompt`) }));
            }}>
              <Icon name={icon} size={19} className="sky-template-icon" />
              <strong>{t(`workbench.${key}Title`)}</strong>
              <span className="sky-template-description">{t(`workbench.${key}Description`)}</span>
              <Icon name="chevron-right" size={14} className="sky-template-arrow" />
            </button>
          ))}
        </div>
        <div className="sky-home-links">
          <button onClick={() => openTab('browser')}><Icon name="globe" size={14} />{t('workbench.openBrowser')}</button>
          <button onClick={() => openTab('doc')}><Icon name="doc" size={14} />{t('workbench.openOffice')}</button>
          <button onClick={() => openTab('canvas')}><Icon name="frame" size={14} />{t('workbench.openCanvas')}</button>
          <button onClick={() => navigate('/channels')}><Icon name="channel" size={14} />{t('workbench.connectChannels')}</button>
          <button onClick={() => navigate('/settings?tab=models')}><Icon name="config" size={14} />{t('workbench.models')}</button>
          <span>{t('workbench.draftHint')}</span>
        </div>
      </div>
    </section>
  );
}
