// Development-only fixture; the browser test connects this view to the real file history controller.
import {createRoot} from 'react-dom/client';
import {ChangesView} from '../src/components/workspace/ChangesView';
import {useProjectPanel} from '../src/stores/project-panel-store';
import '../src/i18n';
import '../src/styles/global.css';
import '../src/index.css';
import '../src/styles/workbench.css';
import '../src/styles/workspace.css';

document.documentElement.classList.add('light');
localStorage.setItem('app.language', 'zh-CN');
useProjectPanel.setState({projectDir: new URLSearchParams(location.search).get('dir') || '', treeVersion: 0});
window.addEventListener('fixture:tool-result', () => useProjectPanel.getState().bumpTreeVersion());
createRoot(document.getElementById('root')!).render(<div style={{height: '100vh'}}><ChangesView /></div>);
